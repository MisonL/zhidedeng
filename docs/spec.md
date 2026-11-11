# 什么值得蹬规格

定位：AI API 中转站的导购与点评社区，用值/不值投票、排行榜和信息流帮人选站。
Slogan：我们的AI中转指南。

本文按本分支代码核对（Agent 提交接口自 `ec0ad86` 起落地）。为避免行号随提交漂移，引用一律给出文件加函数或常量名。公开契约以 [`shared/src/api.ts`](../shared/src/api.ts) 和 [`shared/src/routes.ts`](../shared/src/routes.ts) 为准。CLI 与 Skill 位于前置分支 `feat/zd-cli`、`feat/zd-submit-skill`，尚未合入本分支。设计过程见 [方案 v2](plan-agent-submission-v2.md)，历史结论的修复状态见 [交叉审阅记录](review-summary.md)。

## 技术栈与布局

- pnpm workspace，Node 22，TypeScript 严格模式
- `shared/`：`@zhidedeng/shared`，领域类型、API 类型、路由表、倍率常量与站点 slug 派生规则，作为前后端契约
- `server/`：Hono + `node:sqlite`，端口 8787，测试用 vitest；启动时自动建表，空库自动灌种子；生产环境同时托管前端
- `web/`：Vite + React 19 + react-router，端口 5173，`/api` 代理到 8787；测试用 vitest + testing-library

## 数据诚信（硬约束）

- 种子里的中转站都是虚构样例，名称、倍率、可用率、延迟、评论、评测均为演示数据，严禁在种子里使用真实中转站名称
- 飞书表单只采集审核状态严格等于「通过」的记录，再走平台投稿审核；物化后标明「群友提交，未经平台核实」。agent 渠道新建内容标明「AI 采集，未经平台核实」。这两种来源的评价正文按纯文本显示，用户站内投稿仍按 Markdown 渲染（`web/src/format.ts` 的 `sourceLabel`、`web/src/pages/PostDetail.tsx`）
- 没有实测数据的可用率、延迟等指标一律为 null，页面显示「暂无」，不当 0 分也不编造。队列创建或更新站点时，`uptime`、`firstTokenLatencyMs`、`foundedAt`、`status` 都显式写 null；综合得分在 uptime 为 null 时同为 null，按得分或可用率排序时缺失值在后（`server/src/submissions.ts` 的 `materialize`、`server/src/service.ts` 的 `station` 与排序分支）
- Agent 入口在任意嵌套层级拒绝 `uptime`、`firstTokenLatencyMs`、`foundedAt`、`status`、`score`、`lowestRate` 和凭证类字段，返回 `400 FORBIDDEN_FIELD`，字段名忽略大小写、下划线和连字符。没有探测机制就不接受自报实测指标；score 和 lowestRate 由服务端算，凭证只用于鉴权（`server/src/agent-api.ts` 的 `forbidden` 与 `rejectForbiddenFields`）
- 已有站点更新保留最初 source，不能把飞书站点改标成 Agent。队列下架只允许 `source=submission`，demo、agent、user 来源返回 `409 STATION_SOURCE_CONFLICT`；版本不符返回 `409 STALE_REMOVAL`，站点和报价不变（`server/src/submissions.ts` 的 `removeStation` 与站点物化分支）
- 全站页脚常驻声明，当前 `SITE_NOTICE` 文案仍只说明演示数据和群友提交；站点详情及内容标签已覆盖 agent。页脚缺少 Agent 来源说明是当前界面缺口（`web/src/format.ts` 的 `SITE_NOTICE`、`web/src/components/Layout.tsx`、`web/src/pages/Stations.tsx`）
- 价格只用「相对官方价的倍率」（如 0.6x），不写任何官方绝对价格。新写入倍率校验为闭区间 `0.05~20`；数据库 CHECK 仍为 `rate > 0`，历史异常数据不会自动修正（`shared/src/domain.ts` 的 `MIN_RATE`/`MAX_RATE`、`server/src/catalog.ts` 的 `offerRate`、`server/src/database.ts` 的 offers 表）
- 模型榜至少有 3 个站点报价才启用最低倍率加成，且达标模型优先；不足 3 个仍返回 lowestRate 供展示。站点按倍率排序也先排列总报价数至少 3 个的站点，详情仍展示现有报价（`server/src/service.ts` 的 `getRankings` 与 rate 排序分支）
- 厂商名和模型名可用真实名称，只作分类用途

