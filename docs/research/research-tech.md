# 什么值得蹬 · 10 项功能的技术设计

> 仓库：`/Volumes/Work/orca/zhidedeng-wt/deploy-test`（分支 `release/agent-submission`，HEAD `11fab7e`）
> 结论以当前代码为准：`shared/src/{domain,api,routes}.ts`、`server/src/{database,app,service,submissions,auth,moderation,catalog}.ts`、`web/src/**`。
> 本文只做设计，不改仓库任何文件。

---

## 0. 前提核对（先纠正 5 个会直接写错设计的硬事实）

这几条是我读代码时核出来的，和「凭直觉写」的结论不一样，后面每个功能都建立在它们之上。

**0.1 路由是 39 条，不是「大约 40」。** `API_ROUTES` 实测 39 条（`grep -c "method: '"` = 39），`ApiContracts` 与之一一对应，`satisfies Record<keyof ApiContracts, …>` 强制双向对齐。加一条路由 = 同时改 `API_ROUTES` + `ApiContracts` + `web/src/api.ts` 三类，漏一个就 typecheck 失败。这是好事：契约有编译期护栏。

**0.2 `route()` 派发器不把 path 参数合并进请求体，这是加 `PATCH /api/posts/:id` 的第一个拦路石。**

```ts
// server/src/app.ts:534
const raw: unknown = method === 'GET'
  ? normalizeQuery(schema, { ...c.req.query(), ...c.req.param() })
  : JSON.parse(body || '{}');            // ← 非 GET 完全不看 c.req.param()
```

当前 39 条里**没有任何一条非 GET 路由带 path 参数**（`revokeAgentToken` 是手写的 `app.delete`，不走 `route()`），所以这个洞一直没暴露。设计「文章编辑」不能想当然地在 handler 里读 `c.req.param('id')` —— `route()` 的签名根本没有 `c`。

**0.3 迁移只补列，不补表。** `SCHEMA` 全是 `CREATE TABLE IF NOT EXISTS`，对已有库不生效；`ensureColumn()` 是 `database.ts` 的**私有函数**，只能补列、且表名参数默认 `'submissions'`。任何新表都靠 `CREATE TABLE IF NOT EXISTS`（新表在旧库里确实不存在，所以生效），任何新列必须显式加一个 `ensureXxxColumns(store)` 并在 `node-app.ts` 的 `openDatabase` 里调用，且**必须在 `db.exec(SCHEMA)` 之后**（`node-app.ts:26-41` 的顺序就是这个原因）。新列上要建索引的，ALTER 一定要排在 `CREATE INDEX` 之前，否则启动直接 `no such column` 崩溃——`removedAt` 那次踩过。

**0.4 `entities` 存的是整行 JSON，没有列。** 给 Post 加字段（`revision`、`updatedAt`、`deletedBy`）**不需要迁移**：读的时候给默认值即可，老行天然兼容。但反过来，任何「按新字段过滤/排序」都要走 `json_extract` 表达式索引，否则是逐行 `JSON.parse`。这是本项目性能模型的核心分界：**加字段免费，按字段查要钱**。

**0.5 事务是同步的、单进程的，`BEGIN IMMEDIATE` 抢写锁。** `openStore` 用 `depth` 计数支持嵌套（内层 `SAVEPOINT`），所有写库必须在 `store.transaction()` 里。这意味着：设计里任何「先查后写」只要跨越了 `await`（只有 scrypt 会 await），就有 TOCTOU 风险，必须用条件写（`WHERE passwordHash = ?` 那种写法，见 `changePassword`）。**新功能里没有一个需要 await**，所以事务内读写天然串行，不需要乐观锁——除了跨请求的版本冲突，那要靠显式 `revision`。

---

## 1. 总览

| # | 功能 | 成本 | 规模 | 风险 | 建议 |
|---|---|---|---|---|---|
| F1 | Token 消耗出口 | 中 | ~490 行 | 中 | 做，但兑换物只能是「装饰 + 打赏 + 额度」，**不能买票/买排序** |
| F2 | 文章编辑 | 大 | ~510 行（零迁移） | **高** | 做，但必须复用 submissions 队列，且要改 `materialize`/`route()` |
| F3 | 文章删除 | 小 | ~185 行 | 中 | 做，复用 `removedAt`，但要区分「作者自删 vs 管理员下架」 |
| F4 | 评论删除 | 中 | ~150 行 + 260 行测试 | **高** | 做，墓碑 + 硬删双策略，`COMMENT_VISIBLE` 四处口径必须同步 |
| F5 | 头像 | 小 | ~110 行 | 低 | 只做预设 key，**不做上传/外链** |
| F6 | 举报 | 中 | ~390 行 | 中 | 做，人工处置，**不做自动下架** |
| F7 | 关注/通知 | 大 | ~725 行 | **高** | 做，但必须是**拉模型**，不能写扩散 |
| F8 | 站点对比 | 中 | ~340 行 | 中 | 做，需要新接口（不是纯前端） |
| F9 | SEO | 中 | ~230 行 | 中 | 做 sitemap/RSS/OG 注入，**不做 SSR 框架迁移** |
| F10 | 账号注销 | 大 | ~435 行 | **高** | 做，宽限期 + 匿名化保留内容，**不做硬删** |

合计约 **3560 行产品代码 + 约 2770 行测试**。**新增公开路由 14 条（39 → 53）**，管理路由 4 条 + 3 个站点级资源（都不进契约）。

---

## F1. Token 积分消耗出口

### 结论

现状是单向通胀：新号 120，签到 `10 + min(streak,7)`（`service.ts:531`），无任何扣减。不处理的话「Token」只是装饰数字，用户也没有回访动力。设计必须是**记账式**而不是「在 user JSON 上 `tokens -= n`」——因为一旦出现「扣了但权益没发」或「重试扣两次」，就没有任何东西能对账。

核心设计取舍三条：

1. **余额是投影，流水是事实。** 新增 `token_ledger`，`user.data.tokens` 降级为缓存字段，任何写入都要在同事务里同时写流水和余额，并用测试锁死 `user.tokens === latest.balanceAfter`。
2. **兑换物必须与「数据诚信」硬约束不冲突。** 可买：装饰（徽章/昵称色）、额度（+5 篇/天）、打赏（转给作者）。不能买：投票权重、榜单排序、文章置顶、审核跳过。理由是本站的存在意义是「倍率与评价的可信」，一旦 token 能影响排序，整站数据就不可信了；这条写进 spec，别留给下一任判断。
3. **不做外部履约。** 没有对象存储、没有邮件、没有第三方，所有权益都是站内即时生效的本地状态，因此不需要「预扣-确认」两阶段，一个事务即可。

### 契约变更

`API_ROUTES` 新增 3 条：

```ts
getRewards:      { method: 'GET',  path: '/api/rewards' },
getMyTokens:     { method: 'GET',  path: '/api/me/tokens' },
redeemReward:    { method: 'POST', path: '/api/me/tokens/redeem' },
```

`shared/src/api.ts`：

```ts
export type RewardKey = 'tip' | 'badge' | 'quota';

export interface Reward {
  key: RewardKey;
  title: string;
  description: string;
  /** 单价，正数。tip 是每档固定面额，见 options。 */
  cost: number;
  /** 打赏的可选面额；其它奖励为空数组。 */
  amountOptions: number[];
  /** 每人每天最多兑换次数，null 不限（打赏不限）。 */
  dailyLimit: number | null;
  /** 只有打赏需要 targetType/targetId。 */
  requiresTarget: boolean;
}

export type GetRewardsRequest = EmptyRequest;
export interface GetRewardsResponse { items: Reward[]; balance: number | null }

export interface TokenLedgerEntry {
  id: string;
  delta: number;
  balanceAfter: number;
  reason: 'checkin' | 'redeem' | 'tip-out' | 'tip-in' | 'migrate' | 'admin';
  /** 人类可读，服务端生成，前端直接展示。 */
  note: string;
  refType: 'post' | 'station' | 'reward' | null;
  refId: string | null;
  createdAt: ISODateTime;
}
export type GetMyTokensRequest = PaginationQuery;
export type GetMyTokensResponse = PaginatedResponse<TokenLedgerEntry> & { balance: number };

export interface RedeemRewardRequest {
  key: RewardKey;
  /** 打赏必填；其它奖励必须省略。 */
  targetType?: 'post' | 'station';
  targetId?: string;
  /** 打赏面额；其它奖励必须省略。 */
  amount?: number;
  /** 客户端生成（uuid v4），重试复用同一个值。 */
  idempotencyKey: string;
}
export interface RedeemRewardResponse {
  balance: number;
  ledgerId: string;
  /** 幂等命中时为 true，此时没有产生新的扣减。 */
  deduplicated: boolean;
  grant: { badgeKey?: string; expiresAt?: ISODateTime; quotaAdded?: number; tipTo?: string };
}
```

错误码：`INSUFFICIENT_TOKENS`(409)、`REWARD_NOT_FOUND`(400)、`REWARD_LIMIT`(429，带 retryAfter)、`REWARD_TARGET_INVALID`(400，打赏给自己/给不存在的文章)、`IDEMPOTENCY_KEY_REUSED`(409，同 key 不同参数)。

### 数据模型

```sql
-- SCHEMA 里新增（新表，旧库自动建）
CREATE TABLE IF NOT EXISTS token_ledger (
  id            TEXT PRIMARY KEY,
  handle        TEXT NOT NULL,
  delta         INTEGER NOT NULL,          -- 负数表示消耗
  balanceAfter  INTEGER NOT NULL,
  reason        TEXT NOT NULL CHECK(reason IN ('checkin','redeem','tip-out','tip-in','migrate','admin')),
  note          TEXT NOT NULL,
  refType       TEXT,
  refId         TEXT,
  idempotencyKey TEXT,
  actorHandle   TEXT,                      -- 打赏的对方
  createdAt     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS token_ledger_user ON token_ledger(handle, createdAt);
-- 幂等键只在「有 key」的行上唯一：部分唯一索引，历史行不受约束
CREATE UNIQUE INDEX IF NOT EXISTS token_ledger_idem ON token_ledger(handle, idempotencyKey)
  WHERE idempotencyKey IS NOT NULL;
```

`user.data` 里加两个字段（**不需要迁移**，读取给默认值）：`badges?: { key: string; expiresAt: ISODateTime }[]`、`quotaBonus?: { date: ISODate; extra: number }`。

存量余额迁移（一次性、幂等、只在非只读时跑）：

```sql
INSERT INTO token_ledger (id, handle, delta, balanceAfter, reason, note, createdAt)
SELECT lower(hex(randomblob(16))), json_extract(data,'$.handle'),
       json_extract(data,'$.tokens'), json_extract(data,'$.tokens'),
       'migrate', '历史余额结转', ?
FROM entities
WHERE kind='user' AND json_extract(data,'$.tokens') > 0
  AND NOT EXISTS (SELECT 1 FROM token_ledger l WHERE l.handle = json_extract(entities.data,'$.handle'));
```

放在 `node-app.ts` 的 `openDatabase` 末尾（`ensureOfferColumns` 之后）。`NOT EXISTS` 保证可重复执行。

### 服务端实现要点

- **模块**：新文件 `server/src/tokens.ts`，导出 `RECHARGE_REASONS`、`grantTokens(store, {handle, delta, reason, note, ref, idempotencyKey, now})`、`redeem(store, service, input, now)`。`service.checkIn()` 改成调用 `grantTokens`，不直接 `put('user', …)`——否则会出现「签到有余额没流水」，对账立刻断裂。
- **事务边界**：`redeem` 全程一个 `store.transaction(() => …)`：读 user → 校验余额/限额 → 写 `token_ledger`（幂等键冲突就返回已有记录）→ 写 user（扣余额 + 发权益）→ 打赏场景再给对手方写一条 `tip-in` 并更新其 user。全部在同一个 `BEGIN IMMEDIATE` 里，不存在半途。
- **幂等的正确姿势**：先按 `(handle, idempotencyKey)` 查流水；命中且 `refType/refId/delta` 一致 → 返回 `deduplicated: true`；命中但参数不同 → `IDEMPOTENCY_KEY_REUSED`。**不要**依赖 `INSERT OR IGNORE` 静默吞掉，那会让「同 key 改了面额」看起来成功。
- **限流**：`new AttemptLimiter(10, 60_000, store, 'redeem')`，按 handle；再叠一层 `REWARD_LIMIT`（徽章每人每天 1 次、额度每人每天 2 次）走 `dailyLimit`，两者语义不同：前者防刷请求，后者是产品规则。额度奖励必须真的被 `postsInLastHour()` 读到，即在 `assertCanSubmitPost` 里加 `+ bonusOf(this.user).extra`，否则用户花了 token 没效果。
- **打赏的权限与诚信**：不能打赏给自己（`REWARD_TARGET_INVALID`）；不能打赏 `removedAt != null` 的对象；打赏不改变任何计数（不生成 vote、不改 `favoriteCount`），只在文章详情显示「收到 N Token 打赏（累计）」，而这个 N 需要一条聚合查询——**别在列表里做**，只放进 `getPost`。
- **审计**：`console.info(JSON.stringify({event:'tokens.redeem', handle, key, delta, balance}))`，不含任何秘密。

### 前端改动

- `web/src/pages/Me.tsx`：`TABS` 加 `{ value: 'tokens', label: 'Token 明细' }`，新组件 `<TokenLedger />` 用 `useAsync` + `LoadMore`（直接复用 `usePaged`）；顶部复用 `AsyncView` 三态。
- 新组件 `web/src/components/RedeemPanel.tsx`：卡片列表（来自 `getRewards`），徽章用现有 `Icon`，余额不足时按钮 disabled + 提示差额。
- `web/src/pages/PostDetail.tsx`：作者署名右侧加「打赏」小按钮，点开 `<dialog>` 选面额；成功后 `me.refreshMe()` 并用 `useToast`。
- `web/src/components/UserCard.tsx`：Token 数字旁加「明细」链接到 `/me?tab=tokens`，让出口被看见（否则用户根本不知道能花）。
- 新 hook？不需要。`usePaged` 够用；打赏用局部 `useState` + `api`。

### 与既有逻辑的冲突点

1. **`checkIn` 的返回值契约**：`CheckInResponse` 里有 `tokens`（新余额）。改成记账式后必须继续用「写后余额」，不能返回 `旧余额+奖励` 的表达式值——那是当前实现（`service.ts:536`），改成 ledger 后很容易写错成两次扣。
2. **`updateMe` 是整对象展开覆写**：`store.put('user', this.user, { ...user, ...input })`（`service.ts:521`）。如果 `redeem` 与 `updateMe` 并发（同一个同步事务队列里不会真并发，但**同一毫秒内的两个请求**会各自 `get` 一次），后写者会把先写者的 `badges` 抹掉。解决：`redeem` 与 `updateMe` 都必须在事务内重新 `get('user')`（`updateMe` 已经这么做了），并且**不要**在事务外事先读好 user 传进去。
3. **`getMe` 性能**：`getMe` 每次页面加载都调，已有 4 条查询。新增 `balance` 不能再扫 ledger；直接读 `user.tokens` 即可（它就是投影），**不要**为了「真实性」去 `ORDER BY createdAt DESC LIMIT 1`。
4. **`initial 120 + streak 递增` 的长期通胀**：如果只加不设计封顶，3 个月后人人几千 token，徽章变成零成本。建议同时把签到奖励改为 `5 + min(streak,7)`（或给徽章涨价），并写进 spec——这是一次需要用户拍板的经济参数，不是纯技术决定。

### 测试策略

- `server/test/tokens.test.ts`（新）：
  - 签到后 `user.tokens` 与 `token_ledger` 最新 `balanceAfter` 一致（**这条是核心不变量**）。
  - 余额不足 → 409 `INSUFFICIENT_TOKENS`，且**不**写任何 ledger 行（断言行数不变）。
  - 同 `idempotencyKey` 重放 → `deduplicated: true`、余额只扣一次、ledger 只多一行。
  - 同 key 改面额 → 409。
  - 打赏自己 → 400；打赏已下架文章 → 400；打赏成功后双方各一行流水、两笔余额相加守恒。
  - 每日限额：第 2 次徽章 → 429。
  - 迁移：`node-app.test` 里对「有余额但没有 ledger」的库跑一次，重复跑不产生第二行。
- `web/test/redeem.test.tsx`（新）：余额不足按钮禁用；成功后 me 余额即时刷新；重试按钮复用同一个 `idempotencyKey`（用 `callsTo` 断言 body 里 key 相同）。
- **变异验证**：
  - 把 `token_ledger_idem` 的 `WHERE idempotencyKey IS NOT NULL` 去掉 → 迁移行（key 为 NULL）会互相冲突，测试立刻红。这条能证明「部分唯一索引」不是装饰。
  - 把 `redeem` 的余额校验从 `balance < cost` 改成 `<=` → 「余额恰好等于价格」用例变红。
  - 把 `grantTokens` 里「写 user」那句删掉 → 不变量用例红，且 `getMe().tokens` 与流水不一致。

