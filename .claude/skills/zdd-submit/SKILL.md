---
name: zdd-submit
description: 让 AI Agent 把分析完的 AI API 中转站数据提交到「什么值得蹬」，取代人工填表。当用户要求「把这个中转站提交到值得蹬」「录入这个站」「投稿评测」「更新站点倍率」，或 Agent 刚分析完一个中转站的模型报价、想把它录入社区数据库时使用。
---

# 向「什么值得蹬」提交中转站数据

「什么值得蹬」是一个 AI API 中转站点评社区，用 `zdd` 命令行投稿。你分析完一个站点后，通过这套流程把结构化数据提交进去，人工审核后公开。

## 最重要的一件事

**你提交的数据会被标注为「AI 采集，未经平台核实」并公开展示。** 不要编造、不要推测、不要为了填满字段而猜。

提交前先自问：
- 这个倍率是我在站点页面上实际看到的，还是我算出来的？
- 这个模型名是站点上写的，还是我猜它对应某个标准 slug？
- 我没看到的字段，是不是就该留空？

留空永远比编造好。平台对缺失字段的显示是「未知」，对错误数据的显示是一个谎言。

## 第 0 步：确认 zdd 能用

先从两种方式里选一个，**并且在本次会话中始终用同一种**：

```sh
# 方式 A：已全局安装（控制台里直接敲 zdd 就能用）
zdd help

# 方式 B：用仓库自带实现（在仓库根目录执行）
./scripts/zdd help
```

能打印出命令清单就可以往下走。如果两种都不行 —— **停下来告诉用户需要先配置 `zdd`**，不要自己尝试别的路径或另写脚本。

`zdd` 需要 Node 22.18 以上。仓库里已带实现，不需要额外安装。

**下面所有命令都写成 `zdd ...`。** 如果你选的是方式 B，把每个 `zdd` 换成 `./scripts/zdd` 即可（在仓库根目录执行）。

## 第 1 步：登录

```sh
zdd login --key zd_xxx
```

凭证由账号持有人在站点的「账户设置 → AI Agent 凭证」里签发，形如 `zd_` 开头的一长串。

- 登录成功会存到 `~/.config/zdd/config.json`（权限 0600）
- 已经登录过就不用重复执行
- **凭证无效或格式不对时不要重试** —— 这说明需要用户重新签发

如果用户已经把凭证放在环境变量 `ZDD_TOKEN` 里，可以跳过这一步。

## 第 2 步：前置检查

