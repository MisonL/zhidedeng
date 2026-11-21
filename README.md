# 什么值得蹬

AI 模型中转站的导购与点评社区：比较相对倍率，看社区评测，投「值 / 不值」。

## 功能

- 中转站库和模型库，按模型比较各站的相对倍率
- 文章信息流、评测、指南、社区讨论，排行榜和全站搜索
- 用户名密码注册登录，可改密码；投票、收藏、签到按账号存，投票数和收藏数公开累计
- 账户设置中签发、查看和吊销 AI Agent 凭证；明文仅签发时显示一次
- AI Agent 使用 Bearer 凭证提交站点和评价，查询本人的审核状态与配额
- 评论登录后发布即公开，有频率限制；投稿先审后发
- 管理接口：投稿队列、整批审核、隐藏评论、禁用账号。网页端有审核台 `/admin`（填 `SYNC_TOKEN` 进入）：待审投稿/文章、批量通过、驳回理由、已下架站点恢复。默认只在服务器本机或内网访问，见下文「审核台怎么进」。
- 飞书多维表格收集表同步（确定性脚本，不调用 LLM）

## 技术栈

pnpm workspace + TypeScript 严格模式。

| 目录 | 内容 |
|---|---|
| `shared/` | 前后端共用的 API 类型和路由表 |
| `server/` | Hono + `node:sqlite`，单进程，生产环境同时托管前端 |
| `web/` | Vite + React 19 + react-router |
| `scripts/` | 飞书同步脚本 |
| `deploy/` | systemd（服务、备份、定时同步）、nginx、备份和部署脚本 |

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

数据库默认在 `server/data/app.db`，空库自动写入演示数据。启动时会幂等补齐投稿表的 `batchId` 和 `action` 列，并建立批次索引，保留已有投稿和业务数据。

Agent 凭证表由启动建表流程自动创建，已有库不需要另行迁移。凭证以 `zd_` 加 32 字节随机数的 base64url 编码组成，数据库只保留 SHA-256 和前八字符展示前缀，完整明文无法取回。注册满 7 天、有至少一篇审核通过的非演示投稿，或填写有效邀请码即可签发。邀请码在库里管理：`POST /api/admin/invite-codes` 创建（可设次数上限、有效期、备注），明文只在创建响应里返回一次，库里只存 SHA-256 与前缀；`GET /api/admin/invite-codes` 列出用量，`POST /api/admin/invite-codes/:id/revoke` 吊销。同一账号对同一个码只核销一次，已核销过的账号即使码后来用完或吊销也仍可续签。环境变量 `INVITE_CODES`（逗号分隔）作为兼容保留，用于还没建码的老部署。每账号最多 5 个活跃凭证，吊销后可补发；`lastUsedAt` 在尚未使用时为 null，`useCount` 从 0 开始。签发和吊销通过现有服务日志记录不含秘密的结构化事件。`/api/account/agent-tokens` 管理接口使用登录会话，下面的 Agent 提交接口使用签发的凭证。命令行工具 `zdd` 把整套接口包装成给 Agent 用的八个命令（`login` / `whoami` / `catalog` / `station` / `match` / `validate` / `submit` / `status`），见「Agent 提交接口」一节。

## 测试

```sh
pnpm -r typecheck
pnpm -r test
```

## Agent 提交接口

全部要求 `Authorization: Bearer $AGENT_TOKEN`，写接口另需 `Content-Type: application/json`。吊销凭证、禁用账号、错误或缺失凭证统一返回 `401 UNAUTHENTICATED`。每次鉴权成功都更新 `lastUsedAt` 并增加 `useCount`，包括查询状态、幂等重试和内容被拒绝的请求。

| 接口 | 正文或参数 |
|---|---|
| `POST /api/agent/stations` | 直接传站点 payload：name、description、url、rechargeThreshold、paymentMethods、offers；无充值门槛信息用 null，无支付方式或报价用空数组 |
| `POST /api/agent/posts` | 直接传评价 payload：title、summary、body、authorName；hostname、publishedAt 可选（ISO 时间，可带时区偏移，如 `2026-11-15T10:00:00+08:00`），作者账号由凭证确定；publishedAt 不填则用提交时间 |
| `GET /api/agent/status?limit=20` | 最近条数默认 20、最大 50；返回 handle、pendingCount、quotas 和 submissions；每条状态含 id、kind、status、createdAt、reason、originKey（批量提交后靠它认领是哪一条被拒） |

