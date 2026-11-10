# 设计方案 v2：统一提交通道

> 迁移自 `docs/agent-submission` 分支的 `2a6c940`，按本分支代码校正（Agent 提交接口自 `ec0ad86` 起落地）。
> 状态：PR1~6 已在本分支实现（统一队列、飞书改道、凭证签发、Agent 提交 API）。PR7 `feat/zd-cli`、PR8 `feat/zd-submit-skill` 在各自前置分支实现，尚未合入本分支。PR9 是本次文档整理。
> 为避免行号随提交漂移，引用给出文件加函数或常量名。历史草案保留在标注「历史方案」的小节里，不构成已发布契约；公开契约以 `shared/src/api.ts` 和 `shared/src/routes.ts` 为准。

## 1. 核心转变

v1 把 Agent 加在旧飞书全量导入旁，两条路径直接争用业务实体。v2 的设计目标是把变更先保存为快照，由审核决定何时物化，保留来源、审核状态和拒绝原因，避免同步直接把变更当成事实发布。

当前已经落地的范围：

```text
飞书表格 -> 管理批次入口 -> submissions -> 审核 -> entities / offers
管理入队（feishu / agent / web） -------> 同一审核与物化路径
Agent 提交 API（POST /api/agent/*） ---> 强制 pending，复用同一审核与物化路径

站内 POST /api/posts -> entities 中的 pending 文章 -> 原文章审核入口
运维 import、模型/厂商管理、种子初始化 -> 保留直接写库路径
```

因此，「唯一写入路径」是迁移目标，不能描述成当前所有 entities 都只由队列审核写入。普通站内文章仍直接写 pending 实体，运维 import 仍直接替换数据（`server/src/service.ts` 的 `createPost`、`server/src/catalog.ts` 的 `importCatalog`、`server/src/node-app.ts` 的种子初始化）。

## 2. 历史阻塞问题的处理状态

| v1 问题 | 当前处理 | 状态与边界 |
|---|---|---|
| 飞书全量同步覆盖同 slug 的 Agent 数据 | 同步改走队列；import 跳过已有来源不是 submission/demo 的输入站点 | PR4/5 已解决原先的直接同步覆盖路径；同 hostname 的已审核更新仍共享实体，保留最初 source |
| 无准入且队列容量容易被耗尽 | 注册满 7 天、已通过站内投稿、邀请码三选一；每账号最多 5 个凭证 | 凭证准入、提交速率和 pending 配额均已在 PR6 实现 |
| 模型库没有运行时扩展入口 | 管理员可新增/修改/删除模型和新增厂商；队列支持新增模型 | PR2/3 已完成；站点报价必须先引用已收录模型，pending 模型不能直接使用 |
| 可以把自报指标当实测数据 | 站点物化显式写四项指标为 null；Agent 入口在任意层级拒绝禁字段 | PR3 物化约束 + PR6 的 `rejectForbiddenFields` 已完成，两层同时生效 |
| 审核多次写入可能留下半成品 | 单条审核和物化共用 BEGIN IMMEDIATE 事务 | PR3 已完成；整批不是一个事务，前面成功条目保留 |

代码依据：`server/src/catalog.ts` 的 `importCatalog`、`scripts/sync-feishu.ts` 的批次提交、`server/src/agent-tokens.ts` 的 `requireEligibility`、`server/src/submissions.ts` 的 `materialize` 与 `reviewSubmission`、`server/src/agent-api.ts` 的 `rejectForbiddenFields`。

## 3. 数据模型

### 3.1 已建立的表

完整 SQL 以 `server/src/database.ts` 的 SCHEMA 为准，不再复制旧草案里尚未落地的列。

| 表 | 当前字段 | 设计作用 |
|---|---|---|
| submissions | id、kind、channel、originKey、batchId、action、autoApproved、payload、payloadHash、actorHandle、ip、status、reason、reviewedAt、createdAt | 保存原始 JSON 快照、来源、审核结果，区分同批次重试与新批次 |
| agent_tokens | id、handle、tokenHash、label、tokenPrefix、createdAt、lastUsedAt、revokedAt、useCount | 可展示的凭证元数据和不可还原的摘要，吊销保留历史 |

