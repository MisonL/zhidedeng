# 交叉审阅记录：Agent 提交通道方案

历史审阅对象为 v1 方案，原记录来自 `docs/agent-submission` 分支 `2a6c940`，由 Codex 和 Claude 两个 Agent 分别从代码事实、攻击面和产品约束进行只读审阅。本次迁移按 PR5 基线 `89014e3` 校正问题状态，没有重跑历史攻击场景或查询线上模型清单。

原记录说明：Codex 完整报告未落盘，摘要来自完成回执、可见终端片段和记录编写者的独立核验。本文件保留论证来源，把历史分析与当前实现分开；原记录中的线上数量和攻击推算不作为当前实测证据。后续方案见 [设计方案 v2](plan-agent-submission-v2.md)。

## 一、倍率与得分的事实纠错

原方案称倍率 0.0001 会使导入站点「得分虚高 30000」，该结论错误，历史记录已经自我纠正。当前 `server/src/service.ts:75` 的 score 在 uptime=null 时直接返回 null，导入和队列物化都把该指标写 null；无实测站点不会因这条公式算出 30000 分。

| 历史影响面 | 当前实现 | 状态 |
|---|---|---|
| 无实测站点的综合 score | uptime=null 时短路为 null | 原指控不成立 |
| 0.0001 新报价进入站点倍率排序 | 新写入拒绝 0.05~20 之外的倍率，按倍率排序优先总报价至少 3 个的站点 | PR1 已修复原输入和单报价场景 |
| 单个报价决定模型榜低价加成 | 同模型至少 3 个站点报价才启用加成，达标模型优先 | PR1 已修复原单报价场景 |
| 倍率是否真实、历史异常行 | 人工审核核对条件，现存 offers 不自动回填 | 保留数据真实性与历史数据边界 |

代码依据：`shared/src/domain.ts:5-6`、`server/src/catalog.ts:16-18,101`、`server/src/submissions.ts:421`、`server/src/service.ts:71-76,188-195,292-307`。不足 3 个报价的模型仍返回 lowestRate 供展示，不能沿用原草案「响应改成 null」的描述。

## 二、Codex 历史意见与当前状态

### P0-1：飞书直接覆盖已审核 Agent 更新

历史论证：两条通道用同一 slug 直接 UPSERT，DELETE 只按 source=submission 清理也不能防止随后的同主键写入，Agent 独立站点可能被改回群友来源。

**原直接同步场景已解决。** 当前飞书脚本使用 `/api/admin/submissions/batch`，不再调用 import；保留的 import 在生成允许导入站点集合时跳过已有非 submission/demo 来源的输入 slug，因此独立 agent/user 站点及其报价受保护（`scripts/sync-feishu.ts:432-436`、`server/src/catalog.ts:66-74,96-104`）。不再保留「每次飞书同步必然覆盖独立 Agent 站点」的断言。

当前边界：队列按 hostname 更新同一实体，保留首次 source、完整替换字段和报价；Agent 审核更新已有群友站点不会把它变成 agent 来源。管理员后续批准的新版本仍可更新这个共享实体，直接 import 仍可替换 submission 来源集合，也不推进队列版本（`server/src/submissions.ts:413-426`、`server/src/catalog.ts:96-110`）。这是共享实体与运维入口的当前语义，不是按来源隔离保存每份已审核贡献的实现。

### P0-2：低成本占满审核队列

历史推算使用「每账号 pending 20、hostname pending 3、全局 500」，得到约 25 个新账号可占满 500 项；不同 hostname 可以绕过单站限制。这是设计攻击成本分析，不是本次执行的攻击，也不能沿用原记录的「独立复现」作为当前证据。

**准入部分已完成，提交控制仍在 PR6。** 凭证申请要求注册满 7 天、至少一篇已通过的本人站内投稿、有效邀请码三选一；每账号最多 5 个活跃凭证，签发受账号/IP/邀请码窗口限制。PR5 还修复了用冒名 Agent/飞书文章取得贡献准入的问题，只有 source=user 或缺省 user 的本人文章计入（`server/src/agent-tokens.ts:15-39`、`server/src/app.ts:32-37,327-351`）。

v2 提交设计为 token 10/小时、账号 20/小时、IP 20/小时、账号 pending 5、hostname pending 2、全局 pending 200，当前分支尚无这些 Agent 提交检查或公开路由。多账号、不同 hostname 与人工吞吐仍是设计考虑，但不能把旧配额写成当前有效值或宣称 v2 已完整解决队列占用问题。