## 领域模型

- Vendor：slug、名称、图标 key。种子提供初始厂商，管理员可运行时新增，不是固定清单（`server/src/catalog.ts` 的 `createVendor`）
- Model：slug、vendor、名称、一句话简介、标签
- Station：slug、名称、简介、网址、来源、充值门槛、支付方式、可用率、首 token 延迟 ms、成立时间、状态（running / unstable），后六项无数据时为 null 或空
- StationOffer：station × model × 倍率
- Post：kind（deal 爆料 / review 评测 / community 社区 / guide 指南）、标题、摘要、正文 markdown、作者、可关联 station 与 model、封面、发布时间、来源、审核状态（pending / approved / rejected）
- Vote：user × post 或 station，值 / 不值，每人每对象一票，可改可撤
- Favorite、Comment（支持一层回复，可被隐藏）、CheckIn（每日一次，发放 Token 积分，连续天数）
- User：handle、昵称、头像、简介、token 积分；Account：用户名和密码哈希，种子用户没有账号，不能登录
- Submission：kind 为 station/model/post，channel 为 feishu/agent/web，action 为 upsert/remove，含 originKey、batchId、payload、actorHandle、status、reason、createdAt、reviewedAt；内部另存 payloadHash、ip、autoApproved。当前没有 tokenId 或 reviewedBy（`shared/src/api.ts` 的 `SubmissionRecord`、`server/src/database.ts` 的 SCHEMA）
- AgentToken：id、label、tokenPrefix、createdAt、lastUsedAt、revokedAt、useCount、status。明文只在签发响应中出现，列表只返回本人元数据；`lastUsedAt` 和 `useCount` 由每次 Bearer 鉴权更新（`shared/src/api.ts` 的 `AgentToken`、`server/src/agent-auth.ts` 的 `agentHandle`）

## 账号与权限

