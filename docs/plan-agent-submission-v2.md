# 设计方案 v2：统一提交通道

> 迁移自 `docs/agent-submission` 分支的 `2a6c940`，按当前 PR5 基线 `89014e3` 校正。
> PR1~8 已实现：统一队列、飞书改道、凭证签发、Agent 提交 API、zd 命令行、zd-submit Skill。PR9 是本次文档整理。
> 「当前实现」后面的文件行号对应本基线；草案不构成已发布契约。公开契约以 `shared/src/api.ts` 和 `shared/src/routes.ts` 为准。

## 1. 核心转变

v1 把 Agent 加在旧飞书全量导入旁，两条路径直接争用业务实体。v2 的设计目标是把变更先保存为快照，由审核决定何时物化，保留来源、审核状态和拒绝原因，避免同步直接把变更当成事实发布。

当前已经落地的范围：

```text
飞书表格 -> 管理批次入口 -> submissions -> 审核 -> entities / offers
管理入队（feishu / agent / web） -------> 同一审核与物化路径
Agent 提交 API（PR6） -----------------> 复用同一审核与物化路径

站内 POST /api/posts -> entities 中的 pending 文章 -> 原文章审核入口
运维 import、模型/厂商管理、种子初始化 -> 保留直接写库路径
```

因此，「唯一写入路径」是迁移目标，不能描述成当前所有 entities 都只由队列审核写入。普通站内文章仍直接写 pending 实体，运维 import 仍直接替换数据（当前实现：`server/src/service.ts:231-242`、`server/src/catalog.ts:64-110,138-166`、`server/src/node-app.ts:56`）。

## 2. 历史阻塞问题的处理状态

| v1 问题 | 当前处理 | 状态与边界 |
|---|---|---|
| 飞书全量同步覆盖同 slug 的 Agent 数据 | 同步改走队列；import 跳过已有来源不是 submission/demo 的输入站点 | PR4/5 已解决原先的直接同步覆盖路径；同 hostname 的已审核更新仍共享实体，保留最初 source |
| 无准入且队列容量容易被耗尽 | 注册满 7 天、已通过站内投稿、邀请码三选一；每账号最多 5 个凭证 | 凭证准入、提交速率和 pending 配额均已在 PR6 实现 |
| 模型库没有运行时扩展入口 | 管理员可新增/修改/删除模型和新增厂商；队列支持新增模型 | PR2/3 已完成；站点报价必须先引用已收录模型，pending 模型不能直接使用 |
| 可以把自报指标当实测数据 | 站点物化显式写四项指标为 null | 物化约束已完成；Agent 的 FORBIDDEN_FIELD 拒绝规则待 PR6 |
| 审核多次写入可能留下半成品 | 单条审核和物化共用 BEGIN IMMEDIATE 事务 | PR3 已完成；整批不是一个事务，前面成功条目保留 |

代码依据：`server/src/catalog.ts:66-73`、`scripts/sync-feishu.ts:432-436`、`server/src/agent-tokens.ts:15-39`、`server/src/submissions.ts:407-426,473-497`、`server/src/node-app.ts:36-46`。

## 3. 数据模型

### 3.1 已建立的表

完整 SQL 以 `server/src/database.ts:55-91` 为准，不再复制旧草案里尚未落地的列。

| 表 | 当前字段 | 设计作用 |
|---|---|---|
| submissions | id、kind、channel、originKey、batchId、action、autoApproved、payload、payloadHash、actorHandle、ip、status、reason、reviewedAt、createdAt | 保存原始 JSON 快照、来源、审核结果，区分同批次重试与新批次 |
| agent_tokens | id、handle、tokenHash、label、tokenPrefix、createdAt、lastUsedAt、revokedAt、useCount | 可展示的凭证元数据和不可还原的摘要，吊销保留历史 |

kind 为 station/model/post，channel 为 feishu/agent/web，action 为 upsert/remove。当前 submissions **没有**原草案中的 tokenId、reviewedBy；actorHandle 是入队元数据，不能等同于已验证的 Agent 身份。

幂等使用原始 `JSON.stringify(payload)` 的 SHA-256；查重键包含 kind、originKey、action、batchId、payloadHash 和状态，当前不按 actorHandle 或 channel 单独隔离，也不是键排序后的规范化 JSON。默认只对同批 pending 去重，自动通过还检查仍为最新版本的 approved；新批次可以再次入队相同内容（当前实现：`server/src/submissions.ts:153-192`）。

superseded 在新版本 **审核通过后**产生，不是新 pending 一到就替代旧 pending。同 kind/originKey 的其他 pending 会被替代，飞书 www 别名按实际目标处理；下架通过只替代相关待审 upsert，已不存在目标的幂等下架不推进新版本（当前实现：`server/src/submissions.ts:449-469,495-496`）。

