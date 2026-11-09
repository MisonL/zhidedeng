# 设计方案 v2：统一提交通道（替代飞书填表 + Agent CLI）

> 状态：修订版，待实施。本版根据 `docs/review-summary.md` 的交叉审阅结论重写。
> 上一版 v1 的问题见 `docs/review-summary.md`，本文不重复。

## 1. 核心转变

v1 是「在飞书通道旁边再开一条 Agent 通道」，两条路径并行写 `entities`，必然互相覆盖。

v2 改为**唯一写入路径**：

```
飞书表格 ──┐
Agent CLI ─┼──▶  submissions 表 (pending)  ──▶  人工审核  ──▶  entities
站内表单 ──┘                                        │
                                                唯一物化路径
```

`entities` 表只由审核动作写入，没有任何通道能直接改它。

## 2. 解决的 P0 问题

| v1 的 P0 | v2 的处理 |
|---|---|
| 飞书同步覆盖 Agent 数据（`catalog.ts` UPSERT 同 slug） | 删除 `importCatalog` 的直接写库能力，改为生成 pending 变更集 |
| 队列可被 25 个账号填满 | 准入前置条件 + 按 hostname 归并去重 + 审核者主导 |
| 模型库不可扩展导致真实提交失败 | 新增 `catalog_models` pending 类型，与站点一起审 |
| Agent 可提交虚假实测指标 | 提交 schema 中**不存在**这些字段，服务端一律写 null |

## 3. 数据模型

### 3.1 新增表

```sql
CREATE TABLE IF NOT EXISTS submissions (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK(kind IN ('station','model','post')),
  channel     TEXT NOT NULL CHECK(channel IN ('feishu','agent','web')),
  originKey   TEXT NOT NULL,          -- station: hostname；model: slug；post: 来源记录 ID
  payload     TEXT NOT NULL,          -- JSON 快照
  payloadHash TEXT NOT NULL,          -- 幂等
  actorHandle TEXT,                   -- agent/web 提交时为账号；feishu 为 null
  tokenId     TEXT,                   -- agent 提交时记录
  ip          TEXT NOT NULL,
  status      TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','superseded')),
  reason      TEXT,
  reviewedBy  TEXT,
  reviewedAt  TEXT,
  createdAt   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS submissions_status ON submissions(status, kind, createdAt);
CREATE INDEX IF NOT EXISTS submissions_origin ON submissions(kind, originKey, status);
CREATE INDEX IF NOT EXISTS submissions_actor ON submissions(actorHandle, createdAt);

CREATE TABLE IF NOT EXISTS agent_tokens (
  id         TEXT PRIMARY KEY,
  handle     TEXT NOT NULL,
  tokenHash  TEXT NOT NULL UNIQUE,
  label      TEXT NOT NULL,
  createdAt  TEXT NOT NULL,
  lastUsedAt TEXT,
  revokedAt  TEXT,
  useCount   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS agent_tokens_handle ON agent_tokens(handle);
```

`superseded`：同一 `originKey` 出现更新的 approved 提交时，旧的 pending 自动标记为 `superseded`，不占队列。

### 3.2 来源类型

`shared/src/domain.ts:10` 扩展为：

```ts
export type ContentSource = 'demo' | 'submission' | 'agent';
```

`Post.source` 已包含 `'user'`（`domain.ts:130`），不动。

前端标签（`web/src/format.ts`）：

```ts
export const SUBMISSION_LABEL = '群友提交，未经平台核实';
export const AGENT_LABEL = 'AI 采集，未经平台核实';
```

需更新的判断点（现有 `source === 'submission'` 的 5 处）：`StationCard.tsx:18`、`PostCard.tsx:28`、`Models.tsx:116`、`PostDetail.tsx:21,43`、`Stations.tsx:87`。

## 4. 提交 schema（Agent 与站内表单共用）

### 4.1 站点

```jsonc
{
  "kind": "station",
  "station": {
    "name": "示例中转站",              // ≤60，必填
    "url": "https://example.com",     // http/https，必填
    "description": "不超过 300 字",   // 可选
    "rechargeThreshold": 10,          // 可选，≥0
    "paymentMethods": ["支付宝"],      // 可选，≤10 项
    "offers": [{ "modelSlug": "gpt-4-1", "rate": 0.6 }]   // 可选，≤100 项
  }
}
```

**不存在**这些字段，提交时出现即 400 `FORBIDDEN_FIELD`：

