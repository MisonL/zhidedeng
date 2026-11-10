# 什么值得蹬

AI 模型中转站的导购与点评社区：比较相对倍率，看社区评测，投「值 / 不值」。

## 功能

- 中转站库和模型库，按模型比较各站的相对倍率
- 文章信息流、评测、指南、社区讨论，排行榜和全站搜索
- 用户名密码注册登录，可改密码；投票、收藏、签到按账号存，投票数和收藏数公开累计
- 账户设置中签发、查看和吊销 AI Agent 凭证；明文仅签发时显示一次
- 评论登录后发布即公开，有频率限制；投稿先审后发
- 管理接口：投稿队列、整批审核、隐藏评论、禁用账号（没有后台页面，在服务器本机用 curl 调用）
- 飞书多维表格收集表同步（确定性脚本，不调用 LLM）

## 技术栈

pnpm workspace + TypeScript 严格模式。

| 目录 | 内容 |
|---|---|
| `shared/` | 前后端共用的 API 类型和路由表 |
| `server/` | Hono + `node:sqlite`，单进程，生产环境同时托管前端 |
| `web/` | Vite + React 19 + react-router |
| `scripts/` | 飞书同步脚本 |
| `deploy/` | systemd、nginx、备份和部署脚本 |

需要 Node 22.18 或以上的 22.x（依赖 `node:sqlite` 和原生 TypeScript 类型剥离）和 pnpm 12。

## 本地启动

```sh
pnpm install
pnpm dev
```

| 服务 | 地址 |
|---|---|
| 前端（Vite，`/api` 代理到后端） | http://localhost:5173 |
| 后端 API | http://127.0.0.1:8787 |

数据库默认在 `server/data/app.db`，空库自动写入演示数据。启动时会幂等补齐投稿表的 `batchId`、`action`、`autoApproved` 列，并建立批次索引；Agent 凭证表自动创建，旧表缺少的 `tokenPrefix` 列也会补齐。当前迁移只覆盖这些指定列，不是通用迁移工具（见 [`server/src/database.ts`](server/src/database.ts) 的 `ensureSubmissionColumns` 与 `ensureAgentTokenColumns`，调用点在 [`server/src/node-app.ts`](server/src/node-app.ts)）。

## 用 AI Agent 提交数据

凭证签发、列表和吊销，以及 `/api/agent/*` 三个提交接口都在本仓库实现，公开请求与响应以 [`shared/src/api.ts`](shared/src/api.ts) 和 [`shared/src/routes.ts`](shared/src/routes.ts) 为准。命令行工具 `zdd` 和 Agent Skill 是接口的下游使用者，位于各自的前置分支（`feat/zd-cli`、`feat/zd-submit-skill`），尚未合入本分支，本节末尾说明它们的位置和引用注意事项。设计依据见 [方案 v2](docs/plan-agent-submission-v2.md)，历史审阅的修复情况见 [交叉审阅记录](docs/review-summary.md)。

### 申请凭证

先注册并登录本站，然后在「我的 / 账户设置」签发凭证。准入条件三选一：

| 条件 | 当前实现 |
|---|---|
| 注册满 7 天 | 从账号 `createdAt` 起经过至少 7 个 24 小时 |
| 有至少一篇已通过的站内投稿 | 作者必须是本人，`status=approved`，`source=user` 或未写 source；演示、飞书和 Agent 文章不计入 |
| 有有效邀请码 | 签发时提交 `inviteCode`，与服务端环境变量 `INVITE_CODES` 的逗号分隔配置精确匹配 |

占位作者 `anonymous-submission` 不能申请。准入不足返回 `403 ELIGIBILITY_REQUIRED`，每账号最多 5 个未吊销凭证，超限返回 `409 TOKEN_LIMIT`（见 [`server/src/agent-tokens.ts`](server/src/agent-tokens.ts) 的 `requireEligibility`）。邀请码可重复使用，当前没有单次核销或生成接口。