启动会自动建表，并幂等补 submissions 的 batchId/action/autoApproved、agent_tokens 的 tokenPrefix。新增表和这几项补列已完成，不需要把它们继续列作待实现迁移（当前实现：`server/src/database.ts:144-158`、`server/src/node-app.ts:24-28`）。

### 3.2 渠道与展示来源

ContentSource 已扩展为 demo/submission/agent，Station 和 Post 另允许 user。channel=feishu 的新站点与评价使用 submission，agent 使用 agent，web 使用 user；站点更新保留首次来源，不把群友站点改标成 AI 采集（当前实现：`shared/src/domain.ts:11-12,105,144`、`server/src/submissions.ts:14,419-444`）。

前端已用 sourceLabel 统一显示「群友提交，未经平台核实」和「AI 采集，未经平台核实」，覆盖站点卡片、文章卡片、模型报价和详情；两种来源的评价正文按纯文本显示。原稿「5 处判断待更新」已过期，旧清单其实是五个文件中的六个判断点（当前实现：`web/src/format.ts:8-15`、`web/src/pages/PostDetail.tsx:44-46`）。

全站 SITE_NOTICE 仍只说明演示和群友提交，没有提到 Agent，属于当前界面文案缺口，不能宣称前端所有声明已经同步（当前实现：`web/src/format.ts:10`、`web/src/components/Layout.tsx:166`）。

## 4. 提交 schema

本节保留 Agent 设计草案，并同时列出已实现的管理队列规则。当前 schema 在 `server/src/submissions.ts`，尚无原稿所说的 `shared/src/submission.ts`；普通站内表单也没有共用队列 schema。

### 4.1 站点

Agent 草案，尚未进入共享 API 契约：

```json
{
  "kind": "station",
  "station": {
    "name": "示例中转站",
    "url": "https://example.com/",
    "description": "根据公开信息整理，待审核核对。",
    "rechargeThreshold": 10,
    "paymentMethods": ["支付宝"],
    "offers": [{"modelSlug":"gpt-4-1","rate":0.6}]
  }
}
```

草案要求 name 最长 60 字、URL 必填，description 可选且最长 300 字、rechargeThreshold 可选且非负、paymentMethods 可选且最多 10 项、offers 可选且最多 100 项。`POST /api/agent/stations` 的最终封装和缺省值由 PR6 契约确定。

**当前管理队列**使用 `{kind, channel, originKey, payload}` 外层，payload 直接是站点字段，name、description、url、rechargeThreshold、paymentMethods、offers 都要给全；缺失充值门槛显式为 null，数组可为空。支付方式每项最长 20 字，报价模型不能重复且必须已收录，倍率闭区间 0.05~20（当前实现：`server/src/app.ts:157-172`、`server/src/submissions.ts:54-61,331-335`）。

Agent 设计不接受以下字段，出现即 400 FORBIDDEN_FIELD，拒绝规则待 PR6：