kind 为 station/model/post，channel 为 feishu/agent/web，action 为 upsert/remove。当前 submissions **没有**原草案中的 tokenId、reviewedBy；actorHandle 是入队元数据，不能等同于已验证的 Agent 身份。

幂等分两种入口，不能混用。管理队列：使用原始 `JSON.stringify(payload)` 的 SHA-256；查重键包含 kind、originKey、action、batchId、payloadHash 和状态，不按 actorHandle 或 channel 隔离，也不是键排序后的规范化 JSON；默认只对同批 pending 去重，自动通过还检查仍为最新版本的 approved；新批次可以再次入队相同内容（`server/src/submissions.ts` 的 `enqueueSubmission`）。公开 Agent 入口：接收扁平 payload，`batchId` 恒为 NULL，查重键额外加上 channel 和 actorHandle，因此同一账号的不同凭证提交相同 pending 内容也会命中原记录，审结过的内容再提交则新建 pending（`server/src/agent-api.ts` 的 `enqueue` 中 `pendingOnly` 与 `deduplicateByActor`）。

superseded 在新版本 **审核通过后**产生，不是新 pending 一到就替代旧 pending。同 kind/originKey 的其他 pending 会被替代，飞书 www 别名按实际目标处理；下架通过只替代相关待审 upsert，已不存在目标的幂等下架不推进新版本（`server/src/submissions.ts` 的 `supersedePending`）。

启动会自动建表，并幂等补 submissions 的 batchId/action/autoApproved、agent_tokens 的 tokenPrefix。新增表和这几项补列已完成，不需要把它们继续列作待实现迁移（`server/src/database.ts` 的 `ensureSubmissionColumns`、`ensureAgentTokenColumns`，调用点在 `server/src/node-app.ts`）。

### 3.2 渠道与展示来源

ContentSource 已扩展为 demo/submission/agent，Station 和 Post 另允许 user。channel=feishu 的新站点与评价使用 submission，agent 使用 agent，web 使用 user；站点更新保留首次来源，不把群友站点改标成 AI 采集，因此「来自 agent 渠道」只对新建内容成立（`shared/src/domain.ts` 的 `ContentSource`、`server/src/submissions.ts` 的 `sourceByChannel` 与 `materialize`）。

前端已用 sourceLabel 统一显示「群友提交，未经平台核实」和「AI 采集，未经平台核实」，覆盖站点卡片、文章卡片、模型报价和详情；这两种来源的评价正文按纯文本显示，用户站内投稿仍按 Markdown 渲染。原稿「5 处判断待更新」已过期，旧清单其实是五个文件中的六个判断点（`web/src/format.ts` 的 `sourceLabel`、`web/src/pages/PostDetail.tsx`）。

全站 SITE_NOTICE 仍只说明演示和群友提交，没有提到 Agent，属于当前界面文案缺口，不能宣称前端所有声明已经同步（`web/src/format.ts` 的 `SITE_NOTICE`、`web/src/components/Layout.tsx`）。

## 4. 提交 schema

本节区分三类内容：已上线的 Agent 入口契约、已实现的**管理队列**规则，以及原稿的**历史方案**。Agent 入口的运行时 schema 在本分支是 `server/src/submissions.ts` 的 `stationSchema`/`postSchema` 加 strict 与禁用字段检查；PR7 分支 `feat/zd-cli` 已把它提到 `shared/src/submission.ts` 供 CLI 复用，但该文件尚未合入本分支，引用它时必须说明来源分支。

### 4.1 站点

已上线的 Agent 入口接收**扁平** payload，六个字段全部必填（`shared/src/api.ts` 的 `CreateAgentStationRequest`）：

```json
{
  "name": "示例中转站",
  "url": "https://example.com/",
  "description": "根据公开信息整理，待审核核对。",
  "rechargeThreshold": 10,
  "paymentMethods": ["支付宝"],
  "offers": [{"modelSlug": "gpt-4-1", "rate": 0.6}]
}
```

name 最长 60 字且非空，description 最长 300 字且非空，`rechargeThreshold` 非负或 `null`（无数据也要显式给键），`paymentMethods` 最多 10 项、每项最长 20 字，`offers` 最多 100 项、同一 `modelSlug` 不能重复、倍率闭区间 0.05~20，`modelSlug` 必须已收录。URL 由 Agent 入口先清洗 query、fragment、用户名密码再校验长度与主机，因此与管理队列和 CLI 的「直接拒绝」不同。