- 用户名 + 密码注册，不要邮箱和手机号。用户名 3~20 位字母数字下划线，大小写不敏感唯一；昵称可中文；密码至少 8 位，scrypt 加随机盐。暂不支持找回密码；可在账户设置改密码，成功后其他会话失效
- 会话是随机 token，HttpOnly、SameSite=Lax、生产环境 Secure，30 天；库里只存 SHA-256；可登出
- 登录和注册进程内限流（IP + 用户名、用户名、IP 三层，失败次数在校验密码前预占），错误文案不区分用户名不存在、密码错和账号被禁用；拒绝常见弱密码；写接口要求 Content-Type: application/json
- 未登录只读，写接口和个人接口返回 401 UNAUTHENTICATED。新用户初始 120 Token
- AI Agent 凭证由本人使用会话 Cookie 管理。注册满 7 天、已有至少一篇审核通过的本人站内投稿、持有有效邀请码三选一；贡献准入只认 source=user 或未写 source 的文章，演示、飞书和 Agent 文章不计入，anonymous-submission 占位账号被拒绝。邀请码从环境变量 INVITE_CODES 读取，逗号分隔、去首尾空白、精确匹配，可重复使用（`server/src/agent-tokens.ts` 的 `requireEligibility`、`server/src/node-app.ts` 的邀请码解析）
- 每账号最多 5 个未吊销凭证。明文为 zd_ 加 32 字节随机数的 base64url 编码，只签发时返回；库中只存 SHA-256 和前八字符展示前缀。签发和吊销记录不含秘密的事件日志，管理响应带 Cache-Control: no-store；重复吊销保留首次 revokedAt（`server/src/agent-tokens.ts` 的签发与 `revokeAgentToken`、`server/src/app.ts` 的凭证路由）
- 签发按账号 10 次/小时、IP 30 次/小时、请求中同一邀请码 20 次/小时限制；IPv6 按 /64 计。进程内滑动窗口，重启清零，超限 429 RATE_LIMITED 并返回 Retry-After 秒数；ELIGIBILITY_REQUIRED 和 TOKEN_LIMIT 会返还本次预占计数。列表和吊销没有这组签发限流（`server/src/app.ts` 的 `AGENT_TOKEN_*` 与 `INVITE_PER_CODE_LIMIT`、`server/src/auth.ts` 的 `AttemptLimiter`）
- 禁用账号会删除会话并阻止登录，已有公开内容保留；不会更新 agent_tokens.revokedAt，但 Agent 鉴权查询同时校验 accounts.disabledAt，禁用后已签发凭证立即失效。每次成功鉴权更新 lastUsedAt 并递增 useCount，提交与状态查询都计入（`server/src/moderation.ts` 的 `setAccountDisabled`、`server/src/agent-auth.ts` 的 `activeAgentHandle` 与 `agentHandle`）
- Agent 提交另有独立配额：单凭证 10 条/小时、单账号 20 条/小时、单 IP 20 条/小时、单账号待审 5 条、单 hostname 待审 2 条（所有渠道合计）、全站待审 200 条。速率超限 429 RATE_LIMITED 带等待秒数，待审超限 409 TOO_MANY_PENDING 不带 retryAfter。公开 Agent 入口强制 pendingOnly，即使开启自动通过也不物化，响应固定 autoApproved: false（`server/src/agent-api.ts` 顶部常量与 `reserve`、`enqueue`）
- 投票数和收藏数对所有人公开累计；评论登录后发布即公开，每账号每分钟 5 条
- 投稿每账号每小时 10 篇、待审最多 20 篇。提交后是 pending，只有作者能在我的分享和详情页看到，通过后才公开。种子文章公开；飞书内容先进入投稿队列，默认待人工审核

## 投稿渠道与审核

channel 是队列的来源渠道，source 是物化内容的展示来源，二者不能互换。当前入口如下：

| 渠道 | 当前入口和状态 | 物化来源 |
|---|---|---|
| feishu | 同步脚本调用 POST /api/admin/submissions/batch，进入队列 | 新站点和评价为 submission |
| agent | 公开 POST /api/agent/stations、POST /api/agent/posts 已上线，强制 pending；管理队列也接受 channel=agent | 新站点和评价为 agent |
| web | 管理队列支持 channel=web；公开 POST /api/posts 仍直接写入待审文章 entities，没有迁移到 submissions 表 | 新站点或队列评价为 user；普通文章缺省 source 按 user 读取 |

依据：`server/src/app.ts` 的公开路由 `route()` 表与 Agent 路由段、`server/src/submissions.ts` 的 `sourceByChannel` 与 `materialize`、`server/src/service.ts` 的 `post`。管理员模型/厂商接口、运维 import 和种子初始化也保留直接写库路径，不能把队列称为当前所有 entities 的唯一写入路径。

队列状态流转：

```text
入队 pending -> 审核 approved -> 在同一个事务中写实体、报价和审核状态
             -> 审核 rejected -> 保留 payload 和 reason，不物化
新版本 approved -> 同 kind/originKey 的其他 pending 标为 superseded
```