### 成本

**中等**：`tokens.ts` ~150 行，`service.ts` 改 ~60 行（checkIn/quota），`app.ts` 3 条路由 ~40 行，`shared` ~60 行，迁移 ~20 行，web ~180 行。合计 ~490 行 + 测试 ~350 行。

---

## F2. 文章编辑（风险最高）

### 结论

编辑是这 10 项里**唯一会改到审核流水线核心**的功能，不能当成「再写一个 UPDATE」来做。三个决定：

1. **编辑走 `submissions` 队列，不直写 entities。** 理由：审核的目的是「防止编造」，改正文就是改内容；如果作者改了正文立即生效，等于给了一条绕过审核的通道（先发一篇合规的，过审后改成广告）。这与「数据诚信」是同一件事。
2. **旧版继续在线（stale-while-review）。** 新版本 pending 期间，线上仍是已通过的旧版；通过后原子替换。不能「编辑即下架」——那会让一次误编辑把文章打成 404。
3. **版本冲突用显式 `revision`，不用 `updatedAt` 时间戳。** 时间戳在同步单进程里也能撞（同一毫秒），而且时钟回拨会让冲突检测失效；`revision` 是单调整数，判定无歧义。

### 契约变更

`API_ROUTES` 新增 1 条：

```ts
editPost: { method: 'PATCH', path: '/api/posts/:id' },
```

`shared/src/api.ts` / `domain.ts`：

```ts
// domain.ts：Post 增加两个可选字段（老数据缺省 revision=1、updatedAt=null）
export interface Post {
  // …原有字段…
  /** 每成功物化一版 +1。用于编辑的乐观锁，不是时间。 */
  revision: number;
  /** 最后一次变更时间；首次发布时等于 publishedAt。 */
  updatedAt: ISODateTime;
  /** 有编辑正在审核时，给作者自己看的提示；其他人恒为 undefined。 */
  pendingEditId?: string | null;
  /** 作者自删留痕：'author' 表示作者自己删的；管理员下架时为 null。 */
  removedBy?: 'author' | 'admin' | null;   // 只在详情页返回给作者/管理员，列表不带
}

export interface EditPostRequest {
  /** 全量覆盖的正文相关字段，缺省表示不改。 */
  title?: string;
  summary?: string;
  body?: string;
  stationSlug?: string;
  modelSlug?: string;
  /** 必填：客户端读到的 revision。 */
  expectedRevision: number;
}
export interface EditPostResponse {
  /** 返回「线上现在这一版」（可能仍是旧版），供前端立即回显。 */
  post: Post;
  /** 进队列时是投稿 id；自动通过或幂等命中时同值。 */
  submissionId: string;
  /** pending | approved（自动通过时直接 approved）。 */
  status: 'pending' | 'approved';
  deduplicated: boolean;
}
```

错误码：`REVISION_CONFLICT`(409，附 `currentRevision`)、`POST_REMOVED`(409)、`NOT_POST_AUTHOR`(403)、`EDIT_TOO_SOON`(429)、`TOO_MANY_PENDING_EDITS`(409)。**注意 `ApiError` 已经支持 `details` 展开进响应体**（`app.ts:270`），`currentRevision` 直接塞 details。

### 数据模型

**零迁移**：`revision`/`updatedAt` 在 `entities.post.data` 里，可缺省。`ensureColumn` 用不上。

`submissions` 表**不改结构**（`action` 的 CHECK 只有 upsert/remove，SQLite 又不能给已有列加 CHECK，所以绝不要新增 `action='edit'`）。编辑复用 `action='upsert'`，在 payload 里带 `editOf`：

```jsonc
// webPostSchema 加一个可选字段
{ "kind":"review","title":"…","summary":"…","body":"…",
  "stationSlug":null,"modelSlug":null,
  "editOf":"<目标 post id>",      // 新增，仅编辑时有
  "baseRevision": 3 }             // 新增，提交时读到的 revision，物化时再校验一次
```

`originKey = web:<handle>:edit:<postId>`（现有创建用 `web:<handle>:<payloadHash>`，两者不会互相命中，也不会和 Agent/飞书撞）。

### 服务端实现要点

这是全项目改动最细的一块，按顺序：

**(1) 修 `route()` 的 path 参数缺口**（必须先做，否则 PATCH 拿不到 id）：

```ts
const raw: unknown = method === 'GET'
  ? normalizeQuery(schema, { ...c.req.query(), ...c.req.param() })
  : { ...(await c.req.json().catch(() => ({}))), ...c.req.param() };
```

安全性论证：当前**没有任何** `route()` 注册的非 GET 路由带 path 参数（唯一带参数的非 GET 是手写的 `revokeAgentToken`），所以这次合并不会改变任何既有请求的解析结果；但为了防回归，必须补一条用例：对 `POST /api/votes` 多传 `id` 时仍应 400 `INVALID_INPUT`（strictObject 生效）。另外把 `JSON.parse(body || '{}')` 换成 `c.req.json()` 前要确认 CSRF 中间件的 `c.req.text()` 已缓存（`app.ts:297` 的注释明确说 Hono 的 `c.req.text()` 会缓存，同一请求再 `json()` 不会二次消费）——保守起见保留 `JSON.parse(await c.req.text() || '{}')`，只加 `...c.req.param()`。

**(2) `service.updatePost`**（新方法，`Service` 类内）：

```ts
updatePost(id: string, input: EditPostRequest, ip: string) { … }
```

流程：

1. `const live = this.store.get('post', id)`（用 `get`，不是 `getWithRemoved`）。
   - 不存在 → 404。**存在但 `removedAt != null`** → 409 `POST_REMOVED`（编辑不能复活已删内容，这条是「软删除 × 编辑」的主坑）。
2. `live.authorHandle !== this.user` → 403 `NOT_POST_AUTHOR`。
3. `live.revision !== input.expectedRevision` → 409 `REVISION_CONFLICT` + `currentRevision`。
4. 组装新 payload；**只允许改 title/summary/body/stationSlug/modelSlug**，`publishedAt`/`authorHandle`/`source`/`cover`/`status` 一律从 `live` 取——尤其 `publishedAt`，改它会把文章顶到「最新」榜（见 §5 坑 2）。
5. 校验 `stationSlug`/`modelSlug` 存在（与 `createPost` 同款 400）。
6. 进队列：

```ts
enqueueSubmission(store, {
  kind: 'post', channel: 'web', originKey: `web:${this.user}:edit:${id}`,
  payload: { ...next, editOf: id }, actorHandle: this.user, ip, now: this.now(),
}, {
  // 编辑不占用户的「投稿」配额（见冲突点 3）
  beforeInsert: () => { /* 编辑配额已在路由层预检 */ },
});
```

`enqueueSubmission` 的查重键含 `payloadHash`，所以「同样的内容再点一次保存」→ `deduplicated: true`，天然幂等。**不需要额外幂等键。**

**(3) `materialize` 增加编辑分支**（`server/src/submissions.ts`，`submission.channel === 'web'` 那段之前）：

```ts
if (submission.channel === 'web' && payload.editOf) {
  const target = store.get('post', payload.editOf);
  if (!target) throw new ApiError(409, 'TARGET_REMOVED', '目标文章已不存在或已删除，本次编辑不能生效');
  if (target.authorHandle !== submission.actorHandle) throw new ApiError(403, 'NOT_POST_AUTHOR', '…');
  if ((target.revision ?? 1) !== payload.baseRevision) {
    throw new ApiError(409, 'REVISION_CONFLICT', '文章在你编辑期间已被更新');   // 审核期间又改了
  }
  store.put('post', target.id, {
    ...target,
    title: payload.title, summary: payload.summary, body: payload.body,
    stationSlug: payload.stationSlug ?? null, modelSlug: payload.modelSlug ?? null,
    revision: (target.revision ?? 1) + 1,
    updatedAt: reviewedAt,
  });
  return;
}
```

注意三点：
- 这里必须重新校验 `baseRevision`：入队到审核之间可能又提交了一次编辑并先过审。`baseRevision` 随 payload 一起入队（`payload.baseRevision = expectedRevision`）。
- `TARGET_REMOVED` 要放进 `reviewSubmission` 的 `retriable` 列表吗？**不要**——目标删除不会自愈，让它落 `rejected` 并写 reason「目标文章已删除」，作者能在「我的投稿」看到。
- 权限：`submission.actorHandle` 来自入队时，物化时再查一次作者，防止 `actorHandle` 被篡改的历史行。

**(4) `supersedePending` 对编辑天然正确**：`kind !== 'station'` 走 originKey 分支，而编辑 originKey 含 postId → 同一篇文章的两次待审编辑互相替代，不会跨文章替代。**但要加一条**：编辑的 supersede 不能影响「创建」那条待审（originKey 不同，本来就无影响）——写用例锁住。

**(5) 自动通过**：`autoApproveEnabled` 为真时编辑立即物化，`status='approved'`。这等于「作者自己就能让自己改的正文上线」，与「编辑必须复审」冲突。建议：**编辑永不自动通过**——编辑入队时显式传 `pendingOnly: true`（与 `agent-api.ts` 对公开 Agent 入口的做法一致），而不是在 `enqueueSubmission` 里加隐式判断——与「Agent 入口永远 pending」同一思路（`agent-api.ts` 已经这么做了）。这条要写进 spec，否则 autopromise 开启时会静默绕过。

### 前端改动

- `web/src/pages/PostDetail.tsx`：作者本人时（`me.data?.handle === post.author.handle`）显示「编辑」按钮 → `/posts/:id/edit`。
- 新页面 `web/src/pages/PostEdit.tsx`：复用 `Submit.tsx` 的表单结构（抽出 `PostFields` 组件，避免两份 Markdown 预览逻辑），提交 `api.editPost(id, { ...form, expectedRevision: post.revision })`。
- 冲突处理：捕获 `ApiError.code === 'REVISION_CONFLICT'` → 弹「文章已被更新」并给「重新载入」按钮，**不要**自动重试（会覆盖别人的改动）。
- `MyPosts`（`Me.tsx:97`）卡片右上角加「编辑」入口；有 `pendingEditId` 时显示「编辑审核中」。
- `Me.tsx` 的「我的投稿」列表：编辑提交不能以「文章」形式出现（见冲突点 2），前端靠 `kind==='post' && !targetSlug` 无法区分，必须在服务端就过滤。
- 新 hook？不需要。`useAsync` 载入 post + 局部 state。

### 与既有逻辑的冲突点（这一节是 F2 的全部价值）

1. **`materialize` 的 post id 派生规则**：`web` 渠道当前是 `store.put('post', submission.id, …)`，即**投稿 id 就是文章 id**。如果编辑照旧走这条，`submission.id` 是新 uuid → 会**新建一篇重复文章**，而不是更新。这是必须加 `editOf` 分支的根本原因；也是「只加一个 PATCH 不改 submissions」这个想法必然失败的地方。
2. **`getMyPosts` 会把编辑呈现成一篇幽灵文章**：它把 `submissions where channel='web' and status in ('pending','rejected')` 全部 `queuedPost()`，编辑行的 `id` 是投稿 id、`payload` 里没有 `kind` 以外的完整结构（有，但 `publishedAt=createdAt`、`status=pending`）。结果：作者看到两篇同标题文章，点进去 404。修法：`getMyPosts` 的 pending 查询加 `AND json_extract(payload,'$.editOf') IS NULL`；`getMySubmissions` 同样加过滤（否则「我的投稿」里也出现一条）。
3. **配额被编辑吃掉**：`postsInLastHour()` 与 `pendingOwnPosts()` 都数 `kind IN ('post','model','station')`。编辑也是 `kind='post'` 的 web 投稿，作者改 10 次就发不了新文章、待审到 20 条就再也改不动。修法：两处都加 `AND json_extract(payload,'$.editOf') IS NULL`，另设编辑独立限流（5 次/小时，bucket `post-edit`）与「每篇最多 3 条待审编辑」。`GLOBAL_PENDING`（200）**不排除**编辑——它反映真实审核负荷，但要在注释里写明这个不对称，否则下一个人会以为是漏改。
4. **管理审核台把编辑显示成「新文章」**：`moderation.listPosts` 的 queued 分支把每条 web 投稿都当文章列。审核员会以为作者重复投稿，直接「通过」→ 若 `materialize` 里的 `editOf` 分支没写，就会造出重复文章。修法：`listPosts` 返回项加 `editOf` 字段，前端 `Admin.tsx` 显示「编辑 · 原文 #abcd1234」并链到原文；`POST /api/admin/posts/:id/review` 对编辑 id 要能转调 `reviewSubmission`（它已经会在 entities 里找不到时转队列，`moderation.ts:26-34`，天然可用）。
5. **`revision` 的可见性**：`PostSummary = Omit<Post,'body'>` 会带上 `revision`。列表多一个数字没有成本，但**不要**把它塞进 `pendingEditId`（那是详情专用，列表里算它要额外查询）。
6. **登录态相关**：`getPost` 对作者返回 `reviewReason`；编辑被拒后理由要能落到**原文**而不是幽灵投稿上。做法：`getPost` 里对作者额外查一次「该 post 最近一条 rejected 的编辑 submissions」，返回 `editReviewReason`（复用 `reviewReason` 字段更省，但会与文章自身的 rejected 语义混。建议新字段，明确来源）。
7. **飞书/Agent 文章不可编辑**：`source !== 'user'` 且 `authorHandle` 不是真账号 → 自然被 `authorHandle !== this.user` 挡住；但 `anonymous-submission` 与 demo 用户要显式给 `POST_SOURCE_CONFLICT`(409) 而不是 403，文案才说得清。

### 测试策略

- `server/test/post-edit.test.ts`（新，预计 20+ 用例）：
  - 通过编辑 → 原文仍在线、`pendingEditId` 非空、公开列表内容未变。
  - 审核通过 → 内容替换、`revision` +1、`publishedAt` 不变、`updatedAt` 变、**id 不变**（这条直接锁死「不新建文章」）、原有点赞/收藏/评论数不变。
  - 审核驳回 → 内容仍是旧版，作者在 `getPost` 看到理由。
  - `expectedRevision` 过期 → 409 + `currentRevision`。
  - 非作者 → 403；不存在 → 404；已删除 → 409 `POST_REMOVED`。
  - 相同内容重放 → `deduplicated: true`，submissions 行数不增。
  - 两次不同编辑 → 后者把前者 `superseded`。
  - **配额**：连续编辑 11 次不触发 `RATE_LIMITED` 的投稿限流（编辑用自己的桶）；待审 3 条后第 4 条 → 409。
  - **污染的回归**：`getMyPosts`/`getMySubmissions`/`GET /api/admin/posts?status=pending` 都不出现幽灵条目。
  - `route()` 合并 param 后，`POST /api/votes` 带多余 `id` 仍 400（防 strictObject 被绕过）。
  - 自动通过开启时编辑仍 pending。
- `web/test/post-edit.test.tsx`（新）：冲突提示分支、编辑审核中徽标、保存成功后详情页刷新。
- **变异验证**（针对最危险的四处）：
  - 删掉 `materialize` 的 `editOf` 分支 → 「id 不变」用例红（会变成新 id），这是最关键的一条变异。
  - 把 `payload.baseRevision` 校验去掉 → 「审核期间又改了一版」用例红。
  - 把 `publishedAt` 从 `target` 取改成 `reviewedAt` → 「hot 榜不被编辑刷分」用例红。
  - 把 `getMyPosts` 的 `editOf IS NULL` 去掉 → 幽灵条目用例红。

### 成本

**较大**：`submissions.ts` +130 行（materialize 分支、validatePayload、schema），`service.ts` +90（updatePost、getMyPosts/getMySubmissions 过滤、配额拆分），`app.ts` +45（route 修 + 新路由 + 限流器），`moderation.ts` +15，`shared` +40，web +160（新页面 + 表单抽取 + 详情按钮），Admin +30。合计 ~510 行 + 测试 ~420 行。**风险等级高**：它同时碰 schema 校验、队列物化、id 派生、配额、审核台五个面。

---

## F3. 文章删除（作者自删）

### 结论

复用 `removedAt` 软删除，但**必须区分「谁删的」**，否则管理员和作者共用一条标记会产生三种事故：作者删掉后管理员「恢复」等于违背作者意愿；作者删掉的正文永远留在库里没人清理；`GET /api/admin/posts/removed` 里分不清该不该救。

### 契约变更