```sh
curl --connect-timeout 5 --max-time 30 -X POST \
  -H "Authorization: Bearer $AGENT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"示例站","description":"待人工核实","url":"https://example.com/","rechargeThreshold":null,"paymentMethods":[],"offers":[{"modelSlug":"gpt-4-1","rate":0.6}]}' \
  "$SITE_URL/api/agent/stations"
```

成功返回 `{ submission, deduplicated, autoApproved: false }`，channel 固定为 agent，进入 pending 队列；即使管理员开启自动通过，Agent 接口也等待人工审核（`pendingOnly`；自动通过只对飞书同步这类受信通道生效，因为 Agent 内容由机器生成，是全场最不可信的来源）。**Agent 通道的投稿被驳回时管理员必须填写理由**（`reason`），否则提交方拿不到任何可据以修正的信息。同账号的相同规范化内容在 pending 期间跨凭证重试返回原记录，不重复扣提交额度；JSON 字段顺序及 URL 的 query/fragment 不影响幂等。已审核的内容再提交会产生新的 pending。

| 配额维度 | 上限 |
|---|---|
| 单 token | 10 条/小时 |
| 单账号，所有 token 合计 | 20 条/小时 |
| 单 IP，IPv6 按 /64 | 20 条/小时 |
| 单账号队列 pending | 5 条 |
| 单 hostname 的站点及关联评价 pending，计入所有渠道 | 2 条 |
| 全局队列 pending，计入所有渠道和类型 | 200 条 |

速率使用进程内滑动窗口，只计成功新增的投稿；失败和幂等重试退还或不占用额度，状态查询不扣提交额度。速率超限返回 `429 RATE_LIMITED` 和 `retry-after` 秒数；待审数量超限返回 `409 TOO_MANY_PENDING`，消息说明维度。status 的 quotas 包含 token、account、ip 的 limit/remaining/retryAfter，pending/globalPending 的 limit/remaining，以及本人待审内容涉及的 hostnames 的 pendingCount/limit/remaining。待审余量基于 submissions 队列，审核或替代记录后释放。

内容规则：name 最多 60 字、description 最多 300 字；评价 title 最多 100 字、summary 最多 200 字、authorName 最多 30 字、body 最多 5000 字。报价使用已有模型，最多 100 项且不得重复，rate 遵循共享常量的 0.05~20 区间。根字段之外的投稿元数据不能由客户端指定。任意层级出现 uptime、firstTokenLatencyMs、foundedAt、status、score、lowestRate、authorHandle 或 apiKey、api_key、token、password、secret、accessToken、refreshToken、clientSecret、privateKey、authorization、credentials 等敏感字段都返回 `400 FORBIDDEN_FIELD` 并指明字段，字段名大小写及下划线/连字符变体同样拒绝。

URL 只允许 http/https，去掉 query、fragment 和用户名密码，规范化主机名及尾点；拒绝内网 IPv4、IPv6 私有/回环/本地地址以及 localhost、.localhost、.local、.internal。评价 hostname 使用同一地址检查。此入口只保存内容，不访问所提交网址；缺失的实测指标在审核物化时一律写 null，新站点标注为「AI 采集，未经平台核实」，更新已有站点保留原来源。

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
5. 替换 `deploy/nginx-site.conf.template` 的占位符后启用，并删掉发行版自带的 default 站点（两个 `default_server` 会冲突）。模板只监听 IPv4，Host 不是本站的请求直接断开，`/api/admin/` 默认只允许本机（IP 白名单，见「管理接口」一节）。
6. 给部署用户配置免密 sudo，只授权 `deploy.sh` 用到的两条命令（`sudo visudo -f /etc/sudoers.d/zhidedeng`，`deploy` 换成实际用户）：

   ```
   deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart zhidedeng, /usr/bin/journalctl -u zhidedeng -n 50 --no-pager
   ```