- 只审核 pending，已审核或被替代条目返回 409 ALREADY_REVIEWED。reason 可选、最长 1000 字；物化失败整条回滚，原投稿仍为 pending（`server/src/submissions.ts` 的 `reviewSubmission`、`server/src/node-app.ts` 的事务辅助）
- 默认自动通过关闭；管理员可持久化开启，队列 upsert 在入队事务中立即物化，下架始终 pending。自动通过只影响管理队列，公开 Agent 入口传 pendingOnly，永远等待人工审核（`server/src/submissions.ts` 的 `enqueueSubmission` 中 `auto` 的判定）。批次入队和整批审核都是逐条事务，部分成功保留，HTTP 200 的 results 中可能含逐条错误（`server/src/app.ts` 的 batch 与 batch-review 路由）
- 站点身份来自 URL hostname，服务端不信任客户端 originKey；只有飞书批次沿用 www 与裸域归组规则。slug 共用 shared/src/slug.ts，已有同站点沿用 slug，清洗撞车时加哈希后缀（`server/src/submissions.ts` 的 `submissionOriginKey` 与 `stationSlug`）
- 站点更新是完整替换信息和报价，空 offers 会清空旧报价，不是「只合并非空字段」。模型报价必须引用已收录模型；同批 pending 模型不能供站点引用。模型投稿只新增，重名 409 MODEL_EXISTS，改名和更换厂商走管理员 PATCH，tags 保留（`server/src/submissions.ts` 的 `materialize`、`server/src/catalog.ts` 的 `updateModel`）
- 幂等分两种入口，不能混用。管理队列按 kind、规范化 originKey、action、batchId、payloadHash 和状态查重，不按 actorHandle 隔离；默认只对同批 pending 去重，自动通过时也检查仍为最新版本的 approved；新批次相同内容可以重新入队，新 pending 不会替代旧 pending。公开 Agent 入口不接受 batchId，查重键加上 channel 和 actorHandle，因此同一账号不同凭证提交相同 pending 内容也会命中原记录；审结过的内容再提交会产生新 pending（`server/src/submissions.ts` 的 `enqueueSubmission` 查重语句、`server/src/agent-api.ts` 的 `deduplicateByActor`）
- 批次入口逐条校验业务 payload；单条管理入口在关闭自动通过时主要校验外层、站点 URL 和下架版本，完整业务校验在审核阶段完成。Agent 提交入口则在入队前就以 `stationSchema`/`postSchema` 的 strict 版本校验完整 payload，不接受多余字段（`server/src/submissions.ts` 的 `validatePayload`、`server/src/agent-api.ts` 的 schema 常量）

普通站内文章仍由 `/api/admin/posts/:id/review` 调整 pending/approved/rejected，只有作者能读未公开文章。已物化的飞书文章走此接口仍返回 409 MANAGED_BY_SOURCE；当前没有队列文章删除动作，撤销飞书评价也不会移除已上线文章，错误提示里的「撤销后重新同步」已经不能表达新流程（`server/src/moderation.ts` 的 `reviewPost`、`server/src/submissions.ts` 的评价物化分支）。

## 页面

### `/admin` 审核台

待审投稿、待审文章、已下架站点三个页签，支持逐条通过/拒绝、全部通过、一键恢复。
用**管理密钥**进入（`Authorization: Bearer`），不是登录会话——管理接口本来就不在公开契约里。

密钥只写 `sessionStorage`：关掉标签页即失效，不像 `localStorage` 会在公共机器上长期留存。
服务端返回 401/403 时清空并退回输入态，避免无效密钥留在会话里反复触发失败请求。

没有这个页面时，审核只能靠 curl；站点以自动运行为主，但下架与争议内容仍需人工介入，
所以需要一个不需要开终端的最低成本入口。

- `/` 首页：见下方首屏
- `/models`、`/models/:slug`：模型库，详情展示各中转站倍率比价
- `/community`：社区信息流，可按厂商和热度、时间筛选
- `/reviews`：评测列表
- `/posts/:id`：文章详情，含值/不值、收藏、评论
- `/stations`、`/stations/:slug`：中转站库与详情（指标、模型倍率表、值/不值、收藏、评论、相关文章）
- `/rank`：完整排行榜，含模型、社区、达人三个 tab
- `/search?q=`：跨模型、中转站、文章搜索，分组展示
- `/submit`：投稿，需登录，提交后待审核
- `/me`：我的收藏、我的分享（标注审核状态）、账户设置（昵称、简介可改），需登录
- `/login`、`/register`：登录注册，成功后回跳原页面
- `/admin`：审核台，见下
- `/docs`：本站公开只读 API 文档，不含管理接口
- `/business`：商务合作说明页，不编造联系方式，写明「联系方式待配置」

