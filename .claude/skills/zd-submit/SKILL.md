---
name: zd-submit
description: 让 AI Agent 把分析完的 AI API 中转站数据提交到「什么值得蹬」，取代人工填表。当用户要求「把这个中转站提交到值得蹬」「录入这个站」「投稿评测」「更新站点倍率」，或 Agent 刚分析完一个中转站的模型报价、想把它录入社区数据库时使用。
---

# 向「什么值得蹬」提交中转站数据

「什么值得蹬」是一个 AI API 中转站点评社区，用 `zd` 命令行投稿。你分析完一个站点后，通过这套流程把结构化数据提交进去，人工审核后公开。

## 最重要的一件事

**你提交的数据会被标注为「AI 采集，未经平台核实」并公开展示。** 不要编造、不要推测、不要为了填满字段而猜。

提交前先自问：
- 这个倍率是我在站点页面上实际看到的，还是我算出来的？
- 这个模型名是站点上写的，还是我猜它对应某个标准 slug？
- 我没看到的字段，是不是就该留空？

留空永远比编造好。平台对缺失字段的显示是「未知」，对错误数据的显示是一个谎言。

## 前置检查

```sh
zd whoami
```

返回身份与配额余量。**先看这个再动手**：

| 字段 | 含义 |
|---|---|
| `handle` | 你的凭证属于哪个账号 |
| `pendingCount` | 已提交待审数量 |
| `quotas.token` | 本凭证每小时还能提交几次（上限 10） |
| `quotas.account` | 所属账号每小时合计（上限 20） |
| `quotas.pending` | 账号待审上限（5 条），满了要先等审核 |
| `quotas.hostnames` | 已占用额度的 hostname，单个域名最多 2 条待审 |

退出码 5 表示凭证无效或已吊销——**停下来告诉用户重新签发**，不要重试。

## 必走流程

不要跳步。每一步都有理由。

### 1. `zd catalog` — 拿到已有数据

```sh
zd catalog
```

返回 `vendors`、`models`、`stations`（自动翻页取全量）。

`models[].slug` 是你写报价时唯一合法的取值来源。**不存在于这个列表里的模型，不能作为 `modelSlug` 提交。**

### 2. `zd match "模型名"` — 确定 slug

```sh
zd match "Claude Sonnet 4.5"
```

- 命中一个 → 直接用它的 `slug`
- 命中多个 → **让用户选**，不要自己挑
- 无命中且 `suggestion` 非空 → 该模型还没被收录。**不要编造 slug**，告诉用户「这个模型平台还没有，需要先单独收录」

站点上用的是什么名字就查什么名字。不要因为你知道「Sonnet 4.5 的标准 slug 是 claude-sonnet-4-5」就直接写——要先确认这个 slug 真的存在。

### 3. 构造 payload

**站点**（有 `url` 字段就按站点处理）：

```json
{
  "name": "站点显示的名字",
  "description": "一句话描述，别写营销话术",
  "url": "https://example.com/",
  "rechargeThreshold": null,
  "paymentMethods": [],
  "offers": [{ "modelSlug": "claude-sonnet-4-5", "rate": 0.8 }]
}
```

**评价**（有 `title` 字段就按评价处理）：

```json
{
  "title": "标题",
  "summary": "摘要",
  "body": "正文",
  "authorName": "署名",
  "hostname": "example.com"
}
```

各字段的硬要求：

| 字段 | 约束 |
|---|---|
| `name` | 非空，最多 60 字 |
| `description` | 非空，最多 300 字 |
| `url` | http/https，最多 300 字，**不能带 `?`、`#`、账号密码** |
| `rate` | 相对倍率，范围 0.05 ~ 20 |
| `offers` | 最多 100 条，**同一 modelSlug 不能重复** |
| `title` / `summary` / `body` | 100 / 200 / 5000 字上限 |
| `authorName` | 最多 30 字 |

**不接受多余字段。** 多写一个字段整条会被拒。

### 4. `zd validate ./x.json` — 本地先过一遍