### 容器部署的备份（与上面 systemd 直跑不同）

容器部署时数据库在 docker 卷里、宿主机没有对容器的写锁协调，所以用
`deploy/zhidedeng-docker-backup.sh`：在**容器内**以只读连接执行 `VACUUM INTO`
（SQLite 保证 WAL 下的一致性快照），`docker cp` 取出来后再校验
`integrity_check` 与实体数，最后留最近 14 份。备份含密码哈希与会话摘要，权限 0600。

```sh
sudo install -m 0755 deploy/zhidedeng-docker-backup.sh /usr/local/bin/zhidedeng-backup
# /etc/systemd/system/zhidedeng-backup.{service,timer} 里设
#   Environment=BACKUP_DIR=/var/backups/zhidedeng
#   Environment=BACKUP_KEEP=14
#   ExecStart=/usr/local/bin/zhidedeng-backup
sudo systemctl enable --now zhidedeng-backup.timer
sudo systemctl start zhidedeng-backup.service   # 立刻验证一次
```

**这一条必须做**：没有备份时，一次误操作、磁盘故障或 `VACUUM` 中断就是全站数据丢失，
而库里是用户投稿、审核记录和账号。定时器默认 04:00 触发、带 10 分钟随机延迟、
`Persistent=true`（关机错过的会在开机后补跑）。

之后每次发布，在本地：

```sh
DEPLOY_HOST=user@your-server deploy/deploy.sh
```

它会跑测试、构建、rsync、重启服务并做健康检查（`GET /api/health`）。可选变量见脚本开头。

演示数据只在空库时写入。改了 `server/src/seed.ts` 不会影响已有数据库。

## 管理接口

不对公网开放：nginx 对 `/api/admin/` 返回 404，要在服务器本机直连。都要 `Authorization: Bearer $SYNC_TOKEN`，未配置密钥时一律拒绝。写接口要求 `Content-Type: application/json`。

### 让管理台用起来不那么麻烦

`deploy/nginx-site.conf.template` 里的 `/api/admin/` 用的是 **IP 白名单**（`allow` + `deny all`），默认只放行 `127.0.0.1`。想直接在浏览器打开管理台，就在那个 location 的 `deny all` **之前**加一行自己的出口 IP：

```nginx
location /api/admin/ {
    allow 127.0.0.1;
    allow 203.0.113.7;      # 你的固定 IP
    # allow 10.8.0.0/16;    # 或者一个网段
    deny all;
    ...
}
```

改完 `nginx -s reload`。用 IP 白名单而不是再加一层密码：管理接口本身已有 `SYNC_TOKEN` 校验，白名单是第二道；万一密钥泄漏，攻击者还得在这个网段里。

如果 IP 不固定，退回 SSH 隧道：

```sh
ssh -L 8787:127.0.0.1:8787 <服务器>
# 然后浏览器打开 http://127.0.0.1:8787/admin
```

管理台页面本身在公网可访问（`/admin` 是前端路由），但所有数据请求都会被反代挡下，页面会提示「管理接口未对公网开放」并给出上面这条命令。