```text
uptime, firstTokenLatencyMs, foundedAt, status, score, lowestRate,
apiKey, api_key, token, password, secret
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

这是当前 `server/src/submissions.ts:419-423` 的行为，不是所有更新都改成 source=agent。站点字段和报价完整替换，空 offers 会清空旧报价。当前管理 payload 使用 z.object，原始快照仍持久化，物化时不采用多余指标字段；这不能替代 Agent 入口的严格拒绝规则（当前实现：`server/src/submissions.ts:54-61,153-161,203-205,424-426`）。

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

slug 使用管理员共用规则：小写字母或数字开头，其余小写字母、数字、连字符，最长 64；name 最长 60 字，description 最长 200 字，厂商必须已存在。审核新增时 tags=[]，模型重名返回 409 MODEL_EXISTS，**不是原稿的「重名就更新 name/description」**（当前实现：`server/src/catalog.ts:134-136`、`server/src/submissions.ts:52,407-412`）。

改名或更换厂商使用 PATCH /api/admin/models/:slug，vendor/name/description 给全、slug 不变、tags 保留；引用中的模型不能删除，错误包含 stationCount 和 postCount。目前没有公布 `/api/agent/models` 契约，不把管理能力当成已经开放的 Agent 接口（当前实现：`server/src/catalog.ts:158-183`）。

### 4.3 评价

Agent 草案保留原方案的 stationKey 形态，作者归属和关联规则随 PR6 确定：

```json
{
  "kind": "post",
  "post": {
    "stationKey": "example.com",
    "title": "示例站点的公开信息说明",
    "summary": "根据官网说明整理，价格和使用条件仍需审核。",
    "body": "请管理员核对公开说明；本文没有可用率或延迟数据。"
  }
}
```

当前管理队列 payload 则是 title/summary/body/authorName，前三项上限分别为 100/200/5000 字，authorName 最长 30 字；hostname、authorHandle、publishedAt 可选或为 null。物化固定生成 kind=review、modelSlug=null 的 approved 文章，按 hostname 关联站点，匹配不到时 stationSlug=null，不会因为「站点不存在或不同批」自动拒绝（当前实现：`server/src/submissions.ts:62-65,428-444`）。

普通站内 POST /api/posts 是另一份已发布契约：kind/title/summary/body，stationSlug/modelSlug 可选；作者来自会话，正文上限 100000 字。不能把队列或 Agent 草案的长度与封装直接套用到它（当前实现：`shared/src/api.ts:159-167`、`server/src/app.ts:386`、`server/src/service.ts:231-242`）。

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

单条审核请求如 `{"status":"approved","reason":"已核对公开报价"}`；批次审核使用 `{"batchId":"<批次ID>","status":"approved"}`，或 `{"ids":["<投稿ID>"],"status":"rejected","reason":"请补全信息"}`。ids 最多 100 项，batchId 处理整批 pending；列表默认 pending，支持四种状态、kind、batchId、page/pageSize，pageSize 最多 50，**没有原稿的 limit 参数**（当前实现：`server/src/submissions.ts:17-30`、`server/src/app.ts:180-209`）。

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

物化函数不另开事务。自动通过的入队、写实体、插入审核记录也在同一个事务中；批次入队与整批审核逐条提交，HTTP 200 的 results 可以包含逐条错误，不是全批回滚（当前实现：`server/src/submissions.ts:163-207,242-255,473-497`、`server/src/app.ts:188-209`）。

### 5.3 飞书同步已改走队列

当前请求是 **POST /api/admin/submissions/batch**，没有原稿的 `/submissions/sync`。脚本只读飞书、过滤审核状态严格等于「通过」的记录，聚合站点和评价，按最多 500 项串行分块，每次同步生成一个新 UUID batchId（当前实现：`scripts/sync-feishu.ts:227-294,427-440`）。

原稿「相同 approved 自动跳过」「新 pending 立即替代旧 pending」不符合当前实现：幂等限定同批次，新批次的相同内容仍可以入队，替代发生在新版本通过后。自动通过是持久化开关且作用于队列 upsert；下架永远待人工确认（当前实现：`server/src/submissions.ts:119-207,449-469`）。

下架比较只覆盖有 approved 飞书 upsert、仍在线且来源为 submission 的站点，state 返回跨渠道当前 approved 版本。表格中消失的站点产生 remove，payload 带实际 slug/submissionId；人工审核再查来源与版本，过期返回 409 STALE_REMOVAL，非群友来源返回 409 STATION_SOURCE_CONFLICT。通过后只删除站点和报价，评价保留；老导入中没有队列版本的站点不参与下架检测（当前实现：`server/src/submissions.ts:350-394`、`scripts/sync-feishu.ts:298-304`）。

设计理由仍成立：撤销通过从「同步静默删除站点」变为「产生申请，人工确认」，为管理员保留判断来源和版本的机会。当前没有文章 remove 动作；撤销飞书评价不会删除旧文章，旧文章审核入口的撤销提示过时（当前实现：`server/src/moderation.ts:20`、`server/src/submissions.ts:428-444`）。

import 保留供运维使用，没有标记成仅一次性迁移的接口。它会替换 submission 来源集合，但跳过已有 agent/user 来源的同 slug 输入站点及其报价；它不推进队列审核版本，不能宣称所有直接导入都受队列版本保护（当前实现：`server/src/catalog.ts:64-110`）。

## 6. 准入与反滥用

### 6.1 凭证准入已完成

| 条件，三选一 | 当前实现 |
|---|---|
| 注册满 7 天 | createdAt 到签发时至少经过 7 个 24 小时 |
| 至少一篇已通过的本人站内投稿 | source=user 或缺省为 user；不认 demo/feishu/agent 贡献 |
| 有效邀请码 | 从 INVITE_CODES 的逗号分隔配置读取，去首尾空白后精确匹配 |

不满足返回 403 ELIGIBILITY_REQUIRED，anonymous-submission 占位账号不能申请；每账号最多 5 个活跃凭证，超限 409 TOKEN_LIMIT。明文只签发时返回，丢失需吊销后再签发（当前实现：`server/src/agent-tokens.ts:15-49`）。

凭证签发当前按账号 10 次/小时、IP 30 次/小时、传入的同一邀请码 20 次/小时计数；进程内滑动窗口，IPv6 按 /64，重启清零。超限 429 RATE_LIMITED 带 Retry-After 秒数，ELIGIBILITY_REQUIRED/TOKEN_LIMIT 返还本次预占计数。列表和吊销不套这组限制（当前实现：`server/src/app.ts:32-37,62-91,236-240,327-365`）。

设计理由：先限制谁能拿凭证，再限制提交量，降低即时批量注册对人工审核的压力。已经做完的是准入与签发管理，不能由此推断提交配额也已启用。邀请码当前是可重复使用的配置秘密，没有单次核销流程。

### 6.2 Agent 提交速率与配额

| 维度 | v1 草案 | v2 设计值 | 理由 |
|---|---|---|---|
| 单 token | 10/小时 | 10/小时 | 限制单个凭证的提交速度 |
| 单账号 | 20/小时 | 20/小时 | 多凭证共享账号预算 |
| 单 IP | 30/小时 | 20/小时 | 降低批量注册账号的合计提交速度 |
| 单账号 pending | 20 | 5 | 限制单个账号占用审核队列 |
| 单 hostname pending | 3 | 2 | 限制重复站点挤占队列 |
| 全局 pending 熔断 | 500 | 200 | 与人工处理能力匹配 |

这些是保留的设计值，当前管理队列没有这些 Agent 配额检查。PR6 需在共享契约中明确计数对象、拒绝错误、重试和状态反馈，不能把本表当成已部署限流。

### 6.3 内容校验的当前边界

| 项目 | 当前实现 | Agent 草案尚待实现部分 |
|---|---|---|
| rate | 0.05~20，导入、队列和飞书解析共用常量 | 由 PR6 接入同一规则 |
| URL | http/https；飞书去 query/fragment/账号密码，管理队列拒绝这些内容 | 私网、localhost、.internal/.local 黑名单尚未实现 |
| 字段长度 | 队列站点 name 60、description 300、评价 body 5000 | 可选字段缺省与严格禁止字段规则由 PR6 确定 |
| 幂等 | 同批 kind/originKey/action/payloadHash/状态查重 | 原案「同 actor + 同 hash」不是当前实现，Agent 重试契约待 PR6 |
| 未知模型 | 队列报价拒绝；管理员可先新增模型 | 没有已发布的 Agent 模型提交接口 |

当前实现：`server/src/catalog.ts:16-27`、`server/src/submissions.ts:54-65,153-192,331-346`、`scripts/sync-feishu.ts:112-167`。当前服务不抓取提交站点 URL，因此不把黑名单缺失描述成已证实的服务端 SSRF；URL 路径和正文中的秘密也不会因为字段名校验就自动消失。

飞书报价行匹配不到模型、格式错误或越界仍只提示并跳过，不进入记录级 skipped；记录级错误才触发默认退出码 2。`--allow-skipped` 始终禁止本次下架，dry-run 无 token 时不能检查线上空表风险（当前实现：`scripts/sync-feishu.ts:141-167,402-425,465-469`）。

### 6.4 榜单防刷已完成

PR1 已将倍率区间收紧为 0.05~20，并引入 3 个报价的资格门槛。模型榜当前使用：

```ts
const score = (item: typeof items[number]) => item.stationCount
  + (item.rateEligible && item.lowestRate !== null ? 1 / item.lowestRate : 0);