```ts
deletePost: { method: 'DELETE', path: '/api/posts/:id' },
```

```ts
export type DeletePostRequest = EmptyRequest;   // route() 对 DELETE 读 body 为 ''，JSON.parse('{}') 通过 strictObject
export interface DeletePostResponse { id: string; removed: true }
```

错误码：`NOT_POST_AUTHOR`(403)、`POST_SOURCE_CONFLICT`(409，非本人来源)、`ALREADY_REMOVED`(409)。重复删除返回 409 而不是 200——与 `withdrawPost` 的既有语义一致（`moderation.ts:66`）。

### 数据模型

`entities` 加两列（**必须迁移**）：

```ts
// database.ts：把 ensureColumn 导出，或新增
export function ensureEntityColumns(store: Store) {
  store.transaction(() => {
    ensureColumn(store.db, 'removedBy', 'TEXT', 'entities');
    ensureColumn(store.db, 'removedReason', 'TEXT', 'entities');
  });
}
```

在 `openDatabase` 里**紧跟现有那段 `removedAt` 的 ALTER 之后**调用（`node-app.ts:33-36`），且必须在 `db.exec(SCHEMA)` 之前/无关——`entities` 上的索引不涉及这两列，所以顺序不敏感，但为了统一，放在 `hasEntities` 分支里更稳。同时把那句手写的 `ALTER TABLE entities ADD COLUMN removedAt` 一并收进 `ensureEntityColumns`，减少一处特例。

`Store.markRemoved(kind, id, at, options?)` 扩签名（向后兼容默认值 `'admin'`），并在 `restore` 时把两列清空。

### 服务端实现要点

- 新方法 `Service.deletePost(id)`：

```ts
removeOwnPost(id: string) {
  return this.store.transaction(() => {
    const post = this.store.get('post', id);                 // 在线才可删
    if (!post) throw new ApiError(404, 'NOT_FOUND', '文章不存在');
    if (post.authorHandle !== this.user) throw new ApiError(403, 'NOT_POST_AUTHOR', '只能删除自己的文章');
    // demo/submission/agent 内容不属于任何可登录账号；走到这里只可能是 user 来源
    const changed = this.store.markRemoved('post', id, this.now().toISOString(), { by: 'author' });
    if (!changed) throw new ApiError(409, 'ALREADY_REMOVED', '该文章已被删除');
    // 未物化的待审稿也要一起收掉，否则通过审核后文章会「复活」
    this.store.db.prepare(
      "UPDATE submissions SET status='superseded', reason=?, reviewedAt=? WHERE kind='post' AND channel='web' AND actorHandle=? AND status='pending' AND (id = ? OR json_extract(payload,'$.editOf') = ?)"
    ).run('作者已删除文章', this.now().toISOString(), this.user, id, id);
    return { id, removed: true as const };
  });
}
```

第 3 步是所有「自删」设计里最容易漏的：**删掉实体但不收队列**，下一次审核通过会把文章按 `submission.id` 重新物化出来——`materialize` 的写路径是 `store.put`，而 `put` 会把 `removedAt` 清成 NULL（`database.ts:232`）。这就是软删除与 `put` 的经典互斥，必须在同一个事务里同时处理队列。

- 不加限流：删除是幂等且不产生新内容，但有「删了再投、投了再删」的可刷性——第 3 步把待审收掉后会占用一次审核配额，已足够。可选加 `AttemptLimiter(10, 3600_000, 'post-delete')`。
- 管理员侧：`restorePost` 照旧可用，但 `GET /api/admin/posts/removed` 增加 `removedBy` 字段，管理台对 `author` 显示「作者自删（恢复将违背作者意愿）」。

### 前端改动

- `PostDetail.tsx`：作者本人显示「删除」按钮，二次确认（输入标题后 4 位或点两次「确认删除」），成功后 `navigate('/me?tab=posts')` + toast。不要用 `window.confirm`（`ErrorBoundary` 之外的浏览器原生弹窗会破坏移动端体验），用现有 `.card` + 内联确认条。
- `Me.tsx` 的 `MyPosts` 卡片加「删除」。
- 空态/加载态沿用 `AsyncView`。不需要新 hook。

### 与既有逻辑的冲突点

1. **`put` 会清 `removedAt`**（如上）。任何「先软删、后物化」的路径都要检查——包括飞书同步的下架守卫（`submissions.ts:812`）、`catalog.importCatalog` 的跳过逻辑（`catalog.ts:166`）。自删的文章属于 `source='user'`，飞书同步不会碰；但**运维全量导入不会重建 user 文章**（它删的是 `source='submission'` 集合），所以安全。
2. **评论变成不可达但不消失**：`getComments` 先 `requireTarget` → `readablePost` 用 `store.get` 看不到已下架 → 404。已存在的评论行仍在库里、仍占 `comments` 表空间，且 `interactionMap` 的 `countComments` 仍会把它们数进去（但因为文章不在列表里，无副作用）。**不要**顺手删评论：恢复文章时评论应原样回来。
3. **收藏计数**：`countVisibleFavorites` 已经排除 `removedAt != null` 的目标（`service.ts:370`），所以作者删文后别人的收藏数会掉 1——这是正确行为，但会让人以为「收藏丢了」。前端文案要写「文章已被作者删除」而不是「收藏失败」。注意 `getMyFavorites` 里有 `total = countVisibleFavorites()` 与 items 的同步口径，别在这里引入新的不一致。
4. **作者删文后点自己的旧链接**：`readablePost` 对已下架返回 undefined，作者也看不到 → 404。这是对的（删了就该 404），但要在前端给一个「这篇文章已被你删除」的友好页，靠 404 + 路由判断做不到，得在 `getPost` 里对作者返回 410 语义。**建议：不做 410，保持 404**，成本不值。
5. **`withdrawPost` 的 `source === 'demo'` 守卫**只对管理员生效；作者删自己的文章时不可能命中 demo（demo 用户没有账号），所以不需要复制这条判断，但要在代码注释里写清楚为什么不做。

### 测试策略

- `server/test/post-delete.test.ts`（新）：
  - 作者删 → 公开列表/搜索/详情 404，`/api/me/posts` 也没了（`getMyPosts` 用 `removedAt IS NULL`）。
  - 删后 `GET /api/admin/posts/removed` 里 `removedBy === 'author'`。
  - 删后同标题再投 → 新文章（新 id），旧内容不复活。
  - 删后**再审核一次 old pending** → 断言 `superseded`，不产生实体（这条是核心回归）。
  - 非作者删 → 403；重复删 → 409。
  - 删除后评论接口 404，但 `comments` 行数不变（恢复后评论回来）。
- **变异验证**：把 `markRemoved` 换成 `store.put` 一次空写 → 文章立刻复活；把第 3 步的 `UPDATE submissions` 删掉 → 「删后再审」用例红。

### 成本

**小改动**：`database.ts` +20（ensureEntityColumns、markRemoved 签名），`node-app.ts` +4，`service.ts` +35，`app.ts` +12，`moderation.ts` +8，`shared` +6，web +60。合计 ~185 行 + 测试 ~180 行。

---

## F4. 评论删除（第二高风险）

### 结论

不能硬删，也不能只加一列 `deletedAt` 了事。真正的约束是**只有一层回复** + **父评论是子评论的显示锚点**：父行没了，子评论就在 UI 上消失（`getComments` 用 `repliesByParent` 按 `parentId` 分组，顶层列表只有 `parentId IS NULL` 的行，`service.ts:781-797`）。所以设计成混合策略：

- **删除的叶子评论（无子回复）→ 物理 DELETE**。少一层墓碑，不污染计数。
- **删除的父评论（有可见子回复）→ 墓碑**：`deletedAt` 置位、`content` 清空，仍参与 `commentCount` 计数，UI 显示「该评论已删除」。
- **子回复全被删完之后，墓碑父行也一并物理删除**（同事务里一句 `DELETE`）。这条不变量让 `COMMENT_VISIBLE` 完全不用改——这是我最想要的结论：**计数谓词零改动**，只多一个展示态。

### 契约变更

```ts
deleteComment: { method: 'DELETE', path: '/api/comments/:id' },
```

```ts
export type DeleteCommentRequest = EmptyRequest;
export interface DeleteCommentResponse {
  id: string;
  /** 'deleted' 物理删除；'tombstoned' 保留了墓碑（还有回复）。 */
  result: 'deleted' | 'tombstoned';
  /** 与目标相关的可见评论数，供前端就地更新卡片。 */
  commentCount: number;
}
```

`Comment`/`CommentReply` 加 `deleted: boolean`（服务端始终返回，老客户端忽略）。错误码：`NOT_COMMENT_AUTHOR`(403)、`COMMENT_ALREADY_DELETED`(409)。

### 数据模型

`comments` 加列（**迁移**）：`deletedAt TEXT`、`deletedBy TEXT CHECK(deletedBy IN ('author','admin'))`。

```ts
export function ensureCommentColumns(store: Store) {
  store.transaction(() => {
    ensureColumn(store.db, 'deletedAt', 'TEXT', 'comments');
    ensureColumn(store.db, 'deletedBy', 'TEXT', 'comments');
    // 老库 CREATE TABLE IF NOT EXISTS 不会补这两列；已有 hidden 索引不受影响
  });
}
```

`hidden`（管理员隐藏）与 `deletedAt`（作者删除）**必须是两列**。合并成一列的后果：管理员隐藏了某条，作者再点一次删除会把它「取消隐藏」，等于作者能绕过审核。这是「看起来能复用」的典型误判。

### 服务端实现要点

```ts
deleteComment(id: string) {
  return this.store.transaction(() => {
    const row = this.store.db.prepare(
      'SELECT id,userHandle,targetType,targetId,parentId,content,hidden,deletedAt FROM comments WHERE id = ?'
    ).get(id) as CommentRow | undefined;
    if (!row) throw new ApiError(404, 'NOT_FOUND', '评论不存在');
    if (row.userHandle !== this.user) throw new ApiError(403, 'NOT_COMMENT_AUTHOR', '只能删除自己的评论');
    if (row.deletedAt) throw new ApiError(409, 'COMMENT_ALREADY_DELETED', '这条评论已删除');
    if (row.hidden) throw new ApiError(409, 'COMMENT_HIDDEN', '这条评论已被管理员隐藏');   // 语义清晰化，避免「删了却取消隐藏」
    const children = Number(this.store.db.prepare(
      'SELECT count(*) AS c FROM comments WHERE parentId = ? AND hidden = 0 AND deletedAt IS NULL'
    ).get(id)!.c);
    if (children === 0) {
      this.store.db.prepare('DELETE FROM comments WHERE id = ?').run(id);
    } else {
      this.store.db.prepare('UPDATE comments SET content = ?, deletedAt = ?, deletedBy = ? WHERE id = ?')
        .run('', this.now().toISOString(), 'author', id);
    }
    return { id, result, commentCount: this.visibleCommentCount(row.targetType, row.targetId) };
  });
}
```

注意：
- **物理删父行前必须确认没有子行**，否则 `PRAGMA foreign_keys = ON`（`node-app.ts:22`）会让 `DELETE` 直接抛 FK 约束错误，变成 500。`comments.parentId REFERENCES comments(id)` 没有 `ON DELETE` 子句 → 默认 NO ACTION → 有子行就删不掉。这就是 §5 坑 3。
- 删叶子回复时，若它的父是墓碑且这是**最后一条**可见子回复，要在同事务里删掉父行（否则墓碑变孤儿，计数多 1、列表多一条「已删除」）。用一句 `DELETE FROM comments WHERE id = (SELECT parentId FROM comments WHERE id = ?) AND deletedAt IS NOT NULL AND NOT EXISTS (SELECT 1 FROM comments c2 WHERE c2.parentId = comments.id AND c2.hidden = 0 AND c2.deletedAt IS NULL)`——**注意 `ON DELETE` 顺序**：先删子再删父，同一事务内可行。
- **`content = ''` 要真的清空**：作者删除是隐私动作，留着原文「以备恢复」不成立（用户预期是删了）。恢复入口也不提供。
- 限流：不需要（幂等、不产内容）。评论本身的 5 条/分钟不动。

### 前端改动

- `Comments.tsx`：`me.data?.handle === comment.author.handle` 时显示「删除」；`deleted` 的项渲染 `<p className="comment-deleted">该评论已删除</p>` 并隐藏回复按钮；删除父评论后仍显示其 replies（墓碑作为锚点）。
- 删除成功后：`paged.setData` 就地替换（`usePaged` 暴露了首屏 `data`，但没有 setData；改用局部 `deletedIds` 集合，与现有 `added` 的写法一致——**不要**改 `usePaged` 的 API，它被 7 个页面共用）。
- `commentCount` 就地更新：列表页卡片上的数字是快照，不追也可以（下次加载会更新）；详情页可 `me.refreshMe()`? 不行，评论数不在 me 里。**接受快照不更新**，但要在 `DeleteCommentResponse` 里返回计数，给未来留口子。

### 与既有逻辑的冲突点（四处口径必须同步）

`COMMENT_VISIBLE` 被用在 3 个地方，`getComments` 行过滤是第 4 处：

| 位置 | 现状 | 改后 |
|---|---|---|
| `service.ts:60` 常量 | `hidden = 0 AND (parentId IS NULL OR parentId NOT IN (SELECT id FROM comments WHERE hidden=1 …))` | **不改**（墓碑父行仍算可见，因为它的子回复要露出来；墓碑无子行的情况已被「子全删则删父」的不变量排除） |
| `interactionMap` (180) | 用常量 | 不改 |
| `interaction` (222) | 用常量 | 不改 |
| `countComments` (712) | 用常量 | 不改 |
| `getComments` (781) | `hidden = 0` | 改为 `hidden = 0`（**仍不加 deletedAt 条件**），额外 `SELECT deletedAt` 给 DTO |

这个「不改」不是偷懒，而是靠不变量换来的；必须在代码注释里写清楚**为什么**能不改，否则下一个人会以为漏了过滤而补一个 `deletedAt IS NULL`，结果所有带回复的删除评论连同子回复一起消失。

其他冲突：
1. **`getComments` 的 `total`**：`paginateThen(tops, …)` 的 `total` 是顶层评论数。墓碑父行计入顶层 → total 不变；但如果「删父时子也被删」走的是硬删路径，total 会掉 1，而卡片上的 `commentCount`（含回复）也会掉 1，前端 `hasMore` 用 `data.length < total` 判定，两者都是同一事务后的值，一致。
2. **管理员 `setCommentHidden` 与作者的 `deletedAt` 交叉**：管理员隐藏一条墓碑评论 → `hidden=1` 后它不再可见（符合预期）；管理员恢复隐藏 → 墓碑重新可见，仍显示「已删除」。行为正确，但要有用例锁。
3. **举报（F6）指向已删评论**：`createReport` 的 `requireTarget` 对 comment 要能识别墓碑，否则「已删除的评论」举报会 404 → 用户以为系统坏了。

### 测试策略

- `server/test/comments-delete.test.ts`（新）：
  - 删无回复的评论 → 行真的没了（`SELECT count(*)` 断言）。
  - 删有回复的评论 → 行还在、`content=''`、`deletedAt` 非空；`getComments` 仍返回该顶层项且 `deleted: true`，其 replies 完整。
  - 删最后一条回复 → 墓碑父行被一起删掉，`commentCount` 归零。
  - 删回复但有兄弟回复 → 只删自己，父行保留墓碑。
  - 非作者删 → 403；重复删 → 409；管理员隐藏后作者删 → 409 `COMMENT_HIDDEN`。
  - `commentCount` 在列表接口与详情接口上一致（用 `GET /api/posts/:id` 与 `GET /api/comments` 双向核对）。
- **变异验证**（每条都对应一个真实 bug 形态）：
  - 把「子行数 > 0 才墓碑」改成「一律 DELETE」→ FK 约束 500 用例红。
  - 把「子全删则删父」去掉 → 计数与列表条数对不上的用例红。
  - 把删除条件里的 `deletedAt` 判断去掉（允许重复删）→ 409 用例红。
  - 用 `hidden` 冒充 `deletedAt` → 「管理员隐藏后作者删」用例会静默成功，红。

### 成本

**中等**：`database.ts` +15，`service.ts` +55（deleteComment、visibleCommentCount、getComments DTO），`app.ts` +10，`shared` +12，web +55（Comments.tsx），`moderation.ts` 0。合计 ~150 行 + 测试 ~260 行。主要是测试贵，代码不贵——这个 feature 的难度全在边界。

---

## F5. 头像

### 结论

**只做预设头像，不做上传、不做外链。** 三个理由：