```
uptime, firstTokenLatencyMs, foundedAt, status, score, lowestRate,
apiKey, api_key, token, password, secret
```

理由：项目硬约束（`docs/spec.md:17`）要求无实测数据必须为 null。站点没有探测机制，就**不给这个入口**。这比「要求附带证据」更简单可靠。

服务端物化时显式写入：

```ts
{ ...payload, uptime: null, firstTokenLatencyMs: null, foundedAt: null, status: null, source: 'agent' }
```

### 4.2 模型

```jsonc
{
  "kind": "model",
  "model": {
    "slug": "claude-sonnet-4-5",      // 小写字母数字连字符，≤64
    "vendor": "anthropic",            // 必须是已有 vendor slug
    "name": "Claude Sonnet 4.5",      // ≤60
    "description": "一句话说明"        // ≤200
  }
}
```

物化时 `tags: []`。模型 slug 冲突时走「更新 name/description」，不改 vendor。

### 4.3 评价

```jsonc
{
  "kind": "post",
  "post": {
    "stationKey": "example.com",      // hostname，必须已存在或同批提交
    "title": "使用 30 天体验",
    "summary": "一句话摘要",
    "body": "正文，纯文本"
  }
}
```

## 5. 统一审核

### 5.1 接口

```
GET  /api/admin/submissions?status=pending&kind=&limit=
POST /api/admin/submissions/:id/review   {"status":"approved"|"rejected","reason":"..."}
POST /api/admin/submissions/batch-review {"ids":[...],"status":"...","reason":"..."}
```

全部 `Bearer SYNC_TOKEN`，沿用现有 `/api/admin/*` 的 nginx 404 保护。

### 5.2 物化（单事务）

```
审核 approved：
  BEGIN
    ├─ kind=model    → 校验 slug 冲突 → store.put('model') → 标记 approved
    ├─ kind=station  → 校验 hostname → 写 station + offers → 标记 approved
    └─ kind=post     → 校验 stationKey → 写 post → 标记 approved
    同 originKey 的其他 pending → superseded
  COMMIT
失败则整体回滚，submission 保持 pending，返回错误说明
```

### 5.3 飞书同步改造

`scripts/sync-feishu.ts` 不再调用 `/api/admin/import`。改为：

```
lark-cli 拉取 → 过滤审核状态=通过 → 构造 submission 变更集
   → POST /api/admin/submissions/sync  {"channel":"feishu","items":[...]}
       ├─ 新 hostname → 插入 pending
       ├─ 与已有 approved 内容相同 → 跳过
       ├─ 内容有差异 → 插入新 pending，旧 pending 标记 superseded
       └─ 已 approved 但飞书里撤销通过 → 插入一条 kind='station' 撤下申请
```

**「撤销通过」语义变化**：从「下次同步后消失」变成「产生下架申请，人工确认后下架」。这更慢，但避免了静默删除，也解决了 v1 的数据丢失问题。

`/api/admin/import` 保留但标记废弃，用于一次性迁移存量数据。

## 6. 准入与反滥用

### 6.1 凭证准入（解决 v1 P0-2）

生成 agent token 的前置条件，三选一：

| 条件 | 说明 |
|---|---|
| 账号注册满 7 天 | 最基础 |
| 或：有 ≥1 篇通过的站内投稿 | 证明贡献过 |
| 或：持有邀请码 | 运营发放 |

不满足返回 `403 ELIGIBILITY_REQUIRED` 并说明还差什么。

每账号最多 5 个活跃 token，可随时吊销。

### 6.2 速率（沿用 v1，数值调整）

| 维度 | v1 | v2 | 理由 |
|---|---|---|---|
| 单 token | 10/小时 | 10/小时 | 不变 |
| 单账号 | 20/小时 | 20/小时 | 不变 |
| 单 IP | 30/小时 | 20/小时 | 收紧 |
| 单账号 pending | 20 | **5** | 准入已收紧，配额同步收紧 |
| 单 hostname pending | 3 | **2** | 让同一站点的提交更早进入审核视野 |
| 全局熔断 | 500 | **200** | 人工审核处理能力有限，宁可拒也不堆积 |

### 6.3 内容校验