## 首屏布局

1. 顶栏：红色圆形印章 Logo「蹬」+ 站名「什么值得蹬」+ slogan；居中大搜索框；下方热门搜索
2. 导航：左侧 首页 / 模型 / 社区 / 评测，右侧 API文档 / 商务合作 / 投稿分享 / 登录 | 注册（已登录显示昵称菜单）
3. 三栏：左为厂商列表（悬停展开该厂商模型浮层）；中为 Banner 轮播；右为用户卡（未登录显示引导和登录按钮，已登录显示 Token、签到、我已经分享）
4. 排行榜：标题 + 模型/社区/达人 tab + 查看更多
5. 其下为「值得蹬」信息流：卡片含值/不值投票与比例条、评论数、收藏、站点和模型标签，可筛选和加载更多

## 视觉规格

- 页面底暖白，内容区定宽 1200 居中，模块白底，圆角 8~12，柔和阴影
- 主红 `#E62828`；正文 `#333`，次级 `#666`，弱化 `#999`
- 字体自托管 Noto Serif SC（站名和标题）、Noto Sans SC（正文）、JetBrains Mono（数字）
- 适配 400px 手机宽度

## 管理接口

用 `Authorization: Bearer $SYNC_TOKEN` 校验，未配置或不足 32 字符时关闭；普通会话和 Agent 凭证不能代替。部署在 127.0.0.1，由 nginx 对公网 /api/admin/ 返回 404。写接口要求 Content-Type: application/json，普通请求体上限 512 KiB，import 和 submissions/batch 为 8 MiB。管理接口不进 API_ROUTES 或公开 /docs（`server/src/app.ts` 的管理路由段与 body limit 常量、`server/src/node-app.ts` 的 `SYNC_TOKEN` 处理、`deploy/nginx-site.conf.template`）。

| 方法 | 路径 | 当前用途 |
|---|---|---|
| POST | /api/admin/import | 运维全量导入，直接替换 submission 来源集合；输入同 slug 的 agent/user 站点会跳过 |
| POST | /api/admin/models | 新增模型，厂商必须已存在，重名 409 MODEL_EXISTS |
| PATCH | /api/admin/models/:slug | slug 不变，vendor/name/description 要给全，tags 保留 |
| DELETE | /api/admin/models/:slug | 请求 confirm=true；站点报价或文章引用时 409 MODEL_IN_USE，含 stationCount/postCount |
| POST | /api/admin/vendors | 新增厂商，iconKey 缺省等于 slug，重名 409 VENDOR_EXISTS |
| POST | /api/admin/submissions | 单条入队，支持 feishu/agent/web、station/model/post；只有 station 支持 remove |
| POST | /api/admin/submissions/batch | 每请求最多 500 项；可指定 batchId，否则生成 UUID，逐条结果见 results |
| GET | /api/admin/submissions | 默认 pending；按 status/kind/batchId 筛选，用 page/pageSize 分页，pageSize 最多 50，没有 limit 参数 |
| GET | /api/admin/submissions/state | 飞书下架比较用的在线群友站点和当前 submissionId |
| POST | /api/admin/submissions/:id/review | pending -> approved/rejected，reason 可选 |
| POST | /api/admin/submissions/batch-review | ids 最多 100 项，或 batchId 审核整批 pending；逐条事务 |
| GET | /api/admin/settings | 读取 autoApprove |
| POST | /api/admin/settings | 设置 autoApprove，持久化到 settings 表 |
| GET | /api/admin/posts | 必填 status=pending/approved/rejected，列出对应文章 |
| POST | /api/admin/posts/:id/review | 调整非 submission 来源文章状态；群友来源仍 409 MANAGED_BY_SOURCE |
| POST | /api/admin/comments/:id/hide | hidden=true/false，隐藏父评论时回复也不公开 |
| POST | /api/admin/users/:handle/disable | disabled=true/false，按用户名查账号；禁用时删除会话，公开内容保留 |