### P1 项的修复状态

| 历史意见 | 当前状态 | 依据 |
|---|---|---|
| 审核物化缺少单事务 | 已解决：单条审核、实体/报价写入和状态变更共用事务；批次仍逐条提交 | submissions.ts:473-497；node-app.ts:36-46；app.ts:188-209 |
| 无实测指标未显式 null | 已解决物化规则：创建和更新都显式写四项指标 null；FORBIDDEN_FIELD 入口拒绝待 PR6 | submissions.ts:413-426 |
| 凭证管理无所有权规则 | 已解决：会话本人签发/列表/吊销，他人 ID 返回 NOT_FOUND；明文仅一次 | app.ts:327-365；agent-tokens.ts:36-72 |
| 禁用与吊销后 Bearer 行为 | PR6 实现中：当前禁用删会话，吊销写 revokedAt，但没有 Agent Bearer 使用路径 | moderation.ts:26-33；agent-tokens.ts:63-72；shared/src/routes.ts |
| 拒绝原因反馈 | 管理队列已有 reason、reviewedAt，Agent status 成功响应及私有范围待 PR6 | shared/src/api.ts:23-36；submissions.ts:473-497 |
| CLI 与服务器校验漂移 | CLI 和共享提交 schema 待 PR7，当前只有服务端队列 schema | submissions.ts:52-65；当前 shared/src 文件清单 |
| 凭证吊销后 pending 投稿如何处理 | 当前没有 tokenId 关联或自动清除队列；历史查询与撤回策略尚未形成公开契约 | database.ts:55-91；agent-tokens.ts:63-72 |

表中未写目录前缀的文件均位于 `server/src/`。

## 三、Claude 历史意见与当前状态

### 1. 自报实测指标无法核验

历史论证有价值：允许 Agent 自报可用率和延迟但没有探测样本、时间和方法，管理员无法把这些数字当实测事实。

当前处理是**不给自报实测指标入口**，而不是要求一段自称证据后直接采用。站点物化的 uptime/firstTokenLatencyMs/foundedAt/status 已一律写 null，展示为暂无；Agent 的严格禁止字段规则尚待 PR6。秘密字段也不属于提交数据，当前管理原始 payload 仍会持久化，不能宣称字段 schema 已解决正文或 URL 路径里的秘密（`server/src/submissions.ts:153-161,203-205,421`、`web/src/format.ts:30-33`）。

### 2. 0.01 下限仍能支配模型榜

历史分析用 1/0.01=100 说明旧公式的低价加成过大，针对的是 v1 的 0.01~100 草案，**不能作为当前未修漏洞**：当前下限为 0.05，且至少 3 个站点报价才启用低价加成。价格声明的真实性仍需审核，门槛不是采价或探测证据（`shared/src/domain.ts:5-6`、`server/src/service.ts:292-307`）。

### 3. 固定模型目录阻塞真实提交

**没有运行时模型管理的阻塞已解决。** 当前管理员可以新增厂商与模型、修改模型 vendor/name/description、删除未被引用模型；队列可以新增模型，重名拒绝。运维 import 可用 allowNewModels 创建 unknown 厂商的占位模型。原记录的「线上固定 33 个、没有任何写入口」是旧快照，本次没有查询线上总量，不继续宣称当前模型目录固定（`server/src/app.ts:128-155`、`server/src/catalog.ts:76-94,138-183`、`server/src/submissions.ts:407-412`）。

**仍存在的报价完整性边界：** 飞书通过当前目录中的 name/slug 归一化匹配，未知模型、错误格式或越界倍率行提示后跳过，不计入记录级 skipped，因而不一定触发退出码 2。模型可管理不等于匹配一定成功，也不等于没有报价缺失。应先收录模型并核对脚本提示；pending 模型不能立即供同批站点报价引用（`scripts/sync-feishu.ts:139-167,230,402-409`、`server/src/submissions.ts:331-335`）。

### 4. 免费账号与进程内限制

原方案选择用户名密码注册，当前仍保留该产品形态。凭证准入和签发限制已加上；进程内 AttemptLimiter 重启清零、IPv6 按 /64 的边界仍在。不能把签发限流当成已实现的 Agent 投稿限流，也不能把免费注册本身等同于已证实的队列攻击（`server/src/app.ts:62-91,327-351`、`server/src/auth.ts:109-139`）。