以下示例使用已有登录会话的 curl Cookie 文件 `SESSION_COOKIE_FILE`；`SITE_URL` 是本站地址。凭证管理使用会话 Cookie，不能用 Agent 凭证代替。

```sh
# POST /api/account/agent-tokens
curl --connect-timeout 5 --max-time 15 -b "$SESSION_COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -d '{"label":"本机采集"}' "$SITE_URL/api/account/agent-tokens"
```

`label` 必填，去首尾空白后 1~100 字；需要邀请码时，请求体为 `{"label":"本机采集","inviteCode":"<运营提供的邀请码>"}`，邀请码去首尾空白后 1~200 字。请求不接受其他字段（`agentTokenSchema` 用 `z.strictObject`）。成功为 HTTP 200，以下 ID、前缀、时间和凭证均为示意值：

```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "tokenPrefix": "zd_examp\u2026",
  "label": "本机采集",
  "createdAt": "2026-11-09T04:00:00.000Z",
  "token": "<本次签发返回的完整凭证>"
}
```

明文只在本次签发响应显示一次。凭证由 `zd_` 加 32 字节随机数的 base64url 编码组成；数据库只存 SHA-256 和前八字符展示前缀，列表不能找回明文。请把完整凭证保存到密钥管理工具，Agent 运行时通过请求头携带，不要写进提交内容或源码；丢失后吊销旧凭证再签发。管理响应带 `Cache-Control: no-store`，签发与吊销日志不记录凭证、邀请码或标签（见 [`server/src/agent-tokens.ts`](server/src/agent-tokens.ts) 与 [`server/src/app.ts`](server/src/app.ts) 中的凭证管理与 `agentRequest`）。

```sh
# GET /api/account/agent-tokens：只列出本人的元数据，含已吊销凭证
curl --connect-timeout 5 --max-time 15 -b "$SESSION_COOKIE_FILE" \
  "$SITE_URL/api/account/agent-tokens"
```

HTTP 200 响应为数组，不分页：

```json
[
  {
    "id": "11111111-1111-4111-8111-111111111111",
    "label": "本机采集",
    "tokenPrefix": "zd_examp\u2026",
    "createdAt": "2026-11-09T04:00:00.000Z",
    "lastUsedAt": null,
    "revokedAt": null,
    "useCount": 0,
    "status": "active"
  }
]
```

```sh
# DELETE /api/account/agent-tokens/:id：吊销本人的凭证
curl --connect-timeout 5 --max-time 15 -X DELETE -b "$SESSION_COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  "$SITE_URL/api/account/agent-tokens/11111111-1111-4111-8111-111111111111"
```

HTTP 200 响应：

```json
{"id":"11111111-1111-4111-8111-111111111111","revokedAt":"2026-11-09T04:30:00.000Z"}
```

重复吊销返回第一次的 `revokedAt`；不存在或属于他人的 ID 返回 `404 NOT_FOUND`。列表中的状态为 `active` 或 `revoked`。`lastUsedAt` 和 `useCount` 会被 Agent 鉴权真实更新：每次带 `Authorization: Bearer` 调用提交或状态接口都会写入（见 [`server/src/agent-auth.ts`](server/src/agent-auth.ts) 的 `agentHandle`）；签发后从未调用过时才是 `null` 和 0，因此可以当作使用统计。

### 限流和配额

凭证签发的限制：

| 维度 | 限制 | 生效范围 |
|---|---|---|
| 单账号 | 10 次 / 小时 | 凭证签发 |
| 单 IP | 30 次 / 小时 | 凭证签发；IPv6 按 /64 计数 |
| 同一个邀请码 | 20 次 / 小时 | 请求只要带 `inviteCode` 就计入 |
| 单账号活跃凭证 | 5 个 | 数据库内计数，吊销后可补发 |