路由依据：`server/src/app.ts` 的管理路由段；模型和导入语义见 `server/src/catalog.ts` 的 `importCatalog`、`updateModel`、`createVendor`、`deleteModel`。`/api/admin/import` 仍是正式保留的运维能力，没有被改成队列接口或限制为一次性迁移；它不推进 submissions 审核版本，不能作为队列 freshness 检查覆盖的写入路径。独立 agent/user 来源站点及其报价受同 slug 跳过保护，原本就是 submission 来源的站点仍属于替换集合。

另有 `GET /api/health`，无鉴权、执行 SELECT 1 后返回 `{"status":"ok"}`，不进 API_ROUTES（`server/src/app.ts` 的 health 路由）。

## 飞书同步

- `scripts/sync-feishu.ts` 用 lark-cli 串行只读拉取表格，仅处理审核状态严格等于「通过」的记录；先按 hostname 聚合站点，评价按记录 ID 各自入队。每块最多 500 项，同一次同步共用一个新 UUID batchId 和 feishu 渠道，调用 `/api/admin/submissions/batch`，不再调用 import（`scripts/sync-feishu.ts` 的同步主流程与批次提交）
- 同 batchId 不能混入其他渠道，返回 409 BATCH_CHANNEL_MISMATCH；人工审完的批次不能继续追加，返回 409 BATCH_ALREADY_REVIEWED。只含自动通过条目的批次允许后续分块；批次内冲突站点在写入前整批拒绝（`server/src/submissions.ts` 的 `assertBatchChannel`、`assertBatchOpen`、`enqueueBatch`）
- state 仅列出存在 approved 飞书 upsert 的 hostname 组内、仍在线且 source=submission 的站点；submissionId 取跨渠道最新 approved upsert。旧导入站点没有对应 approved 飞书队列记录时不参与下架检测（`server/src/submissions.ts` 的 `submissionState`）
- 表格中消失或撤销通过的站点生成 action=remove，payload 带实际 slug 和 state 返回的 submissionId。下架始终等待人工审核，审核时重查来源和版本；通过后只删除站点与报价，已有评价及互动记录保留，已不存在目标按幂等下架处理（`scripts/sync-feishu.ts` 的下架比较、`server/src/submissions.ts` 的 `removeStation` 与 `materialize`）
- 记录级解析失败时同步和 dry-run 以退出码 2 中止且不 POST。显式 --allow-skipped 可跳过坏记录，但本次完全不生成下架，并打印警告；有效站点为零且已读取的线上 state 非空时仍中止（`scripts/sync-feishu.ts` 的安全检查与退出码分支）
- dry-run 不发 POST；缺少 SYNC_TOKEN 时只预览 upsert 和评价、跳过下架检测，也不能判断线上空表风险。配置 token 后读取完整 state。分块或逐条失败以非零退出码结束，前面成功的条目保留（`scripts/sync-feishu.ts` 的主流程）
- URL 清洗去 query、fragment、用户名密码；管理队列校验拒绝这些内容而不代为清洗。公开 Agent 接口则会先清洗再校验，不因 query/fragment 直接拒绝。这三条路径都没有私网地址的额外抓取校验以外的用途，也没有抓取用户提交的 URL（`scripts/sync-feishu.ts` 的 URL 清洗、`server/src/catalog.ts` 的 `httpUrl`、`server/src/agent-api.ts` 的 `agentUrl` 与 `privateHostname`）
- 未匹配模型或无效倍率行仍跳过并打印提示，不计入记录级 skipped，可能形成缺少报价的有效站点；不能把安全中止规则表述为「任一报价错误都中止」。报价须先匹配现有模型名或 slug（`scripts/sync-feishu.ts` 的报价解析与提示分支）