1. 上传要对象存储或 BLOB。Base64 塞进 `entities.user.data` 是"最省事但最贵"的方案：`Author = Pick<User,'handle'|'nickname'|'avatar'>`（`domain.ts:54`）会被塞进每一篇文章、每一条评论的响应。64KB 头像 × 20 条列表 = 1.2MB 响应，而 `PostCard` 根本不需要它。这一点在 §5 坑 4 展开。
2. 外链 URL 会被 CSP 直接拦掉：`img-src 'self' data:`（`static.ts:12`）。放开 `https:` 等于让每个用户往页面里注入第三方请求（打点、追踪、盗图），还会带来 NSFW 内容审核负担。要开就得同时做「图片代理 + 缓存 + 审核」，这不是头像功能，是一个新子系统。
3. **现状已经是一个可用的头像系统**：`Avatar`（`visuals.tsx:55`）按昵称哈希取 8 个强调色之一的字母徽章，零字节、零请求、不可伪造。缺的只是「用户能选」。

所以真实需求是：**让用户在一个受控集合里选一个样式**。

### 契约变更

不加路由——`PATCH /api/me` 已经存在，只扩字段：

```ts
export const AVATAR_KEYS = ['seal', 'leaf', 'wave', 'gear', 'moon', 'spark', 'ink', 'rock'] as const;
export type AvatarKey = typeof AVATAR_KEYS[number];
/** 约定：'' = 按昵称自动生成的字母徽章；'preset:<key>' = 用户选的预设。 */
export type AvatarValue = '' | `preset:${AvatarKey}`;

export interface UpdateMeRequest {
  nickname?: string;
  bio?: string;
  avatar?: AvatarValue;    // 新增
}
```

错误码复用 `INVALID_INPUT`(400)。`User.avatar: string` 类型不变（保持向后兼容），只是值域收紧。

### 数据模型

**零迁移。** `entities.user.data.avatar` 已经在，`''` 的含义不变。历史数据（全部 `''`）天然是「自动徽章」。

### 服务端实现要点

- `app.ts` 的 `updateMe` schema 加 `avatar: z.enum(AVATAR_KEYS.map(k => `preset:${k}`).concat('')).optional()`。用**枚举白名单**而不是 `z.string().max(64)`：头像字符串最终会进 `style`/`src` 上下文，白名单是唯一不用做转义的防线。
- `Service.updateMe` 里 `store.put('user', handle, { ...user, ...input })` 已经能带上新字段；注意 `updateMe` 的 `.refine(input => Object.keys(input).length > 0)` 仍然成立。
- 不要新增 `GET /api/avatars`：取值来自 `shared` 常量，前端直接 import（与 `PROFILE_LIMITS` 同一思路，`domain.ts:242` 的注释已经解释了为什么放 shared）。
- 与 F2/F3 的交互：`Author` 里带 `avatar`，编辑/删除文章都不会改作者资料；`service.author()` 直接返回即可。

### 前端改动

- `visuals.tsx` 的 `Avatar` 加可选 `avatar?: string` 参数：`preset:` 前缀命中白名单 → 渲染内置 SVG/符号 + 对应强调色；否则退回现有字母徽章。**保持 `aria-hidden`**（现有实现把头像对读屏隐藏，昵称在旁边）。
- 调用点（8 处）：`Me.tsx:209`、`PostDetail.tsx:36`、`Comments.tsx:90,106`、`PostCard.tsx`、`UserCard.tsx`、`RankingBoard.tsx`、`Layout.tsx`。大部分只有 `nickname`，需要把 `author.avatar`/`user.avatar` 传进来；`Author` 已含 avatar，不用改契约。
- `Me.tsx` → `Settings` 加一个「头像」选择器（8 个方形按钮，选中态描边），保存时随 `updateMe` 一起提交。
- 不需要新 hook。

### 与既有逻辑的冲突点

1. **`UserCard` 现有两处硬编码 `<span className="user-avatar" />`**（`UserCard.tsx:92,135`），是纯 CSS 占位。改头像时必须一起改，否则同一页面上「首页用户卡」和「个人中心」头像不一致——这种不一致最难被发现。
2. **`demo` 用户的头像**：种子用户 `avatar: ''`，若前端允许选预设，demo 用户永远显示自动徽章。没问题，但别在种子里写 `preset:`，那会让演示数据看起来像"被配置过"。
3. **`Author` 里的 avatar 对所有读者可见**（包括未登录）。预设值本身无害；但**如果将来改主意做外链**，就等于提供了一个匿名用户可控的图片 URL 全站广播——这也是我建议现在就把值域锁死在枚举上的原因。

### 测试策略

- `server/test/profile-avatar.test.ts`（新，或并入 `api.test.ts`）：合法 key 通过；`preset:evil` 400；超长字符串 400；空串 = 恢复自动；`GET /api/posts` 里的 `author.avatar` 随之更新。
- `web/test/avatar.test.tsx`（新）：已知 key 渲染对应图形；未知/空值退回字母徽章；选择器保存后 `refreshMe`。
- **变异验证**：把 `z.enum` 换成 `z.string()` → 恶意值用例红；把 `Avatar` 的 fallback 删掉 → 未知 key 用例红（会渲染空白）。

### 成本

**小改动**：`shared` +12，`app.ts` +6，`service.ts` +2，web +90（组件 + 8 处调用 + 选择器）。合计 ~110 行 + 测试 ~120 行。

---

## F6. 举报

### 结论

做，但**只做「收集 + 人工处置」**，不做自动下架。自动下架（N 条举报 → 隐藏）是最省事也最危险的一条路：它把「内容是否违规」的判定权交给了一群匿名用户，而本站的核心资产是**评价的可信度**——竞品完全可以组织 5 个账号举报掉一条差评。判定权必须在人手里。

三个产品约束要写进 spec：
1. 举报计数**绝不公开**（不显示"3 人举报"，否则形成从众压力 + 可被当作攻击展示）。
2. 处置动作与管理接口完全复用（`setCommentHidden` / `withdrawPost` / `removeStation`），举报只是**发现渠道**，不引入第二套下架逻辑。
3. 不接受「举报后自动通知被举报人」（会激化对立，且泄露举报者）。

### 契约变更

```ts
createReport: { method: 'POST', path: '/api/reports' },
```

```ts
export type ReportReason = 'spam' | 'fake-metrics' | 'plagiarism' | 'abuse' | 'other';

export interface CreateReportRequest {
  targetType: 'post' | 'comment' | 'station';
  targetId: string;
  reason: ReportReason;
  /** 补充说明，0~500 字。 */
  detail?: string;
}
export interface CreateReportResponse { id: string; createdAt: ISODateTime }
```

`API_ROUTES` 里 `target` 常量目前只支持 `post|station`（`app.ts:46`），举报要单独声明支持 `comment`——**不要**去改那个共享常量，否则投票/收藏接口会接受 `comment` 然后在 `requireTarget` 里抛奇怪错误（`votes` 表的 CHECK 也只允许 post/station）。

错误码：`ALREADY_REPORTED`(409)、`SELF_REPORT`(400)、`TARGET_REMOVED`(409)、`RATE_LIMITED`(429)。

管理路由（不进契约，`Authorization: Bearer`）：
- `GET  /api/admin/reports?status=open|accepted|rejected&targetType=&page=&pageSize=`
- `POST /api/admin/reports/:id/review` body `{ decision: 'accepted'|'rejected', action?: 'hide-comment'|'withdraw-post'|'remove-station'|'none', reason?: string }`

### 数据模型

```sql
CREATE TABLE IF NOT EXISTS reports (
  id           TEXT PRIMARY KEY,
  reporterHandle TEXT NOT NULL,
  targetType   TEXT NOT NULL CHECK(targetType IN ('post','comment','station')),
  targetId     TEXT NOT NULL,
  reason       TEXT NOT NULL CHECK(reason IN ('spam','fake-metrics','plagiarism','abuse','other')),
  detail       TEXT,
  status       TEXT NOT NULL CHECK(status IN ('open','accepted','rejected')) DEFAULT 'open',
  resolution   TEXT,
  reviewedBy   TEXT,
  createdAt    TEXT NOT NULL,
  reviewedAt   TEXT
);
CREATE INDEX IF NOT EXISTS reports_status ON reports(status, createdAt);
CREATE INDEX IF NOT EXISTS reports_target ON reports(targetType, targetId);
-- 同一个人对同一目标只能有一条未处理举报；处理完后可以再报（内容可能又变了）
CREATE UNIQUE INDEX IF NOT EXISTS reports_open_unique
  ON reports(reporterHandle, targetType, targetId) WHERE status = 'open';
```

那条**部分唯一索引**是这块的关键设计：普通 `UNIQUE(reporter,targetType,targetId)` 会让「举报被驳回后不能再举报」「内容改了也不能再报」——看起来只是个小气，实际是让举报功能对持续作恶完全失效。SQLite 支持带 `WHERE` 的部分索引，正好表达「只在 open 状态去重」。

### 服务端实现要点

- `Service.createReport`：
  1. `requireTarget` 扩展一个 `'comment'` 分支（新私有方法 `requireReportTarget`）：comment 必须存在且 `hidden = 0` 且 `deletedAt IS NULL`；墓碑评论报 409 `TARGET_REMOVED`。
  2. 自己举报自己的内容 → 400 `SELF_REPORT`（比较 `userHandle` / `authorHandle`）。
  3. 限流：`new AttemptLimiter(5, 3_600_000, store, 'report-user')` + 每账号每天 20 条（用一条 `count(*)` + 索引 `(reporterHandle, createdAt)`——需要加 `CREATE INDEX reports_reporter ON reports(reporterHandle, createdAt)`）。5/小时挡不住脚本，20/天是真正的天花板。
  4. 插入：唯一索引冲突（`SQLITE_CONSTRAINT`）→ 409 `ALREADY_REPORTED`。不要先 `SELECT` 再插入（跨请求 TOCTOU + 多一次查询），直接靠约束，捕获特定错误码转 ApiError。**注意**：`isDatabaseBusyError` 只处理 BUSY，约束错误需要单独判断 `String(error).includes('UNIQUE constraint failed: reports.')`——这有点脆，更稳的是 `SELECT 1 FROM reports WHERE … AND status='open'` 在事务内查一次再插（事务是 `BEGIN IMMEDIATE`，天然串行），二选一，我推荐后者（可读性 > 一次索引查找）。
  5. `console.info` 记录一条不含 detail 的事件（detail 可能含个人信息）。
- 管理端 `reviewReport`：一个事务里 `UPDATE reports` + 按 `action` 调用对应既有函数。`action` 与 `targetType` 不匹配 → 400。`withdraw-post` 复用 `withdrawPost`（它会抛 `POST_SOURCE_CONFLICT` 对 demo，正确）。**处置失败要整体回滚**，不能让举报标记为 accepted 但内容还在线。
- 与 F7 的关系：举报被处置后给举报者一条通知（可选，见 F7 的 event 类型）。**建议一期不做**，减少耦合。

### 前端改动

- 新组件 `web/src/components/ReportButton.tsx`：`<details>` 或轻量 dialog，选择 reason（单选）+ detail（≤500）+ 提交；未登录点击跳 `loginPath(here)`（复用 `useRequireLogin`）。
- 挂载点：`PostDetail.tsx`（文章脚部）、`StationDetailPage`（`Stations.tsx` 里）、`Comments.tsx`（每条评论/回复的「举报」文字按钮，与「回复」并列）。
- 管理台 `Admin.tsx`：新增第 6 个 tab「举报」，列表 + 「处置」下拉（隐藏评论/下架文章/下架站点/仅驳回）。`web/src/admin.ts` 加两个函数。
- 不需要新 hook。

### 与既有逻辑的冲突点

1. **`target` 的 CHECK 约束**：`votes`/`favorites` 表 CHECK 只允许 post/station。举报表自己允许 comment，别顺手把 `TargetType` 扩成三值——那会让 `PutVoteRequest` 也接受 comment，而 `requireTarget` 会 404 得莫名其妙。
2. **举报一个「只在 submissions 里的待审稿」**：`readablePost` 只对作者本人返回待审稿，别人读不到 → 404。这是对的（别人看不到的东西不能举报），不做特殊处理。
3. **同一目标多条举报的聚合**：管理列表需要「按目标聚合，显示 N 条举报」，但 `listReports` 分页是按行分页的。一期**不做聚合**（站点规模小），列表显示每行带目标链接即可；写进"以后再做"清单。
4. **被举报内容消失后**：`withdrawPost` 后其他 open 举报仍指向它，处置时 `withdrawPost` 会抛 `ALREADY_REMOVED`(409)。管理端要么允许批量「标记为完成」，要么在 `reviewReport` 里把 `ALREADY_REMOVED` 视为成功（幂等）。选后者，写用例。

### 测试策略

- `server/test/reports.test.ts`（新）：
  - 三种 target 各报一次成功。
  - 重复报同目标 → 409；**处置完后再报 → 200**（这条专测部分唯一索引）。
  - 自报 → 400；报已删评论 → 409；未登录 → 401。
  - 6 次/小时 → 429，带 `retry-after`。
  - 管理处置 `hide-comment` → 评论 `hidden=1` 且 report `accepted`；`action` 与 target 不匹配 → 400；目标已删 → 幂等成功。
  - 举报详情不出现在任何公开接口（`GET /api/posts` 里不含 report 字段）。
- **变异验证**：把 `WHERE status='open'` 从唯一索引去掉 → 「驳回后再报」用例红；把 `SELF_REPORT` 判断去掉 → 自报用例红；把 `reviewReport` 的处置失败回滚去掉 → 状态与内容不一致用例红。

### 成本

**中等**：新文件 `reports.ts` ~130 行，`service.ts` +50，`app.ts` +45（1 公开 + 2 管理），`shared` +25，`Admin.tsx` +70，`ReportButton` +55，挂载 3 处 +15。合计 ~390 行 + 测试 ~280 行。

---

## F7. 关注 / 站内通知（结构风险最高）

### 结论

**必须用拉模型（pull），不能写扩散（fan-out）。** 这是本文最重要的一个工程判断。

写扩散 = 每次发文章/发评论，给每个粉丝插一条通知行。在 MySQL + 异步队列里这是标准做法；在**单进程 + 同步 SQLite + BEGIN IMMEDIATE** 里它是灾难：一个 5000 粉的作者发一篇文章，就是同一事务内 5000 条 `INSERT`，期间整个进程的事件循环被占住，`/api/health` 都要排队（`README.md:369` 已经记录过 500 条批量审核阻塞 8 秒的实测）。而本站的规模是 13 个站点、49 篇文章——为了一个还不存在的规模，付一个必然发生的性能事故，完全不划算。

拉模型 = 只写一条**事件**，读取时按「我关注了谁」现算。零写放大，代价是读路径要做一次索引范围扫描（`events` 按 actor 分组）。

### 契约变更

```ts
followAuthor:       { method: 'PUT',  path: '/api/follows' },
getMyFollows:       { method: 'GET',  path: '/api/me/follows' },
getNotifications:   { method: 'GET',  path: '/api/me/notifications' },
readNotifications:  { method: 'POST', path: '/api/me/notifications/read' },
```

```ts
export interface FollowState {
  handle: string;
  following: boolean;
  followerCount: number;
  postCount: number;
}
export interface PutFollowRequest { handle: string; following: boolean }
export type PutFollowResponse = FollowState;

export type FollowListKind = 'following' | 'followers';
export interface GetMyFollowsRequest extends PaginationQuery { kind: FollowListKind }
export type GetMyFollowsResponse = PaginatedResponse<FollowState>;

export type NotificationType = 'post.published' | 'post.updated' | 'comment.created' | 'follow.created' | 'report.resolved';
export interface Notification {
  /** 事件的单调递增 id，同时是游标。 */
  id: number;
  type: NotificationType;
  actor: Author;
  /** 目标摘要快照：目标可能已被删除，列表仍要能显示。 */
  title: string;
  href: string | null;
  createdAt: ISODateTime;
}
export interface GetNotificationsRequest {
  /** 上次读到的事件 id；不传表示从最新开始（返回空 + nextCursor）。 */
  since?: number;
  pageSize?: number;
}
export interface GetNotificationsResponse {
  items: Notification[];
  /** 下一次请求带上它。 */
  nextCursor: number;
  unreadCount: number;
}
export interface ReadNotificationsRequest { upTo: number }
export interface ReadNotificationsResponse { unreadCount: number }
```

`CurrentUser` 加 `unreadCount: number`（`getMe` 返回，首页小红点靠它）。

错误码：`CANNOT_FOLLOW_SELF`(400)、`FOLLOW_TARGET_INVALID`(400)。

### 数据模型