## 四、共识问题的收束

| 共识问题 | 校正后的结论 |
|---|---|
| 飞书与 Agent 直接争用主键 | 同步已改队列，import 保护独立 agent/user 站点；共享 hostname 按批准版本更新并保留原来源 |
| 准入过松与队列可被打满 | 准入已完成；PR6 提交配额待实施，旧攻击数字仅为历史推算 |
| 模型库不可扩展 | 已有管理和队列新增入口，不再列为阻塞 |
| 未验证指标可冒充实测 | 物化 null 已落实，Agent 的禁止字段拒绝待 PR6 |
| 倍率排序容易被单条极端报价操控 | 范围和 3 报价门槛已落实，旧原例不再列为当前漏洞 |
| 需要审核原子性 | 单条已落实，整批保留逐条事务边界 |
| 需要拒绝原因和统一校验 | 管理 reason 已落实，Agent status 与 CLI 共享校验分别待 PR6/7 |

历史建议推动了 v2 的队列、准入和数据诚信设计。当前判断是按实际拆分继续 PR6~8 的契约工作；这份记录不再给出针对旧 v1 的「当前不可实施」总论，也不把尚未出现的公开 Agent 路由漏洞当成已复现事实。

## 五、本次迁移校正的文档差异

| 旧描述 | 按代码校正后的描述 | 依据 |
|---|---|---|
| entities 只由队列审核写入 | 普通文章、import、模型/厂商管理和种子仍有直接路径 | service.ts:231-242；catalog.ts:64-110,138-166；node-app.ts:56 |
| import 不再按来源跳过 | 当前会跳过已有非 submission/demo 来源站点及其报价 | catalog.ts:66-74 |
| 飞书调用 submissions/sync | 当前调用 submissions/batch，支持同批 500 项分块 | scripts/sync-feishu.ts:427-440 |
| 新 pending 到来就替代旧 pending | 新版本通过后才 supersede；幂等不跨新批次 | submissions.ts:170-192,449-469 |
| 模型同 slug 就更新 | 队列新增冲突 409 MODEL_EXISTS，改名使用管理员 PATCH | submissions.ts:407-412；catalog.ts:158-166 |
| 站点只合并非空字段 | 完整替换字段和报价，空 offers 清空旧报价，source 保留 | submissions.ts:413-426 |
| 队列评价用 stationKey 且必须已存在 | 当前用可选 hostname，匹配不到时 stationSlug=null；Agent stationKey 仍是草案 | submissions.ts:62-65,428-444 |
| submissions 已有 tokenId/reviewedBy | 当前没有这两列，已有 batchId/action/autoApproved | database.ts:71-91 |
| 凭证贡献准入认所有非演示已通过文章 | 只认本人 source=user 或缺省 user 的站内文章，agent/feishu 不计入 | agent-tokens.ts:22-27 |
| 飞书撤销即可删除文章 | 当前只有站点 remove，旧审核接口仍 409 且提示过时，撤销评价不会删除旧文章 | moderation.ts:20；submissions.ts:350-360,428-444 |
| 任一解析或报价错误都中止 | 记录级错误中止，报价行错误只提示跳过 | scripts/sync-feishu.ts:141-167,402-409 |
| schema 禁止字段已生效 | 物化 null 已生效；Agent FORBIDDEN_FIELD 和共享 schema 待 PR6/7 | submissions.ts:54-65,153-161,421 |
| 所有页面声明已覆盖 Agent | 标签和纯文本已覆盖，SITE_NOTICE 仍缺 Agent 说明 | web/src/format.ts:8-15；web/src/pages/PostDetail.tsx:44-46 |
| 老数据自动回填 approved 队列版本 | 未回填；无 approved 飞书版本的旧站点不参与下架检测 | submissions.ts:365-394 |

本 PR 的 `/api/agent/stations`、`/api/agent/posts`、`/api/agent/status` 统一标为「实现中」；请求保留设计草案，成功响应尚无契约，本分支的正确 JSON 请求目前返回 404 NOT_FOUND（`shared/src/routes.ts`、`shared/src/api.ts:284-313`、`server/src/app.ts:94`）。本次只校正文档，未改变上述代码行为。