```

rateEligible 需要该模型至少 3 个站点报价；达标模型优先，再按得分排列。不足 3 个报价只计站点数，**响应仍返回真实 lowestRate，不按旧草案改成 null**。站点倍率排序也先排总报价数至少 3 个的站点（当前实现：`server/src/service.ts:188-195,292-307`）。

历史「0.0001 会给无实测站点算出 30000 分」是错误论断：uptime=null 时 score 直接为 null。原来的问题在低价排序和模型榜低价加成，不能继续把已收紧的倍率和旧单报价规则写成当前漏洞（当前实现：`server/src/service.ts:71-76`）。这些规则约束排序，不证明报价本身真实，人工审核仍需核对公开条件。

## 7. CLI zd

以下保留原案的功能目标，当前没有 zd 命令实现：

| 命令草案 | 目的 |
|---|---|
| zd login | 接入本人 Agent 凭证，安全输入和保存方式由 PR7 确定 |
| zd whoami | 身份、准入和配额；当前没有对应已发布接口 |
| zd catalog | 读取厂商、模型和站点目录 |
| zd match | 匹配现有模型名，未知模型提示先由管理员收录 |
| zd validate ./x.json | 本地字段校验，不能证明当前服务器模型是否存在 |
| zd submit ./x.json | 提交数据，最终种类和批量参数随 PR6/7 确认 |
| zd status | 查询审核状态与可对外反馈的 reason，契约待 PR6 |

原案的设计理由是用确定性 CLI 帮 Agent 匹配目录、预检、提交和自我修正。计划输出 JSON；CLI 与服务器复用同一份校验规则，避免双写。当前 schema 位于服务端，原稿提到的 shared/src/submission.ts 还不存在，共享校验和配置存储都属于 PR7 工作。运行时凭证从环境变量或密钥管理读取，不能写进提交 JSON、源码或日志。

## 8. Skill

原案计划 `.claude/skills/zd-submit/SKILL.md`，尚未实施；最终位置由 PR8 确定。保留的工作流：

1. 检查身份与提交资格。
2. catalog -> match -> 构造公开信息 -> validate -> submit。
3. 不提交实测指标或凭证，不编造倍率，先检查已有站点。
4. status 获取拒绝原因后修正，按错误码决定重试。

此处记录方案意图，不把尚未完成的 CLI 或 Skill 当成已可使用的产品。

## 9. PR 清单与实际状态

| # | 计划编号/分支 | 实际内容 | 当前状态 |
|---|---|---|---|
| 1 | fix/offer-rate-bounds | 倍率 0.05~20、模型榜和站点排序的 3 报价门槛 | 已包含，acdcb47 |
| 2 | feat/model-catalog-writable | 管理员模型新增/改名/删除、厂商新增、import 可选创建占位模型 | 已包含，8ab47ad |
| 3 | feat/submissions-queue | 投稿表、统一审核物化、Agent 来源标签、自动通过和边界修复 | 已包含，9a6f4e5 起至 4291bdd |
| 4 | feat/feishu-to-queue | 飞书批次入队、人工下架、跨渠道版本保护和坏数据中止 | 已包含，663cf44、005174f、a0913e1 |
| 5 | feat/agent-tokens | 凭证准入与管理、签发限流、补列迁移、阻止冒用 Agent 文章取得准入 | 已包含，ceffd69、89014e3 |
| 6 | feat/agent-submit-api | /api/agent/*、Bearer、提交配额与重试契约 | 已实现 |
| 7 | feat/zd-cli | CLI 与共享校验 | 已实现 |
| 8 | feat/zd-submit-skill | Agent 提交 Skill | 已实现 |
| 9 | docs/agent-submission | README、规范、方案及审阅记录；实际工作分支 docs/agent-submission-pr9 | 本 PR 文档整理，待审阅，未提交 |

PR1~5 状态依据本分支 `git log main..89014e3`；PR6~9 的任务状态来自本次派发，不代表远端已经合并或部署。原估算行数已由实际拆分替代，不用估算当验收结论。

## 10. 已解决事项与当前边界

| 事项 | 校正后的状态 |
|---|---|
| 新表和后加列迁移 | 建表及 batchId/action/autoApproved/tokenPrefix 补列已完成；没有通用迁移工具 |
| 旧飞书数据切换 | 旧站点保留，旧评价 ID 可以沿用；未批量回填 approved submissions，没有队列版本的存量站点不参加下架检测 |
| 审核界面 | 当前仍是管理员 curl/API，没有后台页面；整批操作和逐条结果已可用 |
| offers 的数据库 CHECK | 当前新旧库都仍是 rate > 0，0.05~20 在应用层生效；没有历史倍率回填，不是「数据库范围约束已迁移」 |
| 邀请码 | 配置、精确匹配和签发限制已实现；没有生成/单次核销接口，运营负责分发 |
| 禁用、吊销与历史投稿 | 当前禁用清会话、吊销写 revokedAt，不清除队列；没有 tokenId 关联或 Agent 私有历史接口，PR6 需确定 Bearer 校验和反馈边界 |
| 飞书文章撤销 | 站点下架已实现且保留评价；没有文章 remove，旧 MANAGED_BY_SOURCE 提示过时 |
| 来源保护 | import 同 slug 的独立 agent/user 站点保护已实现；跨渠道更新同 hostname 保留最初 source，不能宣称贡献按来源隔离 |
| 全站来源声明 | 内容标签和纯文本处理已完成；SITE_NOTICE 仍缺 Agent 说明 |

依据：`server/src/database.ts:25-27,71-91,144-158`、`server/src/submissions.ts:365-394,419-444`、`server/src/moderation.ts:20,26-33`、`server/src/agent-tokens.ts:63-72`、`web/src/format.ts:10`。本 PR 校正文档，不改变这些代码边界。