前三项是进程内滑动窗口，重启清零；达到限制返回 `429 RATE_LIMITED` 和以秒为单位的 `Retry-After`。准入不足或活跃凭证超限会返还本次预占计数，因此邀请码限流只统计带码的尝试，不会因为准入失败而误伤。列表和吊销没有上述签发限流（见 [`server/src/app.ts`](server/src/app.ts) 顶部的 `AGENT_TOKEN_*` 与 `INVITE_PER_CODE_LIMIT` 常量，计数实现在 [`server/src/auth.ts`](server/src/auth.ts) 的 `AttemptLimiter`）。

Agent 提交的配额在 [`server/src/agent-api.ts`](server/src/agent-api.ts) 顶部定义为常量并已在提交接口生效：

| 维度 | 限制 |
|---|---|
| 单 Agent 凭证 | 10 条 / 小时 |
| 单账号 | 20 条 / 小时（跨该账号所有凭证合计） |
| 单 IP | 20 条 / 小时 |
| 单账号 pending 投稿 | 5 条 |
| 单 hostname pending 投稿 | 2 条（所有渠道合计） |
| 全局 pending 熔断 | 200 条 |

前三项是速率，超限返回 `429 RATE_LIMITED`，并在响应头 `retry-after` 和响应体 `error.retryAfter` 两处给出等待秒数。后三项是待审数量，超限返回 `409 TOO_MANY_PENDING`，**只有 message 说明是哪一维，不带 `retryAfter`**：待审积压要靠人工审核消化，重试不会让额度恢复。速率计数只计成功入队的提交，被拒绝的请求会退还本次预占。

### 可以提交什么

Agent 接受站点公开信息、模型报价和文字评价。倍率区间 `0.05~20` 已在共享常量、导入和队列校验中生效；未知模型要先由管理员收录，pending 模型不能直接用于站点报价（见 [`shared/src/domain.ts`](shared/src/domain.ts) 的 `MIN_RATE`/`MAX_RATE` 与 [`server/src/submissions.ts`](server/src/submissions.ts) 的 `parseStationPayload`）。

以下字段不能进入 Agent 投稿 payload，出现即返回 `400 FORBIDDEN_FIELD`：

| 字段 | 原因 |
|---|---|
| `uptime`、`firstTokenLatencyMs`、`foundedAt`、`status` | 平台控制的指标或状态；没有探测机制就不允许自报实测可用率和延迟，缺失数据必须为 null |
| `score`、`lowestRate` | 由服务端根据指标和报价计算 |
| `apiKey`、`token`、`password`、`secret` | 凭证不属于公开站点或评价数据；鉴权放在请求头 |

拒绝检查覆盖任意嵌套层级，字段名忽略大小写、下划线和连字符；`api_key`、`authorHandle`、`accessToken`、`refreshToken`、`clientSecret`、`privateKey`、`authorization`、`credentials` 也在禁用集合内（见 [`server/src/agent-api.ts`](server/src/agent-api.ts) 的 `forbidden` 与 `rejectForbiddenFields`）。这不是正文秘密扫描：凭证也不能放在 description、正文或 URL 路径里。物化时四项指标显式写为 null，更新已有站点保留最初 source。管理队列是另一条受管理员保护的入口，其保存原始 payload 的行为不能当作 Agent 入口的拒绝规则。

### 提交接口

三个接口都由 `Authorization: Bearer zd_...` 凭证鉴权，路径定义在 [`shared/src/routes.ts`](shared/src/routes.ts)。提交请求体是**扁平 JSON 对象**，没有 `kind/station` 之类的封装层；写请求需带 `Content-Type: application/json`。

**凭证从哪来。** 账号在站点的「账户设置 → AI Agent 凭证」自助签发，最多 5 个，可随时吊销。签发的准入条件三选一：注册满 7 天、有过已通过的站内投稿、或持有邀请码。吊销后该凭证立即失效。

**三个接口的共同约束：**