**历史方案**（原稿，未采用为最终契约）：外层 `{kind: "station", station: {...}}` 且 description、paymentMethods、offers 记为可选。实际实现没有封装层，也不接受缺省字段，引用这段时只能当作演进记录。

**当前管理队列**使用 `{kind, channel, originKey, payload}` 外层，payload 直接是站点字段，规则与上表相同（`server/src/app.ts` 的 submissions 路由、`server/src/submissions.ts` 的 `stationSchema`）。

Agent 入口在任意嵌套层级拒绝以下字段，出现即 400 FORBIDDEN_FIELD（`server/src/agent-api.ts` 的 `forbidden` 与 `rejectForbiddenFields`）：

```text
uptime, firstTokenLatencyMs, foundedAt, status, score, lowestRate,
apiKey, api_key, token, password, secret,
authorHandle, accessToken, refreshToken, clientSecret, privateKey, authorization, credentials
```

设计理由：没有探测机制就不给自报实测指标的入口；可用率、延迟不能靠一段提交文字变成实测值。score 和 lowestRate 由服务端算，秘密不属于公开数据。缺失指标必须是 null，不能用 0、默认状态或缺失属性替代。

当前物化创建或更新站点时已经显式写 null，并保留旧来源：

```ts
{
  ...payload, slug,
  uptime: null, firstTokenLatencyMs: null, foundedAt: null, status: null,
  source: previous ? previous.source : sourceByChannel[submission.channel],
}
```

这是 `server/src/submissions.ts` 的 `materialize` 站点分支的行为，不是所有更新都改成 source=agent。站点字段和报价完整替换，空 offers 会清空旧报价。物化都会丢弃多余指标字段，但只有 Agent 入口在入队前就拒绝它们；管理队列是受管理员保护的入口，不能拿它代替 Agent 的拒绝规则。

### 4.2 模型

当前队列模型 payload：

```json
{
  "slug": "claude-sonnet-4-5-20250929",
  "vendor": "anthropic",
  "name": "Claude Sonnet 4.5",
  "description": "模型的一句话说明"
}
```

slug 使用管理员共用规则：小写字母或数字开头，其余小写字母、数字、连字符，最长 64；name 最长 60 字，description 最长 200 字，厂商必须已存在。审核新增时 tags=[]，模型重名返回 409 MODEL_EXISTS，**不是原稿的「重名就更新 name/description」**（`server/src/catalog.ts` 的 `adminSlug`、`server/src/submissions.ts` 的 `modelSchema` 与 `materialize`）。

改名或更换厂商使用 PATCH /api/admin/models/:slug，vendor/name/description 给全、slug 不变、tags 保留；引用中的模型不能删除，错误包含 stationCount 和 postCount。目前没有公布 `/api/agent/models` 契约，不把管理能力当成已经开放的 Agent 接口（`server/src/catalog.ts` 的 `updateModel`、`deleteModel`）。

### 4.3 评价

已上线的 Agent 评价入口同样是扁平 payload，作者身份由凭证决定：

```json
{
  "title": "示例站点的公开信息说明",
  "summary": "根据官网说明整理，价格和使用条件仍需审核。",
  "body": "请管理员核对公开说明；本文没有可用率或延迟数据。",
  "authorName": "整理者",
  "hostname": "example.com"
}
```

title/summary/body/authorName 必填且非空，上限分别为 100/200/5000/30 字；hostname、publishedAt 可省略或为 null，hostname 入库时去掉端口，publishedAt 须为 ISO datetime。`authorHandle` 被禁用字段规则拒绝。

**历史方案**（原稿 stationKey 形态，未采用）：外层 `{kind: "post", post: {stationKey, title, summary, body}}`，去掉作者署名与 hostname 字段。实际契约让 Agent 本人署名，并用 hostname 关联站点。

物化固定生成 kind=review、modelSlug=null 的 approved 文章，按 hostname 关联站点，匹配不到时 stationSlug=null，不会因为「站点不存在或不同批」自动拒绝；飞书批次沿用旧评价的文章 ID（`server/src/submissions.ts` 的评价物化分支）。