```sql
CREATE TABLE IF NOT EXISTS follows (
  followerHandle TEXT NOT NULL,     -- 关注者
  followeeHandle TEXT NOT NULL,     -- 被关注者
  createdAt      TEXT NOT NULL,
  PRIMARY KEY (followerHandle, followeeHandle)
);
CREATE INDEX IF NOT EXISTS follows_followee ON follows(followeeHandle, createdAt);
CREATE INDEX IF NOT EXISTS follows_follower ON follows(followerHandle, createdAt);

-- 通知事件：一条内容变更一行，与粉丝数无关
CREATE TABLE IF NOT EXISTS notification_events (
  id            INTEGER PRIMARY KEY,           -- rowid 别名，天然单调
  type          TEXT NOT NULL CHECK(type IN ('post.published','post.updated','comment.created','follow.created','report.resolved')),
  actorHandle   TEXT NOT NULL,                 -- 触发者
  subjectHandle TEXT,                          -- 天然接收者（文章作者/被评论人/被关注人）
  targetType    TEXT NOT NULL CHECK(targetType IN ('post','comment','station','user')),
  targetId      TEXT NOT NULL,
  title         TEXT NOT NULL,                 -- 快照，目标删了也能显示
  href          TEXT,
  createdAt     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_subject ON notification_events(subjectHandle, id);
CREATE INDEX IF NOT EXISTS events_actor   ON notification_events(actorHandle, id);
CREATE INDEX IF NOT EXISTS events_created ON notification_events(createdAt);

CREATE TABLE IF NOT EXISTS notification_cursors (
  handle      TEXT PRIMARY KEY,
  lastEventId INTEGER NOT NULL,
  updatedAt   TEXT NOT NULL
);
```

**为什么 `id` 用 `INTEGER PRIMARY KEY` 而不是 `AUTOINCREMENT`**：这里 `INTEGER PRIMARY KEY` 就是 rowid 别名，单调递增且省掉 `sqlite_sequence` 表与一次额外写。软删除/回滚不会让 id 复用（SQLite 的 rowid 分配在未达 max 时可能复用被删的 id，但事件表不做删除，只在 purge 时按 createdAt 删旧行——所以要么保留 AUTOINCREMENT，要么接受极小概率的 id 复用导致游标错位）。**结论：用 `AUTOINCREMENT`**，一行代价换掉一类隐蔽 bug（purge 删了最大 id 后再分配同 id，用户游标 `since=100` 会永远跳过新事件）。这条值得单独注释。

索引设计的三条读路径：

1. **我关注的人做了什么**：`WHERE actorHandle IN (SELECT followeeHandle FROM follows WHERE followerHandle = ?) AND id > ?` → 用 `events_actor`。
2. **别人对我的内容做了什么**：`WHERE subjectHandle = ? AND id > ?` → 用 `events_subject`。
3. **未读数**：上面两路 `count(*)`（索引覆盖，不读表）。

`IN (子查询)` 在关注数少时是 N 次索引 range scan；`SQLite` 会把它变成 `SEARCH notification_events USING INDEX events_actor (actorHandle=?)`，N = 关注数。**这就是性能墙**：关注 200 人 × 每人 50 条事件 = 最多 10000 行候选，`ORDER BY id DESC LIMIT 20` 时 SQLite 无法用单一索引合并两路，必须 `UNION ALL` 两段各自 `ORDER BY/LIMIT 20` 再归并：

```sql
SELECT * FROM (
  SELECT * FROM notification_events
   WHERE id > :since AND actorHandle IN (SELECT followeeHandle FROM follows WHERE followerHandle = :me)
   ORDER BY id DESC LIMIT :n
) UNION ALL
SELECT * FROM (
  SELECT * FROM notification_events
   WHERE id > :since AND subjectHandle = :me
   ORDER BY id DESC LIMIT :n
) ORDER BY id DESC LIMIT :n;
```

每段各自走索引、各自 LIMIT，归并在 40 行内完成——这是拉模型唯一正确的写法。直接写 `WHERE a OR b` 会让 SQLite 放弃索引（OR 优化在跨两个索引时可用，但带子查询就退化成扫描）。**必须写 `EXPLAIN QUERY PLAN` 用例断言出现两次 `SEARCH … USING INDEX`**。

### 服务端实现要点

- 事件写入统一走一个函数：`recordEvent(store, {type, actor, subject, target, title, href, now})`，在**已有事务内**调用（不自己开事务）。挂载点 4 处：`materialize` 的 post 分支（`post.published` / `post.updated`）、`createComment`（`comment.created`，subject = 文章/站点作者）、`putFollow`（`follow.created`，subject = 被关注者）、`reviewReport`（`report.resolved`，subject = 举报人）。
- **自己触发的事件不写**（`actor === subject` 或 `actor === me` 在读取时过滤）：在写入时判断更省，但 `subject` 只有作者有，粉丝聚合路径里"我自己关注了我自己"不可能（禁止自关注）。读取时统一 `WHERE actorHandle <> :me` 最稳，一次条件不花钱。
- **关注不产生事件扇出**：`follow.created` 只写一行，接收者是**被关注者**（"X 关注了你"）。
- 限流：`followAuthor` 用 `AttemptLimiter(60, 3_600_000, 'follow')`（关注/取关是高频小写，但每次两条索引变更，挡一下脚本）。`readNotifications` 不加限流（纯读，且 `BEGIN DEFERRED`）。
- 通知读取用**只读事务**：`listSubmissions` 那段注释（`submissions.ts:352-358`）已经讲明白了——纯读不要 `BEGIN IMMEDIATE`，否则有人在写时整个通知列表 503。`Store` 只暴露 `inTransaction()`，没有 `readTransaction()`；需要新增一个 `readTransaction<T>(fn)`（`BEGIN DEFERRED`），并在 `inTransaction()` 为真时直通。这是对 `node-app.ts` 的一个小扩展，`listSubmissions` 可以顺带迁移过去（但它现在自己手写了 `BEGIN DEFERRED`，不建议一并改，缩小 diff）。
- `getMe` 加 `unreadCount`：一条 `count(*)`，两个索引路径。**必须**在 `getMe` 里做，而不是单独一个接口——首页红点每次加载都要用。注意 `getMe` 已经是 4 条查询，这条会变成 5 条；如果后面再加，应该合并成一个 `SELECT` 子查询集合。
- 清理：`purgeExpired`（`auth.ts:201`）加一句 `DELETE FROM notification_events WHERE createdAt <= ?`（保留 90 天），并删掉 `createdAt` 早于 90 天、`lastEventId` 落在被删区间之前的游标？**不需要**：游标只增不减，事件被删后 `since` 变小也没关系（`id > since` 依然正确）。这一点要想清楚，否则会写出"同步游标"这种脆逻辑。

### 前端改动

- 新 hook `web/src/hooks.ts` 加 `useNotifications()`：`useAsync` 取首页 + `loadMore` 用 `since=nextCursor`（**不能用 `usePaged`**，它的 `page` 语义是页码，游标更合适；或者只做"最近 20 条 + 已读"的一期版本，先不做无限滚动）。
- `Layout.tsx` 顶栏加铃铛 + 未读数（`me.unreadCount`），点开下拉面板 → 新页面 `/notifications`（`web/src/pages/Notifications.tsx`，`AsyncView` + 空态 + 已读按钮）。
- `PostDetail.tsx` 作者行加「关注 / 已关注」按钮（`useState` 本地切换 + `api.followAuthor`）；评论作者同样可关注？**一期只做文章作者**，减少挂载点。
- 个人中心 `Me.tsx` 加 tab「关注」（两个列表：我在关注 / 关注我的）。
- 已读：进入 `/notifications` 后 `POST /api/me/notifications/read { upTo: nextCursor }`，然后 `me.refreshMe()` 更新红点。

### 与既有逻辑的冲突点

1. **`getMe` 的开销**：`getMe` 是首屏最高频的接口（每次页面加载 + `signIn`/`refreshMe`）。加 `unreadCount` 必须走索引，且**不能**在 `/api/me` 里再拼一个通知列表。建议给 `getMe` 加一条 `EXPLAIN` 基线用例（现有 4 条查询 1000 用户时 < 5ms，新查询必须 < 1ms）。
2. **没有作者主页**：`getPosts` 没有 `author` 参数，前端也没有 `/users/:handle`。关注了作者却没地方看他的文章，体验是断的。**一期接受这个断点**（关注按钮 + 通知已能闭环：他发文 → 我收到通知），作者主页写进"以后再做"。若要做，最小改动是给 `GetPostsRequest` 加 `author?: string` 并在 `approvedPosts()` 的过滤里加一条——但那会新增一个公开查询参数，属于契约变更，不与本功能混做。
3. **通知指向已删除内容**：`href` 是快照，点进去 404。可接受，但 `Notification.title` 必须是**写入时的快照**（不是 JOIN 现查），否则删除后整条通知渲染不出来。
4. **注销（F10）**：`follows` 两个方向都要删；`notification_cursors` 删；`notification_events` 里 `actorHandle`/`subjectHandle` 要跟着匿名化重写，否则注销后仍能从通知里点到"已注销用户"的旧 handle（不是安全问题，但会产生悬空链接）。建议：注销时**删除**该 handle 的 events（`actorHandle = ? OR subjectHandle = ?`），而不是重写——通知是易失数据，删掉最干净。
5. **`reviewReport` 写事件**：管理端处置会产生 `report.resolved` 通知给举报者。这会让举报者知道"我举报的内容被处理了"，但**不能**透露是被举报内容被删了还是举报被驳回（避免反过来用于探测）。文案统一为「你的举报已处理」。
6. **`store.entityVersion`**：通知事件不参与实体缓存，不要误用 `invalidate()`。

### 测试策略

- `server/test/follows.test.ts`（新）：关注/取关幂等（重复 PUT 同一个值不报错、计数不变）；自关注 400；计数正确；`follows` 分页；不存在的 handle → 400。
- `server/test/notifications.test.ts`（新，本功能的主战场）：
  - A 关注 B，B 发文章 → A 的 `getNotifications` 有 1 条；C（未关注）没有。
  - 自己发文章不给自己通知。
  - 游标：读完后 `read {upTo}` → `unreadCount` 归零；再来一条 → 只返回新的一条。
  - 评论：B 的文章被 A 评论 → 文章作者收到（subject 路径），即使 A 没有粉丝。
  - **两路合并去重**：A 关注 B 且 B 评论了 A 的文章（A 既是 follower 又是 subject）→ 只应出现一次（`UNION ALL` 会出两次，必须靠 `GROUP BY id` 或应用层去重——这是最容易被漏的 bug）；**建议不合并**：这类事件语义不同（"你关注的人发了新文章" vs "有人评论了你的文章"），出现两条可以接受，但要在用例里**显式断言为 2 条**并注释原因，否则未来有人加去重会破坏语义。
  - `EXPLAIN QUERY PLAN` 断言命中两个索引（用 `store.db.prepare('EXPLAIN QUERY PLAN …')`）。
  - 通知指向已删除文章：标题仍显示、href 仍返回、点开 404。
- `web/test/notifications.test.tsx`（新）：红点、已读后清零、空态。
- **变异验证**：
  - 把 `UNION ALL` 内层两段的 `ORDER BY id DESC LIMIT` 去掉 → 大粉丝量下的性能用例（构造 200 条事件 + 断言 `EXPLAIN`）会退化成扫描；同时"只返回最新 20 条"的用例红。
  - 把 `actorHandle <> me` 去掉 → 自己给自己通知用例红。
  - 把 `readNotifications` 的 `upTo` 改成"全部已读" → 游标用例红。
  - 把事件写入从 `materialize` 挪到「审核通过后」但忘了编辑分支 → 编辑不产生通知的用例红（先写用例再实现）。

### 成本

**较大**：`notifications.ts` 新文件 ~180 行，`follows.ts` ~90，`service.ts` +80，`app.ts` +55，`database.ts` +45，`node-app.ts` +15（readTransaction），`shared` +60，web +200（页面 + hook + 铃铛 + 关注按钮 + tab）。合计 ~725 行 + 测试 ~400 行。

---

## F8. 站点对比

### 结论

**需要新接口，不是纯前端。** 纯前端确实能跑（`GET /api/stations/:slug` 已经返回全部 offers），但有三个具体问题：

1. **N 次请求 + 客户端连接**：3 个站 = 3 个详情请求，每个都带互动数据（投票/收藏/评论/涉及全站聚合）。对比表只需要 `offers` 和几个站点字段，这些请求 90% 的字节是浪费。
2. **口径分组的逻辑会分叉**：`sortOffersForDisplay` 的排序（先按 basis 分组、组内按 rate）在服务端已经有了（`service.ts:148`），前端再实现一份必然漂移——而"同一口径才能比价"是本站的数据诚信硬约束（`spec.md:25`）。
3. **"并排"需要模型对齐**：A 站报 gpt-4-1 和 claude-sonnet，B 站只报 gpt-4-1。要生成一张表，需要「模型的并集 + 每站在每个模型上的位置」，这是服务端一次 JOIN 的活，客户端做是 O(站×模型) 的拼装。

一个接口解决，且几乎全是复用。

### 契约变更

```ts
compareStations: { method: 'GET', path: '/api/stations/compare' },
```

```ts
export interface CompareStationsRequest {
  /** 逗号分隔的 slug，2~3 个。 */
  slugs: string;
}
export interface CompareCell {
  stationSlug: string;
  /** 该站在该模型上没有报价时为 null——不是 0，不编造。 */
  rate: number | null;
  basis: RateBasis | null;
  quotedAt: ISODateTime | null;
}
export interface CompareRow {
  model: Model;
  /** 与 stations 数组顺序严格对齐，长度恒等于站点数。 */
  cells: CompareCell[];
  /** 只在全部有值的格子上算：最大最小倍率，用于前端高亮。null 表示无法比较。 */
  best: { stationSlug: string; rate: number } | null;
}
export interface CompareStationsResponse {
  stations: Station[];
  rows: CompareRow[];
  /** 被忽略的 slug（不存在/已下架），前端要提示。 */
  ignored: string[];
}
```

错误码：`INVALID_INPUT`(400，少于 2 个或多于 3 个、slug 重复)。

### 服务端实现要点

- **路由注册顺序是这一节的唯一硬坑**：`API_ROUTES.getStation.path` 是 `/api/stations/:slug`，在 `app.ts:768` 通过 `route('getStation', …)` 注册。若 `compare` 排在它后面，Hono 按注册顺序匹配，`/api/stations/compare` 会被 `:slug` 吃掉 → 返回 404「中转站不存在」。**必须把 `route('compareStations', …)` 放在 `route('getStation', …)` 之前**，并写一条用例（`GET /api/stations/compare?slugs=a,b` 返回 200 而不是 404）。
- `Service.compareStations(input)`：
  1. `slugs` 拆分、去重、`trim`，长度 2~3，否则 400。
  2. 逐个 `store.get('station', slug)`，缺失的进 `ignored`；剩下的必须 ≥ 2，否则 400。
  3. 复用 `this.station(record)` 组 DTO（**注意**：它会算 `score` 与 `lowestRate`，也会查互动；3 个站成本可忽略）。
  4. 取三个站的报价：从 `this.offers()`（已缓存、已排除下架站点）里 filter，按 `modelSlug` 分组。
  5. 模型行排序：`stationCount`（覆盖了几站）降序 → `model.vendor` → `model.slug`，保证**稳定全序**（与 `getStations` 排序的教训一致：不稳定排序会让前端"重置对比"后顺序乱跳）。
  6. 每行的 `cells` 按 `stations` 顺序对齐；没有报价填 `{rate:null,basis:null,quotedAt:null}`。
  7. `best` 只在**同口径全部有值**时算：如果三格里有 `basis` 不同的，`best` 置 null（不可比），前端显示"口径不同，仅供参考"。这条比"取最小值"重要得多——否则页面上会出现"输入价 0.3 打败综合价 0.5"的结论，正是 `spec.md` 明令禁止的。
- 限流：不加（纯读，且 slug 数封顶 3）。
- 缓存：不缓存。3 个站的组装 < 5ms。

### 前端改动

- 新页面 `web/src/pages/Compare.tsx`，路由 `/compare?slugs=a,b`（`App.tsx` 加一条）。
- `Stations.tsx` 列表卡片加「对比」勾选框；选中 2~3 个后底部浮出「对比（N）」条（`localStorage` 持久化，键 `compare:slugs`）。上限 3 个，超过时 toast 提示并替换最早的。
- 对比页是一张 `<table class="data-table">`：首行是站点名/来源标签/最低倍率，下面每行一个模型；`best` 的格子加 `.is-best` 类；`null` 显示「暂无」；`basis` 用现有 `formatRateBasis`。
- 版权/诚信提示：页脚复用 `SITE_NOTICE`；表格顶部一行说明「只比相对倍率、不显示绝对价格；口径不同的数字不可直接比较」。
- 不需要新 hook（`useAsync` + `useSearchParams`）。