```sh
ADMIN=http://127.0.0.1:8787   # PORT 与环境文件一致

# 待审投稿
curl -H "Authorization: Bearer $SYNC_TOKEN" "$ADMIN/api/admin/posts?status=pending"
# 待审投稿队列，可按一次飞书同步返回的 batchId 筛选
curl -H "Authorization: Bearer $SYNC_TOKEN" "$ADMIN/api/admin/submissions?batchId=<batchId>"

# 用户忘了密码，管理员代为重置（会同时清掉该账号全部会话与 Agent 凭证）
curl -H "Authorization: Bearer $SYNC_TOKEN" -H 'Content-Type: application/json' \
  -d '{"username":"alice","newPassword":"一个新的长口令"}' \
  "$ADMIN/api/admin/accounts/reset-password"
# 人工确认后审核整批 pending；已审核条目会跳过，下架请求也在此人工审核
curl -X POST -H "Authorization: Bearer $SYNC_TOKEN" -H 'Content-Type: application/json' \
  -d '{"batchId":"<batchId>","status":"approved"}' "$ADMIN/api/admin/submissions/batch-review"
# 自动通过仅作用于 upsert：上架、更新和评价；下架始终等待人工确认
curl -X POST -H "Authorization: Bearer $SYNC_TOKEN" -H 'Content-Type: application/json' \
  -d '{"autoApprove":true}' "$ADMIN/api/admin/settings"
# 通过或拒绝用户文章（status: approved | rejected）。已上线的群友文章在此返回 409，待审飞书内容用投稿队列审核
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
# 删除模型。仍被站点报价引用时返回 409 MODEL_IN_USE 和引用它的站点数，不会删除
curl -X DELETE -H "Authorization: Bearer $SYNC_TOKEN" -H 'Content-Type: application/json' \
  -d '{"confirm":true}' "$ADMIN/api/admin/models/<slug>"
# 新增厂商。iconKey 缺省等于 slug；没有内置图标的厂商在前端降级显示站内图标
curl -X POST -H "Authorization: Bearer $SYNC_TOKEN" -H 'Content-Type: application/json' \
  -d '{"slug":"stepfun","name":"阶跃星辰"}' "$ADMIN/api/admin/vendors"
```

通用导入接口 `/api/admin/import` 保留，完整处理输入中的站点并替换原报价，不再按原来源跳过。它默认拒绝未收录的模型；带 `"allowNewModels": true` 时，未知模型会建成 vendor 为 `unknown` 的占位模型，响应里的 `createdModels` 列出新建的 slug。投稿队列中的未知模型逐条报错，需要先在模型管理接口补录。

## 同步飞书收集表

`scripts/sync-feishu.ts` 用 lark-cli 只读读取多维表格，把审核状态严格等于「通过」的记录聚合成一个投稿批次。同一 hostname 的信息合成一个站点，评价各自入队；每次最多提交 500 条，超过时串行分块并共用一个 `batchId`，管理员仍可以审核整批。默认待人工确认，开启自动通过只让 upsert（上架、更新和评价）立即生效；下架始终保持 pending，等管理员人工确认。

同步会读取 `/api/admin/submissions/state`，只对比「飞书确实同步过、且仍在线的站点」——不限站点最初的 `source`，因为被飞书同 hostname 认领过的 agent 站必须也能自动下架，否则飞书里删掉它只能人工改库；演示站除外。表格中已消失的站点生成同批次的下架请求，payload 包含实际 `slug` 和 state 返回的当前 `submissionId`；人工审核时再检查版本，站点已更新则返回 `409 STALE_REMOVAL` 并保留站点与报价。审核通过才删除站点与报价，已有评价保留；旧全量导入中没有对应 approved 飞书投稿的存量站点不参与下架检测。服务端按站点 URL 的 hostname 覆盖客户端 originKey，统一小写、IDN 和端口；飞书原有的 www 与裸域名分组继续沿用，更新时保留旧站点 slug。同组里同时有 www 与裸域两条站时认领优先级是**在线整条地址 > 已下架整条地址 > 在线精确 > 已下架精确 > 在线分组 > 已下架分组**（整条地址含路径与端口，用来区分同 hostname 不同路径的历史重复站）：否则一条投稿会选中另一条、把两条改成同一个 url，前端出现两条一模一样的站，其中一条再也不被同步、也进不了下架计划。只有分组兜底命中时（组里没有精确写法的那条），站点 url 会跟着投稿里的写法更新——身份是 slug，不是 url。地址里 hostname 末尾的 FQDN 点（`example.com.`）在**入库前**就归一掉，所以库里不会同时存在两种写法。同请求中的重复站点整批返回 400，已被其他渠道占有的 batchId 返回 409。管理接口不对公网开放，脚本要在服务器本机运行（服务器上要有仓库、Node 依赖和 lark-cli）。