```sh
zdd whoami
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

退出码 5 表示没有登录或凭证已失效。看 `message` 区分：
- 「还没有登录」→ 回到第 1 步执行 `zdd login`
- 「凭证无效」→ **停下来告诉用户重新签发**，不要重试

## 必走流程

不要跳步。每一步都有理由。

### 1. `zdd catalog` — 拿到已有数据

```sh
zdd catalog
```

返回 `vendors`、`models`、`stations`（自动翻页取全量）。

`models[].slug` 是你写报价时唯一合法的取值来源。**不存在于这个列表里的模型，不能作为 `modelSlug` 提交。**

### 2. `zdd match "模型名"` — 确定 slug

```sh
zdd match "Claude Sonnet 4.5"
```

- 命中一个 → 直接用它的 `slug`
- 命中多个 → **让用户选**，不要自己挑
- 无命中且 `suggestion` 非空 → 该模型还没被收录。**不要编造 slug**，告诉用户「这个模型平台还没有，需要先单独收录」

站点上用的是什么名字就查什么名字。不要凭印象写 slug——平台的模型清单覆盖的是模型系列而不是每个版本号，市面上很多具体型号并没有单独收录。`zdd match` 的 `matches` 为空就说明没有，不要自己拼一个。

### 3. 构造 payload

**站点**（有 `url` 字段就按站点处理）：

```json
{
  "name": "站点显示的名字",
  "description": "一句话描述，别写营销话术",
  "url": "https://example.com/",
  "rechargeThreshold": null,
  "paymentMethods": [],
  "offers": [{ "modelSlug": "claude-sonnet", "rate": 0.8 }]
}
```

站点的六个字段**全部必填**，缺一个就会被本地校验挡回（退出码 3）：

- `rechargeThreshold` 是充值门槛的金额，没有就写 `null`，**不能省略这个键**
- `paymentMethods` 是支付方式列表，没有就写 `[]`
- `offers` 没有报价时写 `[]`

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

### 4. `zdd validate ./x.json` — 本地先过一遍

```sh
zdd validate ./x.json
```

不联网，跑的是与服务端完全相同的 schema。

- 退出码 0 → 可以提交
- 退出码 3 → **按 `issues` 改数据**，改完重新 validate，不要直接重试

`issues[].field` 会指出是哪个字段（嵌套用 `offers.0.rate` 这种路径）。

### 5. `zdd submit ./x.json` — 提交

```sh
zdd submit ./x.json
```

成功返回 `submission.id`、`status: "pending"`、`deduplicated`。

`deduplicated: true` 表示内容和之前某条完全相同，服务端没有重复入队——这不是失败。

批量：

```sh
zdd submit --batch ./dir/
```

目录下所有 `.json` 逐个提交，单个失败不影响其余，最后汇总 `submitted` 和 `failed`。**逐个看 `failed` 里的 code 和 message**，不要因为退出码非 0 就整体重来。

### 6. `zdd status` — 看审核结果

```sh
zdd status --limit 20
```

每条有 `status` 和 `reason`：

| status | 含义 | 你该做什么 |
|---|---|---|
| `pending` | 等审核 | 等待，不要重复提交 |
| `approved` | 已通过 | 完成 |
| `rejected` | 被拒 | **看 `reason`**，按原因修正后重新提交 |
| `superseded` | 被同站点的更新版本替代 | 无需处理 |

`rejected` 的 `reason` 是人工写的，务必读。管理员也可以不写原因，这时 `reason` 是 `null`，需要问用户。

## 绝对禁止

以下字段由平台自己采集，提交了会被 `400 FORBIDDEN_FIELD` 拒绝。**这些数值只有平台实测才算数，Agent 不可能知道**：

```
uptime, firstTokenLatencyMs, foundedAt, status, score, lowestRate
```

也不许：
- 提交 `apiKey` / `api_key` / `token` / `secret` / `password` / `authorization` / `credentials` / `accessToken` / `refreshToken` / `clientSecret` / `privateKey` 等任何凭证字段
- 提交 `authorHandle`（作者身份由凭证决定，不能自己声明）
- 用大小写或下划线变体绕过（`Uptime`、`first_token_latency_ms` 同样被拒）

**不要为了过校验而删掉字段后重试**——如果你的数据里有 `uptime`，说明你在提交不该由你提交的东西，应该停下来检查数据来源。

## 退出码对照

| 码 | 含义 | 动作 |
|---|---|---|
| 0 | 成功 | — |
| 1 | 用法错误 | 检查参数写法 |
| 2 | 网络/服务端故障 | **原样重试**（这是唯一该直接重试的），但最多 2~3 次，间隔递增 |
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
| 全站待审 | 200 条（不计入你的配额，但满了所有人都提交不了） |

超限返回退出码 4。等多久要看 **`detail.error.retryAfter`（秒）**，注意它在 `detail` 里面，不在 `quotas` 里。

`whoami` 返回的 `quotas.token/account/ip` 各有一个 `retryAfter` 字段，表示当前还剩多少秒恢复额度。

大小写和尾点会被归一化成同一个域名。**但 `www.` 前缀目前会被当成不同域名单独计数** —— 不要利用这一点去突破上限，这是服务端待修的缺口，故意绕开等于刷量。

## 常见错误

**Agent 看到的是退出码和 message，不是 HTTP 状态码。** 服务端的错误码在 `detail.error.code` 里，只有退出码 4 才可能有。

**退出码 3（本地就拦下了，没到服务端）**

| message 关键词 | 含义 |
|---|---|
| `不允许这个字段` | 提交了禁字段，删掉 |
| `不认识这个字段` | 有多余字段，删掉（不是改名） |
| `倍率 ... 超出范围` | rate 不在 0.05~20 |
| `存在重复的报价` | 同一个 modelSlug 写了两次 |
| `无法判断种类` | payload 既没有 `url` 也没有 `title` |

**退出码 4（服务端拒绝）** —— 看 `detail.error.code`：

| code | 含义 | 动作 |
|---|---|---|
| `FORBIDDEN_FIELD` | 有禁字段（本地没拦住，一般是嵌套层） | 删掉 |
| `INVALID_INPUT` | 格式问题，如 `未知模型` | 按 message 改；「未知模型」说明 slug 不存在，**回到 `zdd match` 重新确认** |
| `TOO_MANY_PENDING` | 待审队列满 | 看 message 区分是账号级、hostname 级还是全站级；账号级用 `zdd status` 看进度 |
| `RATE_LIMITED` | 每小时额度用完 | 等 `detail.error.retryAfter` 秒 |

**退出码 5（凭证问题）** —— 见第 2 步的说明，需要用户介入。

## 一个判断标准

提交前问自己：**如果这个数据被公开展示、且用户按它去付费了，我担得起吗？**

担不起的，就留空或问用户。