### 与既有逻辑的冲突点

1. **`StationDetail.offers` 是全量报价**：对比页不用它（用新的 `rows`），避免重复传输。
2. **`source` 混排**：demo 站与真实站可以并排吗？可以，但**必须**显示 `sourceLabel`，否则虚构的 0.5x 会被当成真实报价。这是本站最容易犯的错，对比页因为"并排看着更权威"而风险更高。
3. **`uptime`/`score` 的并排**：用户一定会想比可用率。但**绝大多数真实站 `uptime` 是 null**（`spec.md:20`）。对比表若把 null 渲染成 0 或空白，会产生"这个站可用率最差"的错觉。做法：null 显示 `NOT_AVAILABLE`（「暂无」），且**不参与任何高亮**。
4. **已下架站点**：`store.get` 会返回 undefined → 进 `ignored`，前端提示「N 个站点已下线，已从对比中移除」并从 `localStorage` 里剔除。
5. **分享链接**：`/compare?slugs=` 是纯 query，可分享。但要防超长/注入：前端渲染前校验 slug 正则，服务端 `identifier` 已有 `max(200)`。

### 测试策略

- `server/test/compare.test.ts`（新）：
  - 2/3 个站正常返回、`cells` 长度对齐、行排序稳定（同一输入两次调用顺序一致）。
  - 1 个或 4 个 slug → 400；重复 slug 去重后只剩 1 个 → 400。
  - 不存在的 slug → 进 `ignored`，剩余 ≥ 2 仍 200。
  - 已下架站 → `ignored`。
  - 缺报价的格 → `rate: null`（不是 0）。
  - `best`：三格口径一致时给出最小值；混口径时为 null。
  - **路由顺序**：`GET /api/stations/compare?slugs=…` 不被 `:slug` 吞掉。
- `web/test/compare.test.tsx`（新）：勾选上限 3、localStorage 恢复、混口径提示、null 渲染「暂无」。
- **变异验证**：把 `best` 的「同口径」判断去掉 → 混口径用例红；把 compare 路由挪到 getStation 之后 → 404 用例红（这条是给未来重构的人的保险）。

### 成本

**中等**：`service.ts` +110，`app.ts` +15，`shared` +35，web +180（页面 + 勾选 + 浮条），`App.tsx` +2。合计 ~340 行 + 测试 ~200 行。

---

## F9. SEO（sitemap / RSS / Open Graph）

### 结论

SPA 没有服务端渲染，但**服务端就在同一个进程里**（Hono 既跑 API 也托管 `web/dist`，`static.ts`）。所以 SEO 不必引入 Next/Remix，只要在 `mountWeb` 的兜底之前插几个 Hono 路由：

- `GET /sitemap.xml`、`GET /rss.xml`、`GET /robots.txt`：服务端动态生成（内容在库里）。
- `GET /posts/:id`、`/stations/:slug`、`/models/:slug`：返回 index.html 时**注入**该页的 OG/description，其余路径原样返回。

这是本项目成本最低、收益最直接的方案；迁移 SSR 框架是另一个量级的工程（要重写全部页面、丢掉现有 176 个 web 测试）。

### 契约变更

**不进 `API_ROUTES`。** 理由必须写清楚：`API_ROUTES` 的 path 类型被约束为 `` `/api/${string}` ``（`routes.ts:44`），而这三条是站点级资源、不是 JSON 接口，且 `web/src/api.ts` 的 `call()` 只处理 JSON。混进去会让契约类型失去意义。它们也不进 `/docs`（`Docs.tsx` 是按 `ApiRouteName` 枚举渲染的，混不进去）。

新增环境变量：`SITE_ORIGIN`（如 `https://zhidedeng.example`）。**必须用它拼绝对 URL，不能用请求的 Host 头**——原因见坑 7。

### 数据模型

零变更。唯一需要的是「最后修改时间」：`Post.updatedAt`（F2 已加），站点用 `entities.rowid`? 不行。站点没有 `updatedAt` 字段，sitemap 的 `lastmod` 省略即可（不要用 `now()`，那会让搜索引擎认为全站每天都变，反而降低抓取预算）。**这是真实取舍：宁可省略 lastmod，也不要伪造。**

### 服务端实现要点

新文件 `server/src/seo.ts`：

```ts
export function sitemap(store: Store, origin: string): string
export function rss(store: Store, origin: string): string
export function robots(origin: string): string
export function injectHead(html: string, meta: { title: string; description: string; url: string; image: string; noindex?: boolean }): string
```

- **sitemap**：静态 5 条（`/`、`/models`、`/stations`、`/rank`、`/community`）+ 全部 `approved` 且 `removedAt IS NULL` 的文章 + 全部在线站点 + 全部模型。**必须复用 `approvedPosts()` 的 SQL 条件**（`status='approved'` 下推），不要 `store.all('post')` 再 filter——2 万篇时那是 200ms + 内存峰值。上限 50000 条（协议上限）直接截断并记 warning。
- **XML 转义**：标题进 `<loc>`? 不进，但进 `<title>`/`<description>`。写 `escapeXml`（`& < > " '`），**别用 `encodeURIComponent` 冒充转义**——它不转义 `&` 在文本节点里的语义问题。URL 用 `encodeURI`（保留 `/`）。
- **rss**：最近 20 篇 approved 文章，RSS 2.0，`<description>` 用 `summary`（不要塞全文 body：10 万字 × 20 = 2MB，且没意义）。`<link>` 指向 `origin + /posts/{id}`。
- **robots.txt**：`User-agent: *` / `Allow: /` / `Disallow: /admin` / `Disallow: /api/` / `Disallow: /me`，末尾 `Sitemap: {origin}/sitemap.xml`。
- **OG 注入**：启动时读一次 `webRoot/index.html` 作为模板（不要每次请求读盘：`serveStatic` 每次都读，但 SEO 页是爬虫 + 分享卡片的高频路径，缓存模板更稳）。注入点用注释标记，在 `web/index.html` 的 `</head>` 前加一行 `<!--OG-->`，服务端把它替换成生成的 `<meta>` 块。**若找不到标记则退化为在 `</head>` 前拼接**（构建产物被换掉时不至于无声失效）。
- **路由注册位置**：在 `buildApp` 末尾、`return app` 之前。`mountWeb` 是在 `buildApp` 之后才调用的（`node-app.ts:135-136`），Hono 按注册顺序匹配，所以这些会优先于 `mountWeb` 的 `app.on(['GET','HEAD'], '*')` 兜底。**这个顺序依赖必须写注释**，否则下一个人把 seo 挪到 `mountWeb` 之后会得到"返回 index.html 而不是 XML"的诡异结果。
- **缓存头**：sitemap/rss `public, max-age=600`（并 `Vary` 不需要）；用 `store.entityVersion` 做进程内缓存（`database.ts:254` 就是为这个设计的）：`if (cachedVersion === store.entityVersion) return cached`，内容变更立刻失效，也不用定 TTL。这一手很值：爬虫高频抓 sitemap 时不耗 CPU。
- **`noindex`**：`/admin`、`/me` 走的是 SPA 路由，同一份 index.html。方案：在 `mountWeb` 之前对这两个前缀加一个中间件设置 `X-Robots-Tag: noindex`。注意 `SECURITY_HEADERS` 里没有这个头，要单独加；且**别加 `noindex` 到 `index.html` 本身**（那会把首页也干掉）。

### 前端改动

- `web/index.html` 的 `</head>` 前加 `<!--OG-->`；把现有 `<title>`/`<meta description>` 保留作为默认（服务端注入时整体替换这两个 + 追加 OG）。
- 页面级 `<title>` 已有（每个 page 里 `<title>…</title>`，react-router 不处理，但 React 19 会提升 `<title>` 到 head —— 这是客户端行为，爬虫不执行）。**不要**为此改成 helmet 之类，注入已经覆盖了分享场景。
- 不需要新组件/hook。

### 与既有逻辑的冲突点

1. **CSP 与 OG 图片**：`img-src 'self' data:`（`static.ts:12`）意味着 OG 图必须是站内资源。一期用 `web/public/banners/` 里现成的图或用 `favicon.svg` 生成的一张静态社交卡片。**不要**用外部图床。
2. **`mountWeb` 的 404 兜底**：它会把所有非 `/assets/` 的 GET 回退到 index.html。这意味着 `/sitemap.xml` 若没被显式注册，会返回 HTML（HTTP 200）——搜索引擎看到 200 + text/html，会静默失败，**没有报错**。必须有用例断言 `content-type` 含 `xml`。
3. **demo 数据进 sitemap**：demo 模式下 12 个虚构站、48 篇虚构文章会被收录。**这没错**（页面确实存在），但要在 demo 部署上设 `noindex`? 不建议加逻辑分支：`SITE_MODE` 已在 health 里播报，运维知道自己在演示模式。若担心搜索引擎收录演示站，用 `robots.txt` 的 `Disallow` 由部署方控制，代码里不做。
4. **全量导入会重建实体**：`importCatalog` 删掉 `source='submission'` 的实体并重建，`rowid` 变化不影响 sitemap（用 id 不用 rowid），但 `lastmod` 会"归零"。因为本来就不写 lastmod，无影响。
5. **文章被下架**：sitemap 里立刻消失（`removedAt IS NULL`），这是对的；但搜索引擎有缓存期，页面 404 是正常衰减，不需要 410。

### 测试策略

- `server/test/seo.test.ts`（新）：
  - `/sitemap.xml` 200 + `application/xml`，包含已通过文章、**不含** pending/rejected/已下架；XML 转义（标题里塞 `<script>` → 输出 `&lt;script&gt;`）。
  - `/rss.xml` 200，条目数 ≤ 20，按 `publishedAt` 倒序，含 `<link>` 绝对地址。
  - `/robots.txt` 含 `Sitemap:` 且是 `SITE_ORIGIN` 而非请求 Host（用 `Host: evil.com` 请求，断言输出里没有 evil.com）。
  - OG 注入：`GET /posts/:id` 返回 HTML 且 `<meta property="og:title">` 含文章标题；标题含 `"` 时被转义；`GET /me` 带 `X-Robots-Tag: noindex`；`GET /` 仍是默认 meta。
  - 缓存：连续两次请求，第二次不重新生成（可用一个计数 spy 或断言响应头）。
  - `store.entityVersion` 变更后 sitemap 内容更新。
- `web/test/`：不需要（SEO 全在服务端）；但 `bundle-guard` 已防止前端引入 zod，SEO 不碰前端包。
- **变异验证**：把 `removedAt IS NULL` 从 sitemap 查询里去掉 → 已下架用例红；把 `SITE_ORIGIN` 换成 `c.req.url` 的 origin → Host 注入用例红；去掉 `escapeXml` → XSS 用例红。

### 成本

**中等**：`seo.ts` ~180 行，`app.ts` +40（4 条路由 + noindex 中间件），`node-app.ts` +10（SITE_ORIGIN + index.html 模板读取 + 传入 buildApp），`index.html` +2。合计 ~230 行 + 测试 ~180 行。

---

## F10. 账号注销

### 结论

这是 10 项里唯一**不可逆**的操作，也是最容易做出"看起来对、实际把数据库搞坏"的功能。

四条决定：

1. **两阶段：申请（可撤销）→ 宽限期（7 天）→ 执行（每日定时）**。理由：没有邮件、没有二次验证，误操作只能靠宽限期兜底。执行时机复用 `index.ts` 已有的 `purgeTimer`（每 24h 跑一次 `purgeExpired`，`index.ts:24`），加一个 `finalizeDeletions`，零新增基础设施。
2. **不删 `accounts` 行，不删 `entities.user` 行，只做匿名化。** 因为 `votes`/`comments`/`favorites`/`checkins` 全都有 `userHandle` 字符串但没有外键（`database.ts:38-56` 只有 `comments.parentId` 和 `sessions.handle` 有 FK）。一旦 `DELETE FROM accounts` 并放开用户名，新注册的同名用户会**继承所有历史投票与评论**——这是最严重的一类漏洞，因为它能用来操纵榜单（先注册、刷票、注销、再用同 ID 注册重新投票）。
3. **内容保留、身份改标 `已注销用户`。** 理由是数据诚信：文章是 `source='user'` 的社区内容，删掉会让评论和引用断裂；但作者名必须换掉，且**不能伪造**成另一个真实用户。
4. **与「禁用」严格区分**：禁用是管理员行为、可逆、内容原样保留、保留 handle；注销是本人行为、不可逆、内容匿名化、handle 释放（或永久保留，见下）。

### 契约变更

```ts
requestAccountDeletion: { method: 'POST',   path: '/api/me/deletion' },
cancelAccountDeletion:  { method: 'DELETE', path: '/api/me/deletion' },
```

```ts
export type RequestAccountDeletionRequest = EmptyRequest;
export interface RequestAccountDeletionResponse {
  /** 生效时间；在此之前随时可以撤销。 */
  scheduledAt: ISODateTime;
  /** 宽限期天数，前端展示用。 */
  graceDays: number;
}
export type CancelAccountDeletionRequest = EmptyRequest;
export interface CancelAccountDeletionResponse { cancelled: true };

// CurrentUser 增加：
export interface CurrentUser {
  // …
  deletion?: { scheduledAt: ISODateTime } | null;
}
```

管理路由（不进契约）：`POST /api/admin/accounts/finalize-deletions`（手动触发，运维演练用），以及 `GET /api/admin/accounts/deletions`（列出待执行）。

错误码：`DELETION_ALREADY_REQUESTED`(409)、`NO_DELETION_PENDING`(409)、`ACCOUNT_NOT_DELETABLE`(409，演示账号/管理员)。

### 数据模型

`accounts` 加三列（**迁移**）：

```ts
export function ensureAccountColumns(store: Store) {
  store.transaction(() => {
    ensureColumn(store.db, 'deletionRequestedAt', 'TEXT', 'accounts');
    ensureColumn(store.db, 'deletedAt', 'TEXT', 'accounts');
    ensureColumn(store.db, 'anonymizedTo', 'TEXT', 'accounts');   // 匿名化后的 handle（审计用）
  });
}
```

`entities.user.data` 复用（**不需要**新列）：`nickname = '已注销用户'`、`bio = ''`、`avatar = ''`、`tokens = 0`、`badges = []`。

`usernameKey` 的处理是本节的核心取舍：

- **方案 A（保留）**：`usernameKey` 不动 → 用户名永久不可再注册。最简单、最安全，但"注销后名字还占着"，用户会觉得没删干净。
- **方案 B（改写成 `deleted:<uuid>`）**：释放原名。风险是**同名新号继承旧数据**——除非同时把内容里的 handle 也改掉。
- **采用 B + 同步改写内容 handle**：在同一个事务里，把该 handle 改写成一个不可登录的墓碑 handle `deleted-<8位hash>`，然后释放 `usernameKey`。这样：旧票/旧评论挂在墓碑上（计数不变、榜单不跳），同名新号拿到的是全新身份。

墓碑 handle 由 `sha256(handle + createdAt)` 取前 8 位 hex 生成，碰撞概率可忽略（且 `entities.user` 主键冲突会被事务挡住，可加盐重试）。

### 服务端实现要点

新文件 `server/src/account-lifecycle.ts`：

```ts
export function requestDeletion(store, handle, now): { scheduledAt: string }
export function cancelDeletion(store, handle): void
export function finalizeDueDeletions(store, now): { finalized: number }
```

**申请**（一个事务）：
1. 读 account；`disabledAt != null` → 409（先解禁才能注销，避免"被禁用的人无法注销"这种荒谬状态）。
2. 已有 `deletionRequestedAt` 且未到期 → 409。
3. 写 `deletionRequestedAt = now + 7d`。
4. 写一条通知事件（F7）：「注销将于 X 生效，可随时撤销」。
5. **不删会话**——用户需要能登录进来撤销。这一点与"禁用"相反，必须在注释里写明。
6. `console.info({event:'account.deletion.requested', handle, scheduledAt})`（审计 + 运维可见）。

**撤销**：清 `deletionRequestedAt`，返回 ok。**不校验密码**（会话已证明身份），但要求 `Content-Type` 走既有 CSRF 闸门。