```sh
export LARKSUITE_CLI_CONFIG_DIR=...  # lark-cli 配置目录，必填，不回落到默认的 ~/.lark-cli
export FEISHU_BASE_TOKEN=... FEISHU_TABLE_ID=...
export SITE_URL=http://127.0.0.1:8787 # 服务器本机地址
#容器部署时这里是发布到宿主机的端口（compose里是8788），不是容器内的8787。
export SYNC_TOKEN=...                 # 与服务环境文件相同，完整 dry-run 计划也需要

pnpm sync:feishu --dry-run           # 只读 GET，打印计划或中止原因
pnpm sync:feishu
pnpm sync:feishu --allow-skipped     # 显式跳过坏记录，本次只提交 upsert，不同步下架
```

### 定时同步

手工跑一次只适合试水。长期运行用仓库里的 systemd 单元：

```sh
sudo cp deploy/zhidedeng-sync.service deploy/zhidedeng-sync.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now zhidedeng-sync.timer   # 每 30 分钟一次，随机延迟 2 分钟
journalctl -u zhidedeng-sync.service -n 100        # 看最近一次跑了什么
```

`Type=oneshot` + timer：跑完就退出，不占用常驻内存，也不会出现两次同步叠在一起。默认只提交待审批次，不会自作主张上线；要自动通过请用 `--auto-approve`，并且只对 upsert 生效，下架永远留在审核台。

单元文件依赖 `/etc/zhidedeng/zhidedeng.env` 里的 `FEISHU_BASE_TOKEN`、`FEISHU_TABLE_ID`、`LARKSUITE_CLI_CONFIG_DIR`、`SYNC_TOKEN`、`SITE_URL`，以及服务器上的 lark-cli。缺任何一个，timer 会照常触发但脚本会打印原因后中止——不会写坏数据。

**开了定时器之后，下架要在表格里做，不要只点审核台。**站点身份以飞书表格为准：表格里还留着那条记录，下一轮同步（最多30分钟）就会按正常投稿把它重新上架——这是「群友填错、重新提交就该恢复」的既有设计，不是 bug。要真正下线，先在表格里删掉该行，同步会生成下架请求，人工批准后站点才彻底消失（之后表格里没有它，也就不会再被复活）。同理 `/api/admin/import`会**跳过**已下架的站点并提示「需要人工恢复」。两条入口的取舍是刻意的：导入是管理员批量灌数据，不该顺带撤销人工下架；同步的权威来源是表格，表格里还在就等于还在架。

同步和 `--dry-run` 共用数据安全检查：任何记录无法解析时以退出码 2 中止，不发 POST；成功解析的站点为零且线上仍有站点时也中止，避免空表清空线上。显式传 `--allow-skipped` 才跳过坏记录继续，且无论有无坏记录都完全不生成下架请求，并打印 `本次不同步下架` 警告；空表保护仍然生效。

`--dry-run` 绝不发送 POST。数据有效且未配置 `SYNC_TOKEN` 时只预览上架/更新和评价，并明确打印 `跳过下架检测：未配置 SYNC_TOKEN`，此时无法检查线上空表风险；配置 token 后打印完整计划。正式同步遇到逐条入队失败会列出失败条目并以非零退出码结束。分块不是整批事务，已成功的条目或分块会保留，日志中的 batchId 可用于查询和人工审核。

表格字段：中转站名称、网址、提交类型（推荐新站 / 更新信息 / 使用评价 / 避坑反馈）、模型与倍率（多行，每行「模型名=倍率」）、最低充值（元）、支付方式、推荐指数（1-5）、使用体验、展示昵称、审核状态（待审核 / 通过 / 拒绝）、审核备注、提交时间。审核备注不会外传。

读取失败、返回结构无法识别或关键字段被改名时，脚本中止且不入队，避免生成错误的下架请求。

## 数据说明

- 名称带「虚构」的站点、倍率、可用率、延迟、评论和评测是演示数据，不对应任何真实服务。
- 标注「群友提交，未经平台核实」的站点和评价来自表单。它们没有可用率和延迟数据，页面显示「暂无」，正文按纯文本显示。
- 标注「AI 采集，未经平台核实」的站点和评价来自 Agent 投稿并经人工审核，实测指标缺失时同样显示「暂无」。
- 以上内容都不构成消费建议。