```sh
zd validate ./x.json
```

不联网，跑的是与服务端完全相同的 schema。

- 退出码 0 → 可以提交
- 退出码 3 → **按 `issues` 改数据**，改完重新 validate，不要直接重试

`issues[].field` 会指出是哪个字段（嵌套用 `offers.0.rate` 这种路径）。

### 5. `zd submit ./x.json` — 提交

```sh
zd submit ./x.json
```

成功返回 `submission.id`、`status: "pending"`、`deduplicated`。

`deduplicated: true` 表示内容和之前某条完全相同，服务端没有重复入队——这不是失败。

批量：

```sh
zd submit --batch ./dir/
```

目录下所有 `.json` 逐个提交，单个失败不影响其余，最后汇总 `submitted` 和 `failed`。**逐个看 `failed` 里的 code 和 message**，不要因为退出码非 0 就整体重来。

### 6. `zd status` — 看审核结果

```sh
zd status --limit 20
```

每条有 `status` 和 `reason`：

| status | 含义 | 你该做什么 |
|---|---|---|
| `pending` | 等审核 | 等待，不要重复提交 |
| `approved` | 已通过 | 完成 |
| `rejected` | 被拒 | **看 `reason`**，按原因修正后重新提交 |
| `superseded` | 被同站点的更新版本替代 | 无需处理 |

`rejected` 的 `reason` 是人工写的，务必读。

## 绝对禁止

以下字段由平台自己采集，提交了会被 `400 FORBIDDEN_FIELD` 拒绝。**这些数值只有平台实测才算数，Agent 不可能知道**：

```
uptime, firstTokenLatencyMs, foundedAt, status, score, lowestRate
```

也不许：
- 提交 `apiKey` / `token` / `password` / `authorization` 等任何凭证字段
- 提交 `authorHandle`（作者身份由凭证决定，不能自己声明）
- 用大小写或下划线变体绕过（`Uptime`、`first_token_latency_ms` 同样被拒）

**不要为了过校验而删掉字段后重试**——如果你的数据里有 `uptime`，说明你在提交不该由你提交的东西，应该停下来检查数据来源。

## 退出码对照

| 码 | 含义 | 动作 |
|---|---|---|
| 0 | 成功 | — |
| 1 | 用法错误 | 检查参数写法 |
| 2 | 网络/服务端故障 | **原样重试**（这是唯一该直接重试的） |
| 3 | 本地校验失败 | **改数据**，不要原样重试 |
| 4 | 服务端拒绝 | 按 message 改；配额类要等 |
| 5 | 未登录/凭证无效 | 让用户重新签发 |

**2 和 3 的区别是这套流程里最容易搞错的地方**：退出码 2 重试有意义，退出码 3 重试一万次也是同样的错。

## 配额与节流

| 维度 | 上限 |
|---|---|
| 单凭证 | 10 条/小时 |
| 单账号 | 20 条/小时（跨凭证合计） |
| 单 IP | 20 条/小时 |
| 单账号待审 | 5 条 |
| 单 hostname 待审 | 2 条（跨渠道合计） |

超限返回退出码 4。`quotas` 里有 `retryAfter`（秒）会告诉你等多久。

**不要靠换 hostname 写法绕过 2 条限制**（`www.` 前缀、大小写、尾点都是同一个域名）。

## 常见错误

**`400 FORBIDDEN_FIELD`** — 提交了禁字段。删掉，不要改名。

**`400 INVALID_INPUT`** — 字段格式不对。看 message 指出的字段路径。

**`409 TOO_MANY_PENDING`** — 待审队列满了。用 `zd status` 看有多少 pending，等审核或让用户处理。

**`429 RATE_LIMITED`** — 速率超限。看 `retryAfter`，等到期再提交。

**`401 UNAUTHENTICATED`** — 凭证无效或已吊销。**这是唯一需要人工介入的状态**，不要重试。

## 一个判断标准

提交前问自己：**如果这个数据被公开展示、且用户按它去付费了，我担得起吗？**

担不起的，就留空或问用户。