**执行**（每日，或管理接口手动触发）：
1. 查 `deletionRequestedAt <= now AND deletedAt IS NULL`。
2. 对每个 handle 单独一个事务（一个失败不影响其他）：
   - 生成墓碑 handle；`INSERT` 一份新的 `entities.user`（`{handle: tombstone, nickname:'已注销用户', bio:'', avatar:'', tokens:0}`）。
   - `UPDATE entities SET id = ?, data = json_set(data,'$.authorHandle', ?) WHERE kind='post' AND json_extract(data,'$.authorHandle') = ?` —— 一条语句改全部文章的作者。**注意**：`json_set` 不会改 `source`，所以 `source='user'` 保留（正确：内容来源仍是用户投稿，只是作者匿了）。
   - `UPDATE comments SET userHandle = ? WHERE userHandle = ?`。
   - `UPDATE votes SET userHandle = ? WHERE userHandle = ?` —— **必须放在文章改写之后、且不能删**。删投票会让 `votes.total` 下降，榜单在注销瞬间变化，可被用来"删号洗榜"；改 handle 则计数完全不变。
   - `DELETE FROM favorites WHERE userHandle = ?`（收藏是纯个人数据，且删除不影响任何公开计数……**错**：`favoriteCount` 是公开的。删了收藏会让别人的文章收藏数下降。但那本来就是"这个人收过"，删号后不该继续计入——这里选择删，并接受计数变化；写清理由：收藏数是"当前有多少人收藏"，与"历史上有多少人投过票"语义不同）。
   - `DELETE FROM follows ...`、`DELETE FROM checkins ...`、`DELETE FROM notification_events WHERE actorHandle=? OR subjectHandle=?`、`DELETE FROM notification_cursors ...`。
   - `UPDATE sessions` → `DELETE`；`UPDATE agent_tokens SET revokedAt=?`（保留行做审计，与禁用一致）。
   - `UPDATE submissions SET status='superseded', reason='提交人已注销' WHERE actorHandle=? AND status='pending'` —— **这一步不能省**：否则宽限期结束前提交的、还在队列里的稿件会在注销后过审上线，挂在墓碑作者名下。
   - `UPDATE accounts SET deletedAt=?, anonymizedTo=?, usernameKey=? , passwordHash='!'` —— `passwordHash='!'` 让 `verifyPassword` 在 malformed 分支直接返 false（`auth.ts:175` 已有该防御），而不是依赖 `deletedAt` 判断。
   - 旧的 `entities.user` 行：`DELETE` 掉（`kind='user', id=旧handle`），因为新墓碑行已接管。
3. 返回执行数量，打日志。

**鉴权路径必须同步改两处**：
- `sessionHandle`（`auth.ts:219`）：JOIN 条件加 `AND accounts.deletedAt IS NULL`。
- `login`（`app.ts:657`）：`!account || !valid || account.disabledAt !== null` 加 `|| account.deletedAt !== null`，返回同一个 `INVALID_CREDENTIALS`（不区分"已注销"和"密码错"，避免账号存在性探测）。

**`Service.author()` 的崩点**（必须修）：
```ts
// service.ts:168 —— 现在是
const { nickname, avatar } = this.store.get('user', handle)!;   // ← handle 不存在时 TypeError → 500
```
注销后，任何还引用旧 handle 的地方（历史 submissions、通知事件、`agent_tokens`）都会让**整个列表接口 500**。修法：返回 `{handle, nickname:'未知用户', avatar:''}` 兜底，并把 `!` 去掉。`post()` 里 `authorNickname` 分支已有兜底，但 `author()` 没有。

**`getRankings('expert')`**：`store.all('user')` 会把墓碑用户列进达人榜（`shareCount` 归零后被 filter 掉，但如果墓碑还挂着文章……不会，文章已改写）。仍然要显式 `filter(user => user.nickname !== '已注销用户')`——依赖"shareCount 刚好为 0"太脆。

**与禁用的区别（写进 docs 与 UI 文案）**：

| | 禁用 | 注销 |
|---|---|---|
| 发起者 | 管理员 | 本人 |
| 可逆 | 是（`disabled=false`） | 否 |
| 内容 | 原样保留，handle 不变 | 匿名化，handle 改墓碑 |
| 会话 | 立即删除 | 宽限期内保留（可撤销），到期删除 |
| Agent 凭证 | 立即吊销 | 到期吊销 |
| 用户名 | 保留 | **释放** |

### 前端改动

- `Me.tsx` → `Settings` 底部「危险操作」区：红色描边按钮「注销账号」→ 展开面板（说明后果清单 + 输入用户名确认 + 勾选"我知道不可恢复"）→ 提交后显示「已申请，将于 X 生效」+「撤销申请」按钮。
- 登录页/全局：若 `me.deletion` 非空，`Layout.tsx` 顶部显示一条警告条「账号将于 X 注销，[撤销]」。
- 成功注销后：`signOut()` + 跳 `/`。
- 需要新 hook？不需要。`me.refreshMe()` 足够。

### 与既有逻辑的冲突点（这块最多）

1. **`votes`/`favorites` 没有外键**，所以"改 handle"是安全的；但 `sessions.handle` **有 FK** 指向 `accounts(handle)`，而 `accounts.handle` 是主键。如果按方案 B 释放用户名，`accounts.handle` 本身**不能改**（会被 FK 引用）。所以：`accounts.handle` 保持原值，只把 `usernameKey` 改写成 `deleted:<uuid>` 并 `deletedAt` 置位。这样用户名可再注册（新账号 `handle = 原用户名`，`usernameKey` 相同？）——**冲突**：`accounts.handle` 还是旧值，新注册 `INSERT INTO accounts (handle=同名)` 会主键冲突。
   **修正方案**：`accounts.handle` 也改成墓碑 handle（`deleted-<hash>`），然后 `sessions` 的外键在删除会话后不再引用它（同事务内先 `DELETE sessions` 再改 handle，SQLite 的 FK 检查在语句结束时生效，顺序对就行）。这是本节最细的一处，必须写用例：「注销后原用户名可重新注册，且新账号看不到任何旧数据」。
2. **`entities` 主键 `(kind, id)`**：旧 user 行要删、墓碑行要插；`INSERT ... ON CONFLICT` 用 `store.put` 会更安全（但 `put` 会 `entityVersion += 1`，正确）。
3. **`json_extract(data,'$.authorHandle') = ?` 的 UPDATE 需要索引**：已有 `entities_post_author` 表达式索引（`database.ts:82`），但它是**部分索引**（`WHERE kind='post'`），UPDATE 的 WHERE 恰好匹配，能用上。若不用索引，注销一个写过 100 篇文章的用户要扫全表——一次性操作，可接受，但注释里说明。
4. **`submissions.actorHandle`**：历史投稿保留原 handle（内部数据，且 `getMySubmissions` 按 handle 过滤，账号没了就查不到，无泄漏）。但 `GET /api/admin/submissions` 会显示旧 handle，管理员看到的是"已注销用户"，建议列表里 JOIN accounts 判断。一期不做，写进注释。
5. **`countVisibleFavorites`** 里用 `json_extract(target.data,'$.authorHandle') = ?` 匹配作者本人可见的待审稿——注销后 authorHandle 已改，这条路径自然失效，正确。
6. **通知（F7）**：事件被删掉后，其他人收到的"X 关注了你"通知会显示"未知用户"（`author()` 兜底）。接受。
7. **举报（F6）**：`reports.reporterHandle` 保留（审计需要，且举报内容不含个人信息）。若要求"举报也要匿名"，改成墓碑 handle。建议：**保留原值**，在管理端显示"已注销用户"，因为举报记录是风控证据。
8. **宽限期内发文章**：允许（他还是用户），但这些文章在到期时会被改写 authorHandle，正常。
9. **`purgeExpired` 的执行顺序**：`finalizeDeletions` 必须在 `purgeExpired` **之前**跑（purge 会删过期会话，不冲突，但先注销再清理更符合直觉）。

### 测试策略

- `server/test/account-deletion.test.ts`（新，最重要的一个文件）：
  - 申请 → `getMe().deletion` 非空、`sessions` 仍在、可撤销。
  - 撤销 → `deletion === null`，一切照旧。
  - 重复申请 → 409。
  - 到期执行（把 clock 推到 8 天后 + 手动调 `finalizeDeletions`）：
    - 登录 → 401 `INVALID_CREDENTIALS`；旧会话 → 401。
    - 文章仍在，`author.handle` 是墓碑、nickname「已注销用户」，`authorHandle` 已改（通过 `getMyPosts`? 不行，用 `getPosts` 的 author.handle 断言）。
    - **票数不变**：注销前后同一篇文章的 `votes.up` 完全相等（这条直接锁死"不能删票"）。
    - 收藏数下降（显式断言，写清是预期）。
    - 用户名可重新注册；新账号的 `getMe().tokens === 120`、`getMyFavorites().total === 0`、`getMyPosts().total === 0`（**没有继承任何旧数据**）。
    - pending 投稿被 `superseded`，不会在注销后上线。
    - `agent_tokens` 全 `revokedAt` 非空。
    - 原 handle 的 `entities.user` 行不存在，墓碑行存在。
  - `Service.author()` 兜底：手动构造一个"文章作者 handle 不在 users 里"的库，`GET /api/posts` 返回 200 且 nick 为兜底值（**防止 500 的回归**）。
  - `getRankings('expert')` 不含墓碑用户。
  - 禁用后再注销：允许（先解禁）；注销后再禁用：404。
- `web/test/account-deletion.test.tsx`（新）：确认输入校验、撤销按钮、警告条。
- **变异验证**（每条对应一个真实事故）：
  - 把 `UPDATE votes` 改成 `DELETE FROM votes` → 「票数不变」用例红。
  - 把 `accounts.handle` 改写去掉（只改 usernameKey）→ 「用户名可重新注册」用例红（主键冲突 500）。
  - 把 `submissions` 的 supersede 去掉 → 「注销后 pending 仍会上线」用例红。
  - 把 `sessionHandle` 的 `deletedAt IS NULL` 去掉 → 「旧会话仍可用」用例红。
  - 把 `author()` 的兜底还原成 `!` → 500 用例红。

### 成本

**较大**：`account-lifecycle.ts` ~200 行，`auth.ts` +8，`app.ts` +40（2 公开 + 2 管理 + 登录/会话判定），`service.ts` +25（author 兜底、getMe.deletion、排行榜过滤），`database.ts` +18，`node-app.ts` +6，`index.ts` +8，`shared` +20，web +110。合计 ~435 行 + 测试 ~380 行。

---

## 2. 建议**不做**或**推迟**的功能（附理由）

| 项 | 结论 | 理由 |
|---|---|---|
| 头像上传（base64 / 对象存储） | **不做** | 引入对象存储或 BLOB 是新子系统：容量、清理、审核、CDN、配额。收益是"更好看的头像"，成本是永久运维负担。预设 8 款已覆盖 90% 需求 |
| 头像外链 URL | **不做** | 破解 CSP `img-src 'self'`，等于给每个用户一个向全站读者发起第三方请求的通道（打点、追踪、NSFW）。要开就得配图片代理 + 审核，成本远超收益 |
| 举报自动下架（N 条即隐藏） | **不做** | 判定权交给匿名用户 = 组织化举报可以下架竞品的真实差评。本站的唯一资产是评价可信度 |
| 通知写扩散（fan-out） | **不做** | 单进程同步 SQLite 下，5000 粉 = 5000 条 INSERT 卡住事件循环。拉模型零写放大 |
| Token 兑换"投票加权/榜单加成/置顶" | **不做** | 与数据诚信硬约束直接冲突。一旦可买排序，整站数据不可信 |
| Token 兑换实物/现金 | **不做** | 需要履约、物流、发票、风控。没有这个团队 |
| 文章编辑的「历史版本 diff / 回滚 UI」 | **推迟** | 需要 `post_revisions` 表 + diff 渲染 + 三个新路由。当前审核流已经能拿到"改前改后"（旧版在线 + 新版在队列，管理员两边对照即可）。等真的出现争议再补 |
| 评论多级回复（> 1 层） | **不做** | `parentId` 的 CHECK 语义、`COMMENT_VISIBLE` 子查询、UI 缩进全要重写；而一层回复已经够用。这是纯粹的复杂度膨胀 |
| 站点对比的"推荐最优站" | **不做** | 没有实测指标（`uptime` 大多为 null），推荐必然是拍脑袋；而"推荐"会被当成平台背书，直接违背"未经核实"的声明 |
| 关注的信息流（只看关注的人） | **推迟** | 需要给 `GetPostsRequest` 加 `author` 过滤 + 与 `follows` JOIN，是公开契约变更。一期用"关注 → 通知"闭环已够 |
| 作者主页 `/users/:handle` | **推迟** | 同上；且要新增"作者的文章/评论/关注"三个列表，是三个页面的工作量 |
| SSR / 预渲染框架迁移 | **不做** | 服务端注入 OG + 动态 sitemap 已经拿到 90% 的 SEO 收益；迁移要重写全部页面并重写 176 个 web 测试 |
| 通知的邮件/WebPush | **推迟** | 项目明确"不要邮箱"（`spec.md:43`），且没有邮件基建。站内通知已闭环 |
| 举报的自动聚合/热度排序 | **推迟** | 当前规模（13 站/49 文）用不上，按行分页足够 |
| 软删除数据的物理清理（`deletedAt` 30 天后硬删正文） | **推迟但必须留 TODO** | 作者自删的文章正文仍留在 `entities.data` 里，"删除"在隐私意义上不完整。一期先记录设计缺口，别声称"已彻底删除" |
| 账号注销的"立即执行"选项 | **不做** | 没有二次验证手段时，立即执行 = 一次误触永久失去内容。7 天宽限期是唯一的安全垫 |

---

## 3. SQLite 单机同步 API 的性能墙

按"会先撞上哪面墙"排序，每条都给出可观测信号与应对。

### 3.1 通知的拉模型：`IN (子查询)` 随关注数线性放大

**墙**：`WHERE actorHandle IN (SELECT followeeHandle FROM follows WHERE followerHandle = ?)`，关注 N 人 → N 次索引 range scan；每人 50 条事件 → 最多 50N 行候选。N=500 时 25000 行，单次通知列表 10~30ms，且是**同步**的（阻塞事件循环）。

**信号**：`getMe`（含 unreadCount）耗时随"关注数"上升；`EXPLAIN QUERY PLAN` 里出现 `SCAN notification_events`。

**应对（按优先级）**：
1. **强制两段 `UNION ALL` + 各自 `LIMIT`**（见 F7 的 SQL）。只在每段内部排序取前 N，绝不在外层对全量排序。
2. `events` 表 90 天 purge，把 `IN` 的基数压住。
3. 若关注数真的上千：把「关注 > 200 人」的账号降级为"只保留 subject 路径通知 + 摘要聚合"，并在 UI 说明。**不要**上 fan-out。
4. 硬上限：单账号最多关注 500 人（产品规则，比技术优化便宜）。

### 3.2 `notification_events` 表与游标的索引设计

**必须的索引**（少一个就退化）：
- `events_actor ON (actorHandle, id)` —— 粉丝路径。
- `events_subject ON (subjectHandle, id)` —— 被回复/被关注路径。
- `events_created ON (createdAt)` —— purge 与"最新事件"。
- `follows_followee ON (followeeHandle, createdAt)` —— 粉丝列表（"谁关注了我"）。
- `follows_follower ON (followerHandle, createdAt)` —— 我关注了谁 + `IN` 子查询。

**不要**建 `(id, actorHandle)` 复合索引：查询是 `actorHandle = ? AND id > ?`，前导列必须是 `actorHandle`。

### 3.3 `getMe` 变成 5 条查询

`getMe` 是首屏最高频接口（每次加载 + 登录 + `refreshMe`）。当前 4 条：`checkins`、`entities.user`、`countVisibleFavorites`（一条复杂 JOIN）、`countOwnPosts`（两条 count）。加 `unreadCount` 后 5 条。

**墙**：每条都是独立的 `prepare + all`，`node:sqlite` 的 `DatabaseSync` 是同步的，任何一条慢查询都直接阻塞。1000 用户 + 10000 事件时，unreadCount 约 0.3ms（索引覆盖），可接受；但**不能**再往里加第 6 条。

**应对**：若后续必须再扩，把 `checkins + tokens + unread` 合并成一条 `SELECT (SELECT …), (SELECT …)` 的多子查询单行，减少 4 次 `prepare`。这是明确的"下一次重构点"，写进注释。

### 3.4 编辑走队列：pending 队列膨胀 + 审核台全表解析

**墙**：`listPosts(store, 'pending')`（`moderation.ts:9`）会 `store.all('post')` 全量反序列化再 filter，**没有任何索引**；再加上 queued 那一支的全表 `submissions` 扫描。编辑功能会让 pending 量自然翻倍（每篇文章改一次就 +1）。

**信号**：`GET /api/admin/posts?status=pending` 超过 200ms。