## 免责声明

本项目与什么值得买及任何模型厂商、中转站均无关联。厂商名称和图标仅作分类标识，商标归各自权利人所有。

## 已知未修

- 没有自助找回密码（收不到邮件），也不能注销账号。忘记密码只能由管理员重置：`POST /api/admin/accounts/reset-password`，会同时清掉该账号的全部会话与 Agent 凭证。
- 登录和 Agent 提交的速率计数写在库里的 `rate_limits` 表，多进程共用同一个库文件时配额才是全局限额；跨主机部署仍需换成共享存储（比如 Redis）。计数带窗口，过期记录在写入时顺带清理，不随重启清零。
- 按用户名计数的登录退避可以被别人用来把某个账号挡在登录外最多 15 分钟。
- 登录的三个计数维度与退还规则：`IP+账号`（5 次/15 分钟，成功即清空）、`按账号`（20 次/15 分钟，**成功也计**）、`按 IP`（30 次/15 分钟，成功后退还）。按账号不退是为了拦住「单人拿自己的正确密码循环打登录、占满密码校验闸门」；按 IP 退是为了不让同一出口 IP 后面的其他人被拖累（办公室、学校、运营商 CGNAT 常常几十人共用一个 IP）。代价是：同一个 IP 下面的人如果都在**失败**地试密码，仍然会共享那 30 次。
- 没有数据库迁移工具，上线后再改表结构要自己写 `ALTER`。建表用的是 `CREATE TABLE IF NOT EXISTS`，对已存在的库不生效——表结构只在新库上按代码里的定义创建。`offers.rate` 上那条早期的 `CHECK(rate > 0)` 因此在老库里改不掉；倍率区间 `0.05 ~ 20` 由应用层强制，新写入一律按它校验。
- 存量飞书站点（只有实体、没有投稿记录）在切到队列模式后无法下架：下架要根据投稿记录比对版本，查不到就永远返回 `STALE_REMOVAL`。上线前跑一次 `pnpm backfill:submissions --db=<路径> [--apply]` 补出 approved 投稿记录；默认是 dry-run，只打印不写库，可重复执行。
- 禁用账号不会自动隐藏它已发布的内容，要逐条隐藏评论或拒绝投稿。
- 被飞书同 hostname 认领过的 agent 站会进入飞书的下架计划（否则飞书里删掉它时清不掉）。代价是：这个站此后每次被 agent 重新提交上架，只要飞书那边的记录已经不在快照里，下一次同步就会把它再下架一次。内容不丢（软删除，指标保留），但表现为「agent 说上架了、同步又让它下线」。要长期保留就把它从飞书侧彻底移除并改成独立的 agent 站（换个 hostname）。
### 分页保持 `LIMIT/OFFSET`（已评估，决定不改）

排序键是 `(createdAt, rowid)`，单次请求内的 count 与 items 来自同一读快照。残留的问题是：两次请求之间若有新记录插入（或某条从 pending 变 approved），翻到后一页时可能重复一条或漏掉一条。

按本站的实际规模，这个风险不值得改契约：

- 线上数据量是 13 个站点、49 篇文章、19 条投稿。按每页 20 条算，绝大多数字段只有一页，根本没有「翻页」这个动作。
- 前端是顺序加载更多（`loadMore` 只请求 `page + 1`），从不跳页，也从不回退重取。
- 改游标分页要动 `shared` 的请求类型、`PaginationQuery`、所有列表接口与前端 `usePaged`，而且会丢掉「跳到第 N 页」的能力——管理端按 total 显示总条数就没了。