普通站内 POST /api/posts 是另一份已发布契约：kind/title/summary/body，stationSlug/modelSlug 可选；作者来自会话，正文上限 100000 字。不能把队列或 Agent 的长度与封装直接套用到它（`shared/src/api.ts` 的 `CreatePostRequest`、`server/src/app.ts` 的 `createPost` 路由、`server/src/service.ts` 的 `createPost`）。

## 5. 审核与物化

### 5.1 当前接口

```text
GET  /api/admin/submissions?status=pending&kind=station&page=1&pageSize=20
POST /api/admin/submissions/:id/review
POST /api/admin/submissions/batch-review
GET  /api/admin/submissions/state
GET  /api/admin/settings
POST /api/admin/settings
```

单条审核请求如 `{"status":"approved","reason":"已核对公开报价"}`；批次审核使用 `{"batchId":"<批次ID>","status":"approved"}`，或 `{"ids":["<投稿ID>"],"status":"rejected","reason":"请补全信息"}`。ids 最多 100 项，batchId 处理整批 pending；列表默认 pending，支持四种状态、kind、batchId、page/pageSize，pageSize 最多 50，**没有原稿的 limit 参数**（`server/src/submissions.ts` 的 `submissionQuerySchema`、`submissionReviewSchema`、`submissionBatchReviewSchema`，路由在 `server/src/app.ts` 的管理段）。用户已选定的批次审核入口 `batch-review` 与 `submissions/batch` 保持不变。