- 公开 Agent 接口一律进入待审队列，**即使管理员开启自动通过也不例外**，响应固定为 `autoApproved: false`；人工审核通过才公开。新建的站点和评价标注「AI 采集，未经平台核实」；更新已有站点保留最初 source，因此标签不一定变成 AI 采集。
- 不接受根级多余字段（`schema.strict()`），整条返回 `400 INVALID_INPUT`。任意层级出现下述禁字段，优先返回 `400 FORBIDDEN_FIELD`。
- 拒绝实测或派生指标字段：`uptime`、`firstTokenLatencyMs`、`foundedAt`、`status`、`score`、`lowestRate`。没有实测数据就不能通过 Agent 自报；凭证类字段（`apiKey`、`token`、`password` 等）同样拒绝。
- 不接受 `authorHandle`。作者身份由凭证决定，不能自己声明。
- 幂等限定在**同一账号、同种类的相同规范化内容仍为 pending** 时，跨该账号不同凭证重复提交也返回 `deduplicated: true`，不重复入队或扣提交额度。JSON 根字段顺序、站点 URL 被清除的 query/fragment/账号密码不影响这一比较；已 approved/rejected/superseded 的内容再提交会产生新 pending。账号之间互不借用记录。

`POST /api/agent/stations`：提交站点公开信息。

```sh
curl --connect-timeout 5 --max-time 15 \
  -H "Authorization: Bearer $ZDD_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @- "$SITE_URL/api/agent/stations" <<'JSON'
{
  "name": "示例中转站",
  "url": "https://example.com/",
  "description": "根据公开页面整理，报价条件待人工核对。",
  "rechargeThreshold": 10,
  "paymentMethods": ["支付宝"],
  "offers": [{"modelSlug": "gpt-4-1", "rate": 0.6}]
}
JSON
```

六个字段全部必填（见 [`shared/src/api.ts`](shared/src/api.ts) 的 `CreateAgentStationRequest`，运行时校验在 [`server/src/submissions.ts`](server/src/submissions.ts) 的 `stationSchema`）：`name` 1~60 字，`description` 1~300 字，`rechargeThreshold` 非负或 `null`（无数据时不可省略键），`paymentMethods` 最多 10 项、每项 1~20 字，`offers` 最多 100 项、`modelSlug` 1~200 字、`rate` 在 0.05~20 之间、同一 `modelSlug` 不能重复；无支付方式或报价时用空数组。`modelSlug` 必须是平台已收录的模型，否则返回 `400 INVALID_INPUT`。

`url` 只允许 http/https，Agent API 会先去掉 query、fragment、用户名密码并规范化主机名及尾点，再按最长 300 字的 URL 规则校验；内网、回环、本地域名和 `.example` 保留后缀会被拒绝。URL 路径不被清除，不能把邀请码或秘密放在路径里。管理队列和 PR7 CLI 的本地 schema 则直接拒绝带 query、fragment 或账号密码的 URL，因此供 CLI 使用的文件应先清洗成示例中的公开 URL。入口只保存数据，不抓取所提交网址。

`POST /api/agent/posts`：提交文字评价。

```sh
curl --connect-timeout 5 --max-time 15 \
  -H "Authorization: Bearer $ZDD_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @- "$SITE_URL/api/agent/posts" <<'JSON'
{
  "title": "示例站点的公开信息说明",
  "summary": "根据官网说明整理，价格和使用条件仍需审核。",
  "body": "请管理员核对官网公布的充值和支付说明；本文没有可用率或延迟数据。",
  "authorName": "整理者",
  "hostname": "example.com"
}
JSON
```

`title`、`summary`、`body`、`authorName` 必填且非空，上限分别为 100、200、5000、30 字。`hostname` 可省略或为 `null`，最长 253 字，只能是主机名加可选端口；入库时端口被去掉并规范化主机名，内网和回环地址会被拒绝。`publishedAt` 可省略或为 `null`；提供时须为 ISO datetime（UTC `Z` 格式）。作者账号取自凭证。

`GET /api/agent/status`：查询本人审核进度、配额余量和拒绝原因。

```sh
curl --connect-timeout 5 --max-time 15 \
  -H "Authorization: Bearer $ZDD_TOKEN" "$SITE_URL/api/agent/status?limit=20"
```

`limit` 取 1~50，默认 20。响应类型见 [`shared/src/api.ts`](shared/src/api.ts) 的 `GetAgentStatusResponse`。下面是一个只有一条待审投稿的示意响应：