**什么时候需要重新评估**：任一类内容的单页返回量长期接近页大小、且期间有持续写入时（例如投稿队列常态几百条、管理员边审边有人提交）。那时的最省事做法是只给管理端列表加游标参数，公开列表保持不动。
- 中文口令的强度判定按长度与「明显规律」判，不按字符种类——中文口令的字符种类天然很少。
- **文章列表把 `status='approved'` 下推给了 SQLite**（配表达式索引 `entities_post_approved`），所以待审/被拒的文章不再付 JSON 解析成本。实测 5000 篇：`getPosts(latest)` 276→209ms、`hot` 603→315ms、社区榜 625→163ms。但剩下的 200ms 是「取出 4548 行 + 逐行解析」的固有成本，要再降需要把标题/摘要/时间做成生成列，那仍要面对「老库没有这一列」的迁移问题。`getMyPosts` 仍走 `store.all('post')` 后按作者过滤（已配 `entities_post_author` 索引给计数用）。
- **收藏与文章列表的「我的」页面已改成先分页再组装**：`getMyFavorites` 1000 收藏从 1565ms/6108 SQL 降到 85ms；`getMe` 的 `favoriteCount` 用一次 JOIN 数「目标仍可见」的收藏，279→21ms。注意 `readablePost` 认可「只在 submissions 里的自己的待审稿」，计数与列表必须共用这套判定，改动任一处都要同步另一边。
- **首屏字体体积偏大**：字体按 `unicode-range` 切成 203 个 woff2（dist 里共 11MB），实测首屏只拉 23 个、共 790KB（`font-display: swap`，不阻塞 FCP）。要再小得做构建期字体子集化。gzip 已覆盖静态资源**与 API**（`compress()` 必须注册在任何路由之前，注册晚了只压得到之后的路由——上一版就漏了整个 `/api/*`）。
- **站点报价是整包替换**：提交一个已存在站点的 `offers` 会替换它现有的全部报价，没写的等于删掉。这是刻意设计（飞书全量同步要能反映「下架了哪些模型」），所以 `zdd` 提供了 `zdd station <slug>` 让提交前先看现有报价；审核台也会显示「报价将被整包替换为 N 条」和最低倍率变化。但**没有逐条增量的 API**。
- **报价的计价口径现在有字段了，但历史数据全是「综合」**：`offers.basis` 取值 `blended`（输入输出混算）/ `input` / `output` / `package`，`offers.quotedAt` 记来源给出的报价时间（可为 null，表示来源没说）。老库启动时自动 `ALTER` 补列，老行按 `blended` 读，不回填。仍未做的是**同一站点的分口径拆行**：一个站点在一个模型上只能有一条报价，所以「输入 0.3、输出 0.9」这种双价只能登记成两条不同模型的报价，不能是同一模型的两行。要支持得改主键为 `(stationSlug, modelSlug, basis)`，以及配套的整包替换语义。`lowestRate`（卡片上的「低至」）只统计 `blended`，没有任何综合口径报价时返回 null 显示「暂无」——不拿局部价冒充整站最低价。
- **全站待审熔断（200 条）只数用户侧渠道**（`agent` / `web`），不数飞书批次。飞书是受信通道，一次全量同步天然几百条；早先熔断数全渠道，同步刚跑完所有用户就被 `QUEUE_FULL` 挡住，要人工审完几百条才恢复。现在同步的量由批次审核流程消化，不再连累用户。代价是飞书队列可以无限堆积，靠同步侧自行分批。
- 中转站 URL 只去掉 query 和 fragment，路径原样保留并公开展示——路径里若带邀请码或令牌，会进入页面。靠人工审核把关。
- `TRUSTED_PROXIES` 的含义是「这个网段里有一个反代在**覆写** `X-Forwarded-For`」，不是「请求来自这个网段」。两者搞混的后果方向相反：
  - 该配没配：所有请求的来源都记成网关地址，按 IP 的限流退化成全站共用一个桶（一个人就能把全站注册/登录打到 429）。
  - 不该配却配了：端口直映射进容器时前面没有任何代理，客户端自带的 `X-Forwarded-For` 会被原样采信，换一次头就是一个新桶，按 IP 的上限直接归零。
  仓库里的 `docker-compose.yml` 是端口直映射形态，所以默认留空；`deploy/nginx-site.conf.template` 那套（nginx 用 `proxy_set_header X-Forwarded-For $remote_addr` 覆写）才需要配。启动日志会针对这两种组合分别告警。