管理接口使用 SYNC_TOKEN，未配置或不足 32 字符时关闭；nginx 对公网 /api/admin/ 返回 404。完整接口清单在 [规范文档](spec.md#管理接口)，含保留的 import、模型/厂商管理和旧文章审核入口。

### 5.2 单条事务

```text
BEGIN IMMEDIATE
  读取 pending 投稿
  approved：校验 payload -> 写模型 / 站点及报价 / 评价 / 站点下架
  写审核状态、reason、reviewedAt
  新版本通过后替代相关旧 pending
COMMIT
失败则 ROLLBACK，原投稿仍为 pending
```

物化函数不另开事务。自动通过的入队、写实体、插入审核记录也在同一个事务中；批次入队与整批审核逐条提交，HTTP 200 的 results 可以包含逐条错误，不是全批回滚。公开 Agent 入口以 `pendingOnly` 调同一函数，自动通过对它无效，响应固定 `autoApproved: false`（`server/src/submissions.ts` 的 `enqueueSubmission`、`reviewSubmission`，`server/src/agent-api.ts` 的 `enqueue`，`server/src/app.ts` 的 batch-review 路由）。

用户已选定的保留项：批次入队与整批审核、以及**下架必须人工确认**，都不随自动通过开关改变。

### 5.3 飞书同步已改走队列

当前请求是 **POST /api/admin/submissions/batch**，没有原稿的 `/submissions/sync`。脚本只读飞书、过滤审核状态严格等于「通过」的记录，聚合站点和评价，按最多 500 项串行分块，每次同步生成一个新 UUID batchId（`scripts/sync-feishu.ts` 的同步主流程与批次提交）。

原稿「相同 approved 自动跳过」「新 pending 立即替代旧 pending」不符合当前实现：幂等限定同批次，新批次的相同内容仍可以入队，替代发生在新版本通过后。自动通过是持久化开关且只作用于队列 upsert；下架永远待人工确认（`server/src/submissions.ts` 的 `enqueueSubmission`、`supersedePending`）。

下架比较只覆盖有 approved 飞书 upsert、仍在线且来源为 submission 的站点，state 返回跨渠道当前 approved 版本。表格中消失的站点产生 remove，payload 带实际 slug/submissionId；人工审核再查来源与版本，过期返回 409 STALE_REMOVAL，非群友来源返回 409 STATION_SOURCE_CONFLICT。通过后只删除站点和报价，评价保留；老导入中没有队列版本的站点不参与下架检测（`server/src/submissions.ts` 的 `submissionState`、`removeStation`，`scripts/sync-feishu.ts` 的下架比较）。

设计理由仍成立：撤销通过从「同步静默删除站点」变为「产生申请，人工确认」，为管理员保留判断来源和版本的机会。当前没有文章 remove 动作；撤销飞书评价不会删除旧文章，旧文章审核入口的撤销提示过时（`server/src/moderation.ts` 的 `reviewPost`、`server/src/submissions.ts` 的评价物化分支）。

import 保留供运维使用，没有标记成仅一次性迁移的接口。它会替换 submission 来源集合，但跳过已有 agent/user 来源的同 slug 输入站点及其报价；它不推进队列审核版本，不能宣称所有直接导入都受队列版本保护（`server/src/catalog.ts` 的 `importCatalog`）。

## 6. 准入与反滥用

### 6.1 凭证准入已完成

| 条件，三选一 | 当前实现 |
|---|---|
| 注册满 7 天 | createdAt 到签发时至少经过 7 个 24 小时 |
| 至少一篇已通过的本人站内投稿 | source=user 或缺省为 user；不认 demo/feishu/agent 贡献 |
| 有效邀请码 | 从 INVITE_CODES 的逗号分隔配置读取，去首尾空白后精确匹配 |

不满足返回 403 ELIGIBILITY_REQUIRED，anonymous-submission 占位账号不能申请；每账号最多 5 个活跃凭证，超限 409 TOKEN_LIMIT。明文只签发时返回，丢失需吊销后再签发（`server/src/agent-tokens.ts` 的 `requireEligibility` 与签发函数）。

凭证签发当前按账号 10 次/小时、IP 30 次/小时、传入的同一邀请码 20 次/小时计数；进程内滑动窗口，IPv6 按 /64，重启清零。超限 429 RATE_LIMITED 带 Retry-After 秒数，ELIGIBILITY_REQUIRED/TOKEN_LIMIT 返还本次预占计数。列表和吊销不套这组限制（`server/src/app.ts` 的 `AGENT_TOKEN_*` 与 `INVITE_PER_CODE_LIMIT`、`server/src/auth.ts` 的 `AttemptLimiter`）。

设计理由：先限制谁能拿凭证，再限制提交量，降低即时批量注册对人工审核的压力。准入与签发管理已完成，提交配额也已在 PR6 一并启用。邀请码当前是可重复使用的配置秘密，没有单次核销流程。

### 6.2 Agent 提交速率与配额

| 维度 | v1 草案 | v2 设计值 | 已上线实现 | 理由 |
|---|---|---|---|---|
| 单 token | 10/小时 | 10/小时 | 10/小时 | 限制单个凭证的提交速度 |
| 单账号 | 20/小时 | 20/小时 | 20/小时 | 多凭证共享账号预算 |
| 单 IP | 30/小时 | 20/小时 | 20/小时 | 降低批量注册账号的合计提交速度 |
| 单账号 pending | 20 | 5 | 5 | 限制单个账号占用审核队列 |
| 单 hostname pending | 3 | 2 | 2（所有渠道合计） | 限制重复站点挤占队列 |
| 全局 pending 熔断 | 500 | 200 | 200 | 与人工处理能力匹配 |

实现在 `server/src/agent-api.ts` 顶部常量与 `reserve`、`beforeInsert`。速率超限返回 429 RATE_LIMITED，`retry-after` 头与 `error.retryAfter` 都给等待秒数；待审超限返回 409 TOO_MANY_PENDING，**没有 retryAfter**，只能等人工审核消化。被拒绝的请求会退还本次预占的速率计数，状态查询和 pending 幂等重试不扣额度。

### 6.3 内容校验的当前边界

| 项目 | 已上线的 Agent 入口 | 管理队列 |
|---|---|---|
| rate | 0.05~20，与导入、队列共用 `offerRate` | 同左 |
| URL | http/https；先清洗 query/fragment/账号密码，再校验长度与主机；拒绝内网、回环、本地域名和 `.example` 保留后缀 | 直接拒绝带 query/fragment/账号密码的 URL，不代为清洗；没有私网黑名单 |
| 字段长度 | 站点 name 60、description 300、评价 body 5000；六字段与评价必填项全部必填，不接受缺省 | 同 schema 长度，但管理 payload 允许部分项为 null |
| 多余字段 | strict schema 拒绝，整条 400 INVALID_INPUT | 只取已知字段，原始 payload 照存 |
| 禁字段 | 任意层级命中即 400 FORBIDDEN_FIELD | 无此规则，受管理员保护 |
| 幂等 | 同账号 + 同 kind + 同规范化 payload 且 pending 才去重 | 同批 kind/originKey/action/payloadHash/状态 |
| 未知模型 | 入队前拒绝，需先由管理员收录 | 报价同样拒绝；管理员可先新增模型 |

实现：`server/src/agent-api.ts` 的 `agentStationSchema`、`agentPostSchema`、`agentUrl`、`privateHostname`、`forbidden`；`server/src/submissions.ts` 的 `stationSchema`、`postSchema`、`parseStationPayload`；`server/src/catalog.ts` 的 `httpUrl`、`offerRate`。服务不抓取提交站点 URL，因此不把私网黑名单缺失描述成已证实的服务端 SSRF；URL 路径和正文中的秘密也不会因为字段名校验就自动消失。

飞书报价行匹配不到模型、格式错误或越界仍只提示并跳过，不进入记录级 skipped；记录级错误才触发默认退出码 2。`--allow-skipped` 始终禁止本次下架，dry-run 无 token 时不能检查线上空表风险（`scripts/sync-feishu.ts` 的报价解析与安全检查）。

### 6.4 榜单防刷已完成

PR1 已将倍率区间收紧为 0.05~20，并引入 3 个报价的资格门槛。模型榜当前使用：

```ts
const score = (item: typeof items[number]) => item.stationCount
  + (item.rateEligible && item.lowestRate !== null ? 1 / item.lowestRate : 0);
```

rateEligible 需要该模型至少 3 个站点报价；达标模型优先，再按得分排列。不足 3 个报价只计站点数，**响应仍返回真实 lowestRate，不按旧草案改成 null**。站点倍率排序也先排总报价数至少 3 个的站点（`server/src/service.ts` 的 `getRankings` 与 rate 排序分支）。

历史「0.0001 会给无实测站点算出 30000 分」是错误论断：uptime=null 时 score 直接为 null。原来的问题在低价排序和模型榜低价加成，不能继续把已收紧的倍率和旧单报价规则写成当前漏洞（`server/src/service.ts` 的 `station`）。这些规则约束排序，不证明报价本身真实，人工审核仍需核对公开条件。

## 7. CLI zdd

PR7 的实际分支名为 `feat/zd-cli`；本次只读核对提交 `6c7aba4`。它提供 `scripts/zdd.ts` 与 `shared/src/submission.ts`，但这两条路径尚未合入本分支。对应分支根目录可用 `node --experimental-strip-types scripts/zdd.ts help` 查看命令；本分支没有 `zdd` 或 `scripts/zdd` 启动器。

| 命令 | 已实现用途 |
|---|---|
| zdd login --key ... | 验证凭证后保存到 ~/.config/zdd/config.json（0600）；环境变量 ZDD_TOKEN 可代替落盘配置 |
| zdd whoami | 调 GET /api/agent/status 返回身份与配额，不额外返回准入条件 |
| zdd catalog | 自动翻页读取厂商、模型和站点目录 |
| zdd match "模型名" | 匹配现有模型名，未知模型提示先由管理员收录 |
| zdd validate ./x.json | 不联网的本地字段校验，不能证明服务器已收录模型，也不替代服务器地址检查 |
| zdd submit ./x.json | 提交站点或评价；--batch ./dir/ 逐文件提交，非服务器批次事务 |
| zdd status --limit 20 | 查询最近审核状态与 reason |

stdout 为 JSON，stderr 为提示；退出码 0 成功、1 用法错误、2 网络/服务端故障、3 本地校验失败、4 服务端拒绝、5 凭证问题。`ZDD_API_BASE` 可指定本站地址。CLI 的共享 URL schema 拒绝 query/fragment/账号密码，而本树 Agent API 会先清洗，不能宣称两者接受的原始输入完全相同。运行时凭证不能写进提交 JSON、源码或日志。

## 8. Skill

PR8 的实际分支名为 `feat/zd-submit-skill`；本次只读核对提交 `9ab0337`。它提供 `.claude/skills/zdd-submit/SKILL.md` 及配套 README，这些路径需在前置 PR7/8 合入后才能在本分支使用。流程保留为：

1. 检查凭证身份与提交配额。
2. catalog -> match -> 构造公开信息 -> validate -> submit。
3. 不提交实测指标或凭证，不编造倍率，先检查已有站点。
4. status 获取拒绝原因后修正；429 等指定秒数，409 待审积压等人工审核。

Skill 中的命令别名与启动器仍需在 PR7/8 合入时核对：已核对的 PR7 入口是 `scripts/zdd.ts`，不能把 `./scripts/zdd` 当成本分支已安装命令。

## 9. PR 清单与实际状态

| # | 分支或历史计划名 | 实际内容 | 本次核对状态 |
|---|---|---|---|
| 1 | 历史计划名 fix/offer-rate-bounds | 倍率 0.05~20、模型榜和站点排序的 3 报价门槛 | 本分支已包含 acdcb47；计划名不表示当前存在同名分支 |
| 2 | feat/model-catalog-writable | 管理员模型新增/改名/删除、厂商新增、import 可选创建占位模型 | 本分支已包含 8ab47ad |
| 3 | feat/submissions-queue | 投稿表、统一审核物化、Agent 来源标签、自动通过和边界修复 | 本分支已包含 9a6f4e5 起至 4291bdd |
| 4 | feat/feishu-to-queue | 飞书批次入队、人工下架、跨渠道版本保护和坏数据中止 | 本分支已包含 663cf44、005174f、a0913e1 |
| 5 | feat/agent-tokens | 凭证准入与管理、签发限流、补列迁移、阻止冒用 Agent 文章取得准入 | 本分支已包含 ceffd69、89014e3 |
| 6 | feat/agent-submit-api | /api/agent/*、Bearer、提交配额与重试契约 | 本分支已包含，代码核对基线 ec0ad86 |
| 7 | feat/zd-cli | CLI 与共享校验 | 独立前置分支已实现，核对 6c7aba4；尚未合入本分支 |
| 8 | feat/zd-submit-skill | Agent 提交 Skill | 独立前置分支已实现，核对 9ab0337；尚未合入本分支 |
| 9 | docs/agent-submission-pr9 | README、规范、方案及审阅记录 | 本次文档整理分支；审查对象已提交至 036b05c，后续修订不代表已合并或部署 |

表格区分本分支已包含的代码与独立分支中的前置产物，不把「已实现」等同于已合并或已部署。历史方案来自 `docs/agent-submission` 分支；PR9 的实际工作分支名不作更改。

## 10. 已解决事项与当前边界

| 事项 | 校正后的状态 |
|---|---|
| 新表和后加列迁移 | 建表及 batchId/action/autoApproved/tokenPrefix 补列已完成；没有通用迁移工具 |
| 旧飞书数据切换 | 旧站点保留，旧评价 ID 可以沿用；未批量回填 approved submissions，没有队列版本的存量站点不参加下架检测 |
| 审核界面 | 当前仍是管理员 curl/API，没有后台页面；整批操作和逐条结果已可用 |
| offers 的数据库 CHECK | 当前新旧库都仍是 rate > 0，0.05~20 在应用层生效；没有历史倍率回填，不是「数据库范围约束已迁移」 |
| 邀请码 | 配置、精确匹配和签发限制已实现；没有生成/单次核销接口，运营负责分发 |
| 禁用、吊销与历史投稿 | 禁用清会话、吊销写 revokedAt，不清除队列；Agent 鉴权同时校验禁用状态，因此禁用后凭证立即失效。没有 tokenId 关联，Agent 只能用 status 看本人记录 |
| 飞书文章撤销 | 站点下架已实现且保留评价；没有文章 remove，旧 MANAGED_BY_SOURCE 提示过时 |
| 来源保护 | import 同 slug 的独立 agent/user 站点保护已实现；跨渠道更新同 hostname 保留最初 source，不能宣称贡献按来源隔离 |
| 全站来源声明 | 内容标签和纯文本处理已完成；SITE_NOTICE 仍缺 Agent 说明 |
| Agent 入口的自动通过与标签 | 入口强制 pending，管理员的自动通过开关不影响它；新建内容标 agent 来源，更新已有站点保留原来源 |

依据：`server/src/database.ts` 的 SCHEMA 与补列函数、`server/src/submissions.ts` 的 `submissionState` 与 `materialize`、`server/src/moderation.ts` 的 `reviewPost` 与 `setAccountDisabled`、`server/src/agent-tokens.ts` 的 `revokeAgentToken`、`server/src/agent-auth.ts`、`web/src/format.ts`。本 PR 只校正文档，不改变这些代码边界。