```json
{
  "handle": "alice",
  "pendingCount": 1,
  "quotas": {
    "token": { "limit": 10, "remaining": 8, "retryAfter": 0 },
    "account": { "limit": 20, "remaining": 18, "retryAfter": 0 },
    "ip": { "limit": 20, "remaining": 19, "retryAfter": 0 },
    "pending": { "limit": 5, "remaining": 4 },
    "globalPending": { "limit": 200, "remaining": 198 },
    "hostnames": [{ "hostname": "example.com", "limit": 2, "remaining": 1, "pendingCount": 1 }]
  },
  "submissions": [
    { "id": "sub_xxx", "kind": "station", "status": "pending", "createdAt": "2026-11-09T08:00:00.000Z", "reason": null }
  ]
}
```

`status` 取值 `pending` / `approved` / `rejected` / `superseded`。`reason` 可为空，拒绝时管理员也可以不填；被新版本替代时会给出系统原因。`pendingCount` 是本人全部渠道的待审记录数，`submissions` 是按时间倒序的最近记录，不限审核状态。`quotas.hostnames` 仅列本人待审记录涉及的 hostname，但每个 hostname 的待审数计入所有渠道、所有账号；没有 hostname 的评价不占 hostname 配额。速率余量来自当前进程的滑动窗口，不能用 pendingCount 推算。

**速率与配额**见上文「限流和配额」：`429 RATE_LIMITED` 带等待秒数，`409 TOO_MANY_PENDING` 不带 `retryAfter`。状态查询与待审幂等重试不扣提交额度。

**凭证失效**：凭证被吊销或账号被禁用时返回 `401 UNAUTHENTICATED`，错误信息统一，不区分「凭证不存在」和「凭证已过期」，避免泄漏凭证是否存在。

### 命令行工具

PR7 分支 `feat/zd-cli`（本次只读核对提交 `6c7aba4`）提供 `scripts/zdd.ts` 和 `shared/src/submission.ts`；PR8 分支 `feat/zd-submit-skill`（核对提交 `9ab0337`）提供 `.claude/skills/zdd-submit/SKILL.md`。这些路径**要在对应前置 PR 合入后才出现在本分支**，本分支不随文档另附实现或启动器。

PR7 CLI 封装 `login` / `whoami` / `catalog` / `match` / `validate` / `submit` / `status` 七个命令，stdout 输出 JSON，stderr 输出提示，退出码为 0~5。已核对的 TypeScript 入口可以在对应分支的仓库根目录用 `node --experimental-strip-types scripts/zdd.ts help` 调用；本分支没有可直接执行的 `zdd` 或 `scripts/zdd`。CLI 从 `ZDD_TOKEN` 或登录配置读取凭证，可用 `ZDD_API_BASE` 指向本站地址。`whoami` 使用现有 `GET /api/agent/status`，没有另一个身份接口；`validate` 不联网，也不能证明模型已在服务器收录。Skill 的执行流程和安装说明应在 PR7/8 合入时一并核对入口路径，不把计划中的别名当成已安装命令。

## 测试

```sh
pnpm -r typecheck
pnpm -r test
```

## 部署

目标是一台 Linux 服务器：单个 Node 进程只监听 `127.0.0.1`，nginx 反代并终止 TLS。服务器只要 Node 22.18+，不需要 `node_modules`。

```sh
pnpm build   # 产出 release/：server.mjs（单文件）、web/、backup-sqlite.sh
```

首次部署，在服务器上：