## Agent 提交接口

`POST /api/agent/stations`、`POST /api/agent/posts`、`GET /api/agent/status` 已注册在 `shared/src/routes.ts` 的 `API_ROUTES`，并在 `server/src/app.ts` 挂载。请求体是扁平 JSON，站点与评价各用 strict schema，任意层级的禁字段优先返回 400 FORBIDDEN_FIELD，其余校验失败返回 400 INVALID_INPUT；凭证缺失、吊销或账号禁用一律 401 UNAUTHENTICATED。提交强制待审，幂等与配额规则见上文「投稿渠道与审核」和「账号与权限」。完整字段、示例和配额表见 README 的「用 AI Agent 提交数据」。CLI 与 Skill 属于前置分支 `feat/zd-cli`、`feat/zd-submit-skill`，本分支不含它们的实现。

## API（全部 JSON，前缀 /api）

公开分页列表统一 `{ items, total, page, pageSize }`，参数 page、pageSize；凭证列表直接返回数组。错误为 `{ error: { code, message } }`，部分管理错误还有额外详情，例如 MODEL_IN_USE 的 stationCount/postCount。

- `POST /auth/register`（username、password、nickname?）、`POST /auth/login`、`POST /auth/logout`、`POST /auth/password`（currentPassword、newPassword）
- `POST /account/agent-tokens`（label、inviteCode?）签发；`GET /account/agent-tokens` 列出本人凭证元数据；`DELETE /account/agent-tokens/:id` 软吊销，重复吊销保留首次 revokedAt。均需会话，不需要管理员权限；准入不足返回 403 ELIGIBILITY_REQUIRED，活跃凭证超限返回 409 TOKEN_LIMIT
- `GET /me`、`PATCH /me`（nickname、bio）
- `POST /me/checkin`（当天重复调用返回 409 ALREADY_CHECKED_IN）；`GET /me` 含 tokens、checkedInToday、streak、favoriteCount、shareCount
- `GET /me/favorites`、`GET /me/posts`
- `GET /vendors`（含 models 摘要）
- `GET /models?vendor=&q=`、`GET /models/:slug`（含 offers：各站倍率，按倍率升序）
- `GET /stations?vendor=&sort=score|rate|uptime&q=`、`GET /stations/:slug`（含 offers、指标、投票汇总、当前用户投票与收藏状态）
- `GET /posts?kind=&vendor=&station=&model=&sort=latest|hot&q=`、`GET /posts/:id`、`POST /posts`（kind、title、summary、body、stationSlug?、modelSlug?）
- `PUT /votes`（targetType: post|station、targetId、value: up|down|null）返回最新汇总
- `PUT /favorites`（targetType、targetId、favorited）
- `GET /comments?targetType=&targetId=`、`POST /comments`（content 1~2000 字、parentId?）
- `GET /rankings?tab=model|community|expert`（各返回 6~12 条）
- `GET /banners`
- `GET /search?q=`（models、stations、posts 三组，各最多 10 条）
- `GET /hot-searches`
- `POST /agent/stations`、`POST /agent/posts`、`GET /agent/status?limit=1..50` —— Agent 提交通道，`Authorization: Bearer zd_...` 鉴权。请求体是扁平 JSON 对象，不接受多余字段；实测指标字段（uptime、firstTokenLatencyMs、foundedAt、status、score、lowestRate）和凭证类字段一律 400 FORBIDDEN_FIELD，`authorHandle` 同样拒绝。提交强制进入待审队列，即使管理员开启自动通过也不例外；同一账号相同 pending 内容重提返回 deduplicated。速率配额：单凭证 10 条/小时、单账号 20 条/小时、单 IP 20 条/小时，超限 429 RATE_LIMITED 并带等待秒数；待审配额：单账号 5 条、单 hostname 2 条、全站 200 条，超限 409 TOO_MANY_PENDING 且不带 retryAfter。凭证无效、被吊销或账号被禁用返回 401 UNAUTHENTICATED