| 校验 | 值 |
|---|---|
| `rate` 区间 | **`0.05 ~ 20`**（v1 为 0.01~100，过宽） |
| 站点最少报价数 | 榜单据要求 ≥3 个报价才计入最低倍率（见 6.4） |
| URL | http/https，去 query/fragment/账号密码 |
| URL 黑名单 | `localhost`、私有网段、`::1`、`.internal`、`.local` |
| 字段长度 | name ≤60、description ≤300、body ≤5000 |
| 幂等 | 同 actor + 同 payloadHash → 返回已有记录 |

### 6.4 榜单防刷（新增，独立于提交通道）

`server/src/service.ts:283` 模型榜当前用 `stationCount + 1/lowestRate`，单条假低价即可碾压。

改为：

```ts
// 至少 MIN_OFFERS_FOR_RATE 个报价才计入最低倍率
const rates = offers.filter(o => o.modelSlug === model.slug).map(o => o.rate);
const eligibleRates = rates.length >= 3 ? rates : [];
const lowestRate = eligibleRates.length ? Math.min(...eligibleRates) : null;
```

不足 3 个报价的模型不参与「最低倍率」计分，只计 `stationCount`。

## 7. CLI `zdd`

```
zdd login --key zd_xxx        保存凭证，~/.config/zdd/config.json 权限 0600
zdd whoami                    身份 + 准入状态 + 配额余量
zdd catalog                   厂商、模型、已有站点（含 hostname 提示）
zdd match "Claude Sonnet 4.5" 模型名模糊匹配 → 已存在则给 slug，否则提示走 model 提交
zdd validate ./x.json         跑共享 schema，不联网
zdd submit ./x.json           提交（支持 station / model / post 三种 kind）
zdd submit --batch ./dir/     批量提交
zdd status [--limit N]        审核进度 + 拒绝原因
```

所有命令输出 JSON。`status` 必须返回 `reason` 字段，供 Agent 自我修正。

**校验防漂移**：CLI 与服务器共用 `shared/src/submission.ts` 导出的 zod schema，不允许各写一份。

## 8. Skill

`.claude/skills/zdd-submit/SKILL.md`：

1. 触发条件
2. 前置检查（`zdd whoami`）
3. 必走流程：`catalog` → `match` → 构造 → `validate` → `submit`
4. **禁止事项**：不得提交 `uptime`/`firstTokenLatencyMs`；不得编造未验证的倍率；不得重复提交同站
5. 错误码 → 修复动作对照表

## 9. 实施阶段（每阶段独立 PR）

| # | 分支 | 内容 | 依赖 | 预估 |
|---|---|---|---|---|
| 1 | `fix/offer-rate-bounds` | 倍率 0.05~20 + 模型榜 ≥3 报价门槛 | 无 | 100 行 |
| 2 | `feat/model-catalog-writable` | 模型可新增（经 submission 审核） | 无 | 150 行 |
| 3 | `feat/submissions-queue` | `submissions` 表 + 统一审核 + 物化 + `'agent'` 来源 + 前端标签 | 1、2 | 450 行 |
| 4 | `feat/feishu-to-queue` | 飞书同步改走 submission 队列 | 3 | 250 行 |
| 5 | `feat/agent-tokens` | `agent_tokens` 表 + 准入判定 + 凭证管理 + 设置页 | 3 | 220 行 |
| 6 | `feat/agent-submit-api` | `/api/agent/*` + 速率/配额/幂等 | 3、5 | 300 行 |
| 7 | `feat/zdd-cli` | `scripts/zdd.ts` + 共享 schema | 6 | 400 行 |
| 8 | `feat/zdd-submit-skill` | SKILL.md | 7 | 150 行 |
| 9 | `docs/agent-submission` | README + `docs/spec.md` | 全部 | 100 行 |

合计约 2100 行。比 v1 的 1500 行多，但 v1 是错的。

## 10. 未决问题

1. **存量数据迁移**：线上已有飞书导入的 `source='submission'` 站点。切到队列模式时，这些数据是保留为 approved，还是回填成 submission 记录？建议保留，一次性 `INSERT ... SELECT` 回填。
2. **审核界面**：仍然是 curl。9 个 PR 之后是否需要做后台页面，取决于实际队列量。
3. **`CHECK(rate > 0)` 无法在线修改**：项目无迁移工具，`CREATE TABLE IF NOT EXISTS` 对已有库无效。应用层校验覆盖新写入，已有库的约束改不了。需在 README 写明。
4. **邀请码**：需要新增生成/分发/核销机制，本版未设计。