1. 安装 Node 22、nginx、sqlite3、rsync，创建运行用户 `zhidedeng`。
2. 创建目录 `/opt/zhidedeng`（部署用户可写，运行用户可读）。数据目录 `/var/lib/zhidedeng` 由 systemd 的 `StateDirectory` 创建，权限 0700。
3. 按 `.env.example` 写 `/etc/zhidedeng/zhidedeng.env`，权限 640。`DB_PATH` 放在 `/var/lib/zhidedeng` 下。`SYNC_TOKEN` 用 `openssl rand -hex 32` 生成，不足 32 位视为未配置。生产环境 Cookie 带 Secure，站点必须走 HTTPS。
4. 安装 `deploy/zhidedeng.service`、`deploy/zhidedeng-backup.service`、`deploy/zhidedeng-backup.timer`，启用服务和备份定时器。
5. 替换 `deploy/nginx-site.conf.template` 的占位符后启用，并删掉发行版自带的 default 站点（两个 `default_server` 会冲突）。模板只监听 IPv4，Host 不是本站的请求直接断开，`/api/admin/` 对公网返回 404。
6. 给部署用户配置免密 sudo，只授权 `deploy.sh` 用到的两条命令（`sudo visudo -f /etc/sudoers.d/zhidedeng`，`deploy` 换成实际用户）：

   ```
   deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart zhidedeng, /usr/bin/journalctl -u zhidedeng -n 50 --no-pager
   ```

之后每次发布，在本地：

```sh
DEPLOY_HOST=user@your-server deploy/deploy.sh
```

它会跑测试、构建、rsync、重启服务并做健康检查（`GET /api/health`）。可选变量见脚本开头。

演示数据只在空库时写入。改了 `server/src/seed.ts` 不会影响已有数据库。

## 管理接口

不对公网开放：nginx 对 `/api/admin/` 返回 404，要在服务器本机直连。都要 `Authorization: Bearer $SYNC_TOKEN`，未配置密钥时一律拒绝。写接口要求 `Content-Type: application/json`。

```sh
ADMIN=http://127.0.0.1:8787   # PORT 与环境文件一致

# 待审投稿
curl -H "Authorization: Bearer $SYNC_TOKEN" "$ADMIN/api/admin/posts?status=pending"
# 待审投稿队列，可按一次飞书同步返回的 batchId 筛选
curl -H "Authorization: Bearer $SYNC_TOKEN" "$ADMIN/api/admin/submissions?batchId=<batchId>"
# 人工确认后审核整批 pending；已审核条目会跳过，下架请求也在此人工审核
curl -X POST -H "Authorization: Bearer $SYNC_TOKEN" -H 'Content-Type: application/json' \
  -d '{"batchId":"<batchId>","status":"approved"}' "$ADMIN/api/admin/submissions/batch-review"
# 管理队列自动通过仅作用于 upsert；公开 Agent 接口不受此开关影响，下架始终人工确认
curl -X POST -H "Authorization: Bearer $SYNC_TOKEN" -H 'Content-Type: application/json' \
  -d '{"autoApprove":true}' "$ADMIN/api/admin/settings"
# 调整站内或 Agent 文章状态（pending | approved | rejected）；已物化群友文章在此返回 409，待审飞书内容用队列审核
curl -X POST -H "Authorization: Bearer $SYNC_TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"approved"}' "$ADMIN/api/admin/posts/<id>/review"
# 隐藏或恢复评论（回复随父评论一起隐藏）
curl -X POST -H "Authorization: Bearer $SYNC_TOKEN" -H 'Content-Type: application/json' \
  -d '{"hidden":true}' "$ADMIN/api/admin/comments/<id>/hide"
# 禁用或恢复账号。禁用后所有会话失效、不能登录，公开内容保留；需要时配合隐藏评论。恢复后要重新登录
curl -X POST -H "Authorization: Bearer $SYNC_TOKEN" -H 'Content-Type: application/json' \
  -d '{"disabled":true}' "$ADMIN/api/admin/users/<用户名>/disable"
# 新增模型。vendor 必须已存在；slug 只能用小写字母、数字和连字符，最长 64
curl -X POST -H "Authorization: Bearer $SYNC_TOKEN" -H 'Content-Type: application/json' \
  -d '{"slug":"claude-sonnet-4-5-20250929","vendor":"anthropic","name":"Claude Sonnet 4.5","description":"中转站常见的完整模型 ID"}' "$ADMIN/api/admin/models"
# 修改模型。slug 不变，vendor、name、description 要给全，tags 保留
curl --connect-timeout 5 --max-time 15 -X PATCH -H "Authorization: Bearer $SYNC_TOKEN" -H 'Content-Type: application/json' \
  -d '{"vendor":"anthropic","name":"Claude Sonnet 4.5","description":"更新后的模型说明"}' "$ADMIN/api/admin/models/<slug>"
# 删除模型。仍被站点报价或文章引用时返回 409 MODEL_IN_USE，含 stationCount 和 postCount
curl -X DELETE -H "Authorization: Bearer $SYNC_TOKEN" -H 'Content-Type: application/json' \
  -d '{"confirm":true}' "$ADMIN/api/admin/models/<slug>"
# 新增厂商。iconKey 缺省等于 slug；没有内置图标的厂商在前端降级显示站内图标
curl -X POST -H "Authorization: Bearer $SYNC_TOKEN" -H 'Content-Type: application/json' \
  -d '{"slug":"stepfun","name":"阶跃星辰"}' "$ADMIN/api/admin/vendors"
```