**应对**：
1. 编辑的 pending 不会被 `approvedPosts()` 计入（它有 `status='approved'` 下推），所以**公开接口不受影响**——这是把编辑塞进队列的最大好处。
2. 管理端迟早要改：`listPosts` 改用 `entities_post_approved` 同款的表达式索引（`CREATE INDEX ... ON entities(json_extract(data,'$.status')) WHERE kind='post' AND removedAt IS NULL` 其实已经存在！只需把 `store.all('post')` 改成带 `json_extract(data,'$.status') = ?` 的 SQL —— **零迁移的纯收益优化**，F2 落地时顺手做掉）。
3. 编辑的 submissions 行在物化后不影响读路径；只有 `pending` 有意义。

### 3.5 评论墓碑：`comments` 表只增不减 + `COMMENT_VISIBLE` 子查询

**墙**：`COMMENT_VISIBLE` 里带一个相关子查询（`parentId NOT IN (SELECT id FROM comments WHERE hidden=1 AND targetType=… AND targetId=…)`），已经注明"必须带 targetType/targetId 限定否则扫全表"（`service.ts:47-51`）。墓碑行让 `comments` 行数只增不减，且 `comments_author` 索引会变大。

**应对**：
1. 严格执行 F4 的不变量：「墓碑行必有可见子回复」→ 墓碑数量上限 = 有回复的删除评论数，不会无限膨胀。
2. **不要**给 `COMMENT_VISIBLE` 再加 `deletedAt IS NULL`（见 F4），否则子查询多一个条件，且语义错。
3. 若真要清理：purge 里删 `deletedAt` 超过 1 年且无子回复的（理论上不存在，作为兜底）。

### 3.6 举报/Token 流水的全表 count

**墙**：
- 举报每日限额 `count(*) WHERE reporterHandle=? AND createdAt > ?` → 需要 `reports_reporter(reporterHandle, createdAt)`，否则全表扫（表小时无感，10000 条时 8ms）。
- `token_ledger` 是**只增表**，一年后 10 万行；`getMyTokens` 分页必须 `(handle, createdAt)` 索引 + `LIMIT`，**绝不能**先取全量再 `paginate`（`service.ts:33` 的 `paginateThen` 就是为这个教训而生的）。

### 3.7 sitemap 每次全量生成

**墙**：爬虫每次抓 `/sitemap.xml` 都 `approvedPosts()` 全量 `JSON.parse` + 拼字符串。2 万篇时 200ms/次，而爬虫可能每分钟来一次。

**应对**：用 `store.entityVersion` 做进程内缓存（内容一变就失效），加 `Cache-Control: max-age=600`。这是 `entityVersion` 的第二个正当用途（第一个是 `submissions.ts` 的 hostname 索引），成本 5 行。

### 3.8 对比接口的 N+1

**墙**：`compareStations` 里对每个站调 `this.station(record)`，每个都会 `offersByStation()`（已缓存）→ 实际 O(1)。但若未来把 `StationDetail.offers` 也拼进去，就是 3 × 全量报价数组 filter，仍然便宜。**真正的墙不在这里**，而是"如果对比页允许 4+ 站"——必须封顶 3，否则 `rows × stations` 的表格本身会失控。

---

## 4. 「看起来简单，实际有坑」的 8 处

### 坑 1：软删除 × `store.put` 的自动复活

`Store.put` 的 SQL 是 `ON CONFLICT DO UPDATE SET data=excluded.data, removedAt=NULL`（`database.ts:232`）。这个设计对**站点**是对的（"重新上架就是清标记"），对**文章**是有毒的：任何"写一遍内容"的路径都会顺带撤销删除。

已知踩坑点：飞书同步（`submissions.ts:812` 显式挡了）、运维导入（`catalog.ts:166` 显式挡了）。**新功能会再引入三个**：
- 文章编辑通过审核 → `put` → 复活一篇作者已删的文章（如果编辑队列没在删文时收掉）。
- 账号注销后，pending 投稿过审 → `put` → 复活。
- 作者自删后又提交了一篇"编辑"（如果前端没拦住）。

**统一解法**：所有写 post 的地方，先把「`removedAt != null` 则拒绝」写成**一个函数**（`assertPostLive(store, id)`），而不是各写一遍 `if`。已有两处各写一遍，加新功能会变成五处，必然有一处漏。

### 坑 2：改 `publishedAt` 等于免费刷榜

`hotScoreRecord` 是 `net / (ageHours + 2)^1.3`（`service.ts:719`），`getPosts` 默认按 `publishedAt` 倒序。编辑时如果顺手把 `publishedAt` 设成 `now()`：
- "最新"榜上，一篇 3 个月前的文章改个错别字就回到第一位；
- hot 分因为 `ageHours` 归零而暴涨。

这是**不花一分钱、不需要任何漏洞**的榜单操纵。所以 `revision` 与 `updatedAt` 必须分开，`publishedAt` 在编辑路径里是只读的。同理，`post.updatedAt` **不能**参与任何排序或打分。

### 坑 3：`PRAGMA foreign_keys = ON` × 删除父评论

`comments.parentId REFERENCES comments(id)`（`database.ts:50`）没有 `ON DELETE` 子句，而 `node-app.ts:22` 显式开了外键。所以 `DELETE FROM comments WHERE id = <有回复的父评论>` **直接抛 FK 约束错误** → `app.onError` 里既不是 `ApiError` 也不是 `ZodError`/`SyntaxError` → 落到 `console.error` + 500「服务暂时不可用」。

用户看到的是"服务器错误"，以为系统坏了，实际是自己想删的评论有 3 条回复。这个坑的隐蔽性在于：**测试里如果只测"删一条没有回复的评论"，永远发现不了**。

同一个 `PRAGMA` 还会咬注销功能：`sessions.handle REFERENCES accounts(handle)` 意味着改 `accounts.handle` 之前必须先删会话（同事务内顺序要对）。

### 坑 4：Base64 头像 × `Author` 在列表里的传播

若把头像存成 64KB base64 塞进 `entities.user.data.avatar`：
- `Author = Pick<User,'handle'|'nickname'|'avatar'>`（`domain.ts:54`）→ 每篇文章、每条评论、每个榜单项都带一份；
- `getPosts` 一页 20 条 → 1.2MB 响应（现在是 ~30KB）；
- `compress()` 会对 base64 几乎无效（base64 的熵很高），gzip 只能压掉 25%；
- 更糟的是 `entities` 的读取是**整行 JSON.parse**：每个列表请求都要把 20 份 64KB 的 base64 解码进 JS 字符串。

而 `Avatar` 组件现在做的是「取昵称首字 + 8 色哈希」，**零字节**。这就是为什么 F5 只做预设 key——不是懒，是 base64 在这个存储模型里的传播成本是平方级的。

### 坑 5：注销后 `Service.author()` 的 `!` 会 500 整个列表

```ts
const { nickname, avatar } = this.store.get('user', handle)!;
```

`handle` 来自 `post.authorHandle`。注销后旧 handle 的 user 行被删 → `undefined` → 解构 `TypeError` → 500。影响面不是"那篇文章"，而是**所有包含该文章的列表接口**（首页、社区、评测、搜索、榜单、收藏、我的分享）。一个用户注销可以把全站列表打挂——这是本节最该先修的一行。

同理 `getRankings('expert')` 会把墓碑用户列上达人榜（`store.all('user')` 全集），需要在源头过滤，不能依赖 `shareCount > 0` 这个副作用。

### 坑 6：`/api/stations/compare` 被 `/api/stations/:slug` 吞掉

Hono 按**注册顺序**匹配，不是按具体度。`route('getStation', …)` 在 `app.ts:768`，如果新路由写在它后面，`GET /api/stations/compare` 会命中 `:slug` 并返回 404「中转站不存在」。开发时若用 `slugs=whale-demo,cloudshoe-demo` 这种"看起来像 slug"的 query 测试，会误以为是参数问题查半天。

**同类问题**：`/api/posts/:id` 与将来的 `/api/posts/drafts`（如果做草稿）也会撞。规矩：**静态段路由一律注册在参数段路由之前**，并各写一条"路由不被吞"的用例。

### 坑 7：sitemap/OG 用请求 Host 拼绝对 URL

`new URL(c.req.url).origin` 会返回客户端 `Host` 头里的值。攻击者用 `Host: evil.com` 请求一次 `/sitemap.xml`，如果响应用了它，就得到一个指向 evil.com 的 sitemap——如果前面有 CDN/反代缓存，这个投毒结果会**发给所有爬虫**。OG 同理（分享卡片链接指向外站）。

必须用 `SITE_ORIGIN` 环境变量。没有配置时：**生产模式下拒绝生成**（返回 500 + 日志），而不是 fallback 到 Host——fallback 会让这个漏洞在生产里悄悄存在。开发模式可以 fallback 到 `http://localhost:5173`。

### 坑 8：匿名化与统计一致性的冲突

注销时的三件事互相矛盾：
1. **删投票** → 榜单立刻变化，且"刷票 → 注销 → 重注册"可以无限洗票。
2. **保留投票** → 用户名被释放后，新注册的同名用户"继承"票数，等于身份串号。
3. **改 handle 到墓碑** → 计数不变、身份不串，但 `votes` 表里多了一堆指向不存在账号的行，且 `userHandle` 不再是"一个登录用户"。

答案是 3，并且**必须同时**释放原用户名（否则注销等于"占着名字不让别人用"）。而一旦释放，就必须保证内容里的 handle 全部改写——任何一处漏改（`submissions.actorHandle`、`reports.reporterHandle`、`notification_events`）都会留下一个"旧身份还能被点到"的悬空引用。

配套的一致性取舍要写进文档：**收藏数会下降**（删私人数据，语义是"当前有多少人收藏"），**票数不会变**（语义是"历史上多少人认为值得"）。这两个数字在注销事件上的行为不同，是设计选择，不是 bug——但如果不写清楚，第一个用户投诉就会让人以为是实现错了。

---

## 5. 测试与变异验证总纲

### 5.1 新增测试文件清单

| 文件 | 归属 | 用例数（估） | 覆盖的核心不变量 |
|---|---|---|---|
| `server/test/tokens.test.ts` | server | 12 | 余额 = 流水最后一条；幂等键唯一 |
| `server/test/post-edit.test.ts` | server | 22 | 编辑不新建文章；`publishedAt` 不变；不污染配额 |
| `server/test/post-delete.test.ts` | server | 10 | 删后不复活 |
| `server/test/comments-delete.test.ts` | server | 14 | 墓碑必有子回复；计数与列表一致 |
| `server/test/profile-avatar.test.ts` | server | 6 | 值域白名单 |
| `server/test/reports.test.ts` | server | 14 | 部分唯一索引；处置幂等 |
| `server/test/follows.test.ts` | server | 8 | 幂等、自关注禁止 |
| `server/test/notifications.test.ts` | server | 16 | 两段 UNION、游标、EXPLAIN |
| `server/test/compare.test.ts` | server | 10 | 对齐、null 不编造、同口径才算 best |
| `server/test/seo.test.ts` | server | 10 | XML 转义、Host 不采信、noindex |
| `server/test/account-deletion.test.ts` | server | 18 | 票数不变、用户名可复用且不继承、pending 被收 |
| `web/test/redeem.test.tsx` | web | 5 | 余额不足、幂等 key 复用 |
| `web/test/post-edit.test.tsx` | web | 6 | 冲突提示、审核中徽标 |
| `web/test/avatar.test.tsx` | web | 4 | fallback |
| `web/test/compare.test.tsx` | web | 6 | 上限 3、混口径提示 |
| `web/test/notifications.test.tsx` | web | 5 | 红点清零 |
| `web/test/account-deletion.test.tsx` | web | 5 | 二次确认、撤销 |

约 **180 个新用例**，与现有 1285 条同量级增长（→ ~1465）。

### 5.2 变异验证的做法

`vitest` 没有内建变异测试，本项目也没有 stryker。**手工变异 + 定向回归**是最划算的方式，规定三条纪律：

1. **每个高危分支至少配一条"删掉它就红"的用例**。我在每个功能里都点了具体是哪个分支（例如 F2 的 `editOf` 分支、F10 的 `UPDATE votes`）。
2. **变异验证记录在 PR 描述里**：写清"我把它改成 X，用例 Y 变红"。这不是形式主义——它是唯一能证明用例真的在测行为、而不是在测实现的证据。
3. **禁止为了通过而改断言**。如果一条用例在变异后变红，而实现"看起来没问题"，先假设用例对。

### 5.3 必做的基线测试（防回归，不属于任何单一功能）

- `pnpm -r typecheck`：新增 14 条路由会强制 `ApiContracts`/`API_ROUTES`/`web/src/api.ts` 三处对齐，漏一处立即红。
- `web/test/bundle-guard.test.ts`：新页面不要从 `@zhidedeng/shared/submission` 引 zod。F2/F6 的表单校验**只能**用 shared 的常量（`PROFILE_LIMITS` 那种），不能用 schema。
- `server/test/transaction-savepoint.test.ts`：新的嵌套事务（编辑的 `enqueueSubmission` 里套 `beforeInsert`、注销的多表更新）必须仍然能正确回滚。
- `server/test/hardening.test.ts`：新增写接口默认要过 CSRF 的 `Content-Type: application/json` 闸门；GET 接口要带 `cache-control: no-store`（`route()` 已经统一加了，别绕过 `route()` 手写）。
- `server/test/api.test.ts` 的"未登录 401"矩阵：新增的 8 条需要登录的路由要加入 `PERSONAL_READS` 或靠 `method !== 'GET'` 自动覆盖—— **注意** `getNotifications`/`getMyFollows`/`getMyTokens` 是 GET 且是个人数据，必须显式加入 `PERSONAL_READS`（`app.ts:72`），否则未登录会拿到空列表而不是 401。这是一个极易漏的点。

---

## 6. 排期与耦合顺序

依赖关系（箭头 = 必须先做）：

```
F5 头像 ──┐
F3 文章删除 ──┴─→ F2 文章编辑 ──→ F6 举报（处置复用下架路径）
                              └─→ F7 关注/通知（事件挂在 materialize / createComment 上）
F10 账号注销 ──→ 依赖 F1（余额清零）、F6（举报归属）、F7（事件清理）
F1 Token ──→ 依赖 F10 的"余额归零"语义（先定，再写）
F4 评论删除 ──→ 独立，但 F6 的 comment 目标要认墓碑，建议 F4 先做
F8 对比 / F9 SEO ──→ 完全独立，可并行
```

建议批次：

1. **批次 A（低风险，先建立节奏）**：F5 → F3 → F4。三块互不依赖，合计约 500 行，可独立上线。
2. **批次 B（核心风险）**：F2（含 `route()` 修正 + `materialize` 分支）。上线前必须有完整的 `post-edit` 用例与两条变异记录。
3. **批次 C（新子系统）**：F6 → F7。F7 先落 `readTransaction` 和 `EXPLAIN` 基线用例，再写读接口。
4. **批次 D（收尾）**：F1 → F10。F10 最后做，因为它要扫一遍 A/B/C 引入的所有表。
5. **并行**：F8、F9 任何时间插入，不阻塞主线。

---

## 附：完整路由增量（39 → 53）

```ts
// shared/src/routes.ts 追加（顺序即注意事项：compare 必须在 getStation 之前注册）
getRewards:            { method: 'GET',    path: '/api/rewards' },
getMyTokens:           { method: 'GET',    path: '/api/me/tokens' },
redeemReward:          { method: 'POST',   path: '/api/me/tokens/redeem' },
editPost:              { method: 'PATCH',  path: '/api/posts/:id' },
deletePost:            { method: 'DELETE', path: '/api/posts/:id' },
deleteComment:         { method: 'DELETE', path: '/api/comments/:id' },
createReport:          { method: 'POST',   path: '/api/reports' },
followAuthor:          { method: 'PUT',    path: '/api/follows' },
getMyFollows:          { method: 'GET',    path: '/api/me/follows' },
getNotifications:      { method: 'GET',    path: '/api/me/notifications' },
readNotifications:     { method: 'POST',   path: '/api/me/notifications/read' },
compareStations:       { method: 'GET',    path: '/api/stations/compare' },
requestAccountDeletion:{ method: 'POST',   path: '/api/me/deletion' },
cancelAccountDeletion: { method: 'DELETE', path: '/api/me/deletion' },
```

共 14 条公开路由（39 → 53）。管理/站点级路由（不进契约）：

```
GET  /api/admin/reports?status=&targetType=&page=&pageSize=
POST /api/admin/reports/:id/review
GET  /api/admin/accounts/deletions
POST /api/admin/accounts/finalize-deletions
GET  /sitemap.xml   GET /rss.xml   GET /robots.txt        （站点资源，不进 API_ROUTES）
```

`PERSONAL_READS` 必须新增：`getMyTokens`、`getMyFollows`、`getNotifications`（都是 GET + 个人数据，忘了加就是"未登录返回空列表"的静默错误）。