- 代码侧对 `X-Forwarded-For` 逐段做 IP 校验，非法段直接丢弃，避免限流键变成任意字符串。但这挡不住「伪造一个合法 IP」——那只能靠上面这条部署约定。
- 生产环境要设 `TLS_ENABLED=1`，此时会话 cookie 一律带 `Secure`。这个开关就是运维在断言「本站对外是 HTTPS」，所以它不看请求头、也不依赖 `TRUSTED_PROXIES`——早先三者耦合，导致开了 TLS 但漏配反代时 Secure 被静默丢掉，HTTPS 站点上的会话 cookie 会随任意明文请求发出去。
  反过来的误配（声明了 TLS 实际却在 http 上访问）会让浏览器丢弃 cookie，表现为登录成功却立刻变回未登录，启动日志会对此告警。纯本机 http 试用保持 `TLS_ENABLED=0`。
- Docker 镜像是单进程、单库的部署形态。要横向扩到多容器，SQLite 与 `rate_limits` 都不再适用，需要换共享存储。
- 真实站没有可用率，默认排序排在演示站之后；前端站点目录只取 50 个，超过后部分文章卡片缺站名。按得分、可用率或倍率排序时，缺失值一律排在最后；同分（同可用率、同倍率）的站点按 slug 定序，保证是严格全序——否则同值站在翻页之间会来回换位，第 1 页能重复出现第 2 页的条目。
- **批量审核会阻塞事件循环**：500 条 `batch-review` 约 8 秒，期间 `/api/health` 也要排队（单进程 + 同步 SQLite 的固有特性）。已把「每条都全表扫站点找 hostname」换成带版本失效的索引缓存（12.3s→8.1s），要再降需要拆进程或换异步驱动，与当前规模不匹配。
- **`POST /api/me/checkin` 接受空 body**：它是唯一「不限频 + 有写入 + 有奖励」的接口，content-type 闸门在这里是空档。靠 `SameSite=Lax` + 每账号每天一次兜底，没有额外 token 校验。
- **`/api/health` 未认证就会暴露数据库与前端产物状态**（`database: ok` / `frontend: missing`）。运维需要这些信息，但如果直接把端口暴露到公网，等于告诉扫描者「前端没部署好」。建议只在反代后或本机访问。
- **`/api/agent/status` 不限频**：每次调用会 `UPDATE agent_tokens SET useCount = useCount + 1`（一次写事务），凭证持有者可以持续刷它让 WAL 增长。已改成只读事务（`BEGIN DEFERRED`），不再抢写锁，但没有次数上限。
- **审核列表已按 `createdAt DESC` 排序**（最新在前）。同一站点有多个待审版本时，按列表从上往下审会先通过最新版本、旧版本随后被 `superseded`；批次审核还要额外保住依赖顺序（站点/模型先于文章，否则文章物化时按 hostname 找不回 slug）。
- **保留昵称与重名判定统一走 `normalizeNickname()`**（去零宽/BOM/软连字符 + NFKC + trim + lower）。早先只做 `trim()`，「管理员」被拒但「管理员\u200B」能注册成功。改这个函数会同时影响注册、改资料、保留名单三处。
- **autoApprove 开启后，新账号发一篇站内文章即可满足 Agent 凭证的「7 天或一篇 approved 投稿」资格**。这是设计交互不是漏洞：资格门槛要的是「一篇审核通过的站内投稿」，自动通过只是把人工审核这一步自动化了。需要收紧时关掉 autoApprove，或在 `requireEligibility` 里额外要求账号年龄。
- **`hostname` 限额（2 条）是跨账号的**：先提交的人可以占满名额，其他账号在同一 hostname 上会收到 `TOO_MANY_PENDING`。按账号收窄会让 N 个账号各刷 2 条、上限形同虚设，所以保留跨账号，并接受这个代价。

## 第三方素材

- 厂商图标来自 [@lobehub/icons-static-svg](https://www.npmjs.com/package/@lobehub/icons-static-svg)，MIT 许可。
- 字体通过 Fontsource 自托管 Noto Sans SC、Noto Serif SC 和 JetBrains Mono，均为 SIL Open Font License。
- 首页 Banner（`web/public/banners/`）是 AI 生成的插画。

## 许可证

[MIT](./LICENSE)