完整管理员接口清单见 [规范文档](docs/spec.md#管理接口)。通用导入接口 `/api/admin/import` 保留并直接写库，会替换 `source=submission` 的集合；输入 slug 已存在且来源不是 submission 或 demo 时跳过该站点，Agent/user 来源站点与报价因此保留。允许导入的站点会替换原报价。默认拒绝未收录的模型；带 `"allowNewModels": true` 时，未知模型会建成 vendor 为 `unknown` 的占位模型，响应里的 `createdModels` 列出新建的 slug。跳过来源保护的站点不参与这项模型检查（`server/src/catalog.ts` 的 `importCatalog`）。队列模型投稿只支持新增，重名返回 `409 MODEL_EXISTS`；改名使用 PATCH。批次中的未知报价模型逐条报错，需要先收录模型再提交站点。

## 同步飞书收集表

`scripts/sync-feishu.ts` 用 lark-cli 只读读取多维表格，把审核状态严格等于「通过」的记录聚合成一个投稿批次。同一 hostname 的信息合成一个站点，评价各自入队；每次最多提交 500 条，超过时串行分块并共用一个 `batchId`，管理员仍可以审核整批。默认待人工确认，开启自动通过只让 upsert（上架、更新和评价）立即生效；下架始终保持 pending，等管理员人工确认。

同步会读取 `/api/admin/submissions/state`，只对比已有 approved 飞书投稿且仍在线的群友站点。表格中已消失的站点生成同批次的下架请求，payload 包含实际 `slug` 和 state 返回的当前 `submissionId`；人工审核时再检查版本，站点已更新则返回 `409 STALE_REMOVAL` 并保留站点与报价。审核通过才删除站点与报价，已有评价保留；旧全量导入中没有对应 approved 飞书投稿的存量站点不参与下架检测。服务端按站点 URL 的 hostname 覆盖客户端 originKey，统一小写、IDN 和端口；飞书原有的 www 与裸域名分组继续沿用，更新时保留旧站点 slug。同请求中的重复站点整批返回 400，已被其他渠道占有的 batchId 返回 409。管理接口不对公网开放，脚本要在服务器本机运行（服务器上要有仓库、Node 依赖和 lark-cli）。

```sh
export LARKSUITE_CLI_CONFIG_DIR=...  # lark-cli 配置目录，必填，不回落到默认的 ~/.lark-cli
export FEISHU_BASE_TOKEN=... FEISHU_TABLE_ID=...
export SITE_URL=http://127.0.0.1:8787 # 服务器本机地址
export SYNC_TOKEN=...                 # 与服务环境文件相同，完整 dry-run 计划也需要

pnpm sync:feishu --dry-run           # 只读 GET，打印计划或中止原因
pnpm sync:feishu
pnpm sync:feishu --allow-skipped     # 显式跳过坏记录，本次只提交 upsert，不同步下架
```

同步和 `--dry-run` 共用数据安全检查：任何记录无法解析时以退出码 2 中止，不发 POST；成功解析的站点为零且线上仍有站点时也中止，避免空表清空线上。显式传 `--allow-skipped` 才跳过坏记录继续，且无论有无坏记录都完全不生成下架请求，并打印 `本次不同步下架` 警告；空表保护仍然生效。

`--dry-run` 绝不发送 POST。数据有效且未配置 `SYNC_TOKEN` 时只预览上架/更新和评价，并明确打印 `跳过下架检测：未配置 SYNC_TOKEN`，此时无法检查线上空表风险；配置 token 后打印完整计划。正式同步遇到逐条入队失败会列出失败条目并以非零退出码结束。分块不是整批事务，已成功的条目或分块会保留，日志中的 batchId 可用于查询和人工审核。

表格字段：中转站名称、网址、提交类型（推荐新站 / 更新信息 / 使用评价 / 避坑反馈）、模型与倍率（多行，每行「模型名=倍率」）、最低充值（元）、支付方式、推荐指数（1-5）、使用体验、展示昵称、审核状态（待审核 / 通过 / 拒绝）、审核备注、提交时间。审核备注不会外传。

读取失败、返回结构无法识别或关键字段被改名时，脚本中止且不入队，避免生成错误的下架请求。

报价行匹配不到模型、格式错误或超出倍率范围时仍会被跳过并打印 `[提示]`，不计入触发退出码 2 的记录级 `skipped`；需核对提示和最终报价，不能把安全中止规则理解为「任何报价缺失都整批中止」（`scripts/sync-feishu.ts` 的报价解析与安全检查）。

飞书撤销某条评价不会删除已物化文章；当前同步只生成站点下架请求，站点下架也保留评价。旧文章审核接口对 `source=submission` 仍返回 `409 MANAGED_BY_SOURCE`，其「到飞书撤销后同步」提示不能实现文章下架（`server/src/moderation.ts` 的 `reviewPost`、`server/src/submissions.ts` 的 `removeStation` 与评价物化分支）。

## 数据说明

- 名称带「虚构」的站点、倍率、可用率、延迟、评论和评测是演示数据，不对应任何真实服务。
- 标注「群友提交，未经平台核实」的内容来自飞书表单；标注「AI 采集，未经平台核实」的内容来自 agent 渠道。队列和导入物化的站点没有实测可用率和延迟，页面显示「暂无」；这两种来源的评价正文按纯文本显示。已有站点更新时保留最初来源，不能仅凭标签判断最后一次更新渠道。
- 以上内容都不构成消费建议。

## 免责声明

本项目与什么值得买及任何模型厂商、中转站均无关联。厂商名称和图标仅作分类标识，商标归各自权利人所有。

## 已知未修

- 没有找回密码，也不能注销账号。
- 登录、凭证签发和 Agent 提交速率限流在进程内，重启清零，也只适用于单进程。
- 按用户名计数的登录退避可以被别人用来把某个账号挡在登录外最多 15 分钟。
- 没有通用数据库迁移工具；启动只补指定列。`offers` 的数据库 CHECK 仍是 `rate > 0`，0.05~20 在应用层校验，已有异常倍率不会自动回填。
- 禁用账号不会自动隐藏它已发布的内容，要逐条隐藏评论或拒绝投稿。
- Agent 入口和飞书同步清除 URL 的 query、fragment、用户名密码，但路径里的邀请码、正文里的秘密过滤不到，靠提交者自查和人工审核。
- 真实站没有可用率，默认排序排在演示站之后；前端站点目录只取 50 个，超过后部分文章卡片缺站名。

## 第三方素材

- 厂商图标来自 [@lobehub/icons-static-svg](https://www.npmjs.com/package/@lobehub/icons-static-svg)，MIT 许可。
- 字体通过 Fontsource 自托管 Noto Sans SC、Noto Serif SC 和 JetBrains Mono，均为 SIL Open Font License。
- 首页 Banner（`web/public/banners/`）是 AI 生成的插画。

## 许可证

[MIT](./LICENSE)
