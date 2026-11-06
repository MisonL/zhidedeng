# 什么值得蹬

AI 模型中转站的导购与点评社区：比较相对倍率，看社区评测，投「值 / 不值」。

## 功能

- 中转站库和模型库，按模型比较各站的相对倍率
- 文章信息流、评测、指南、社区讨论，排行榜和全站搜索
- 用户名密码注册登录，可改密码；投票、收藏、签到按账号存，投票数和收藏数公开累计
- 评论登录后发布即公开，有频率限制；投稿先审后发
- 管理接口：导入群友提交、审核投稿、隐藏评论、禁用账号（没有后台页面，在服务器本机用 curl 调用）
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

数据库默认在 `server/data/app.db`，空库自动写入演示数据。数据结构没有迁移工具，本地升级后如果报字段缺失，停掉服务删库重来：

```sh
rm -f server/data/app.db*
```

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
# 通过或拒绝投稿（status: approved | rejected）。群友提交的文章返回 409，要到飞书撤销「通过」后重新同步
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

导入接口默认拒绝未收录的模型。后续给 Agent/群友队列接入时可以带 `"allowNewModels": true`，未知模型会自动建成 vendor 为 `unknown` 的占位模型（名称即 slug，描述标记待补全），响应里的 `createdModels` 列出本次新建的 slug。

## 同步飞书收集表

`scripts/sync-feishu.ts` 用 lark-cli 只读读取多维表格，把审核状态严格等于「通过」的记录全量发布到站点。撤销「通过」或删除的记录，下次同步后从站点消失。账号、投票、评论和用户投稿不受影响。导入接口不对公网开放，脚本要在服务器本机运行（服务器上要有仓库、Node 依赖和 lark-cli）。

```sh
export LARKSUITE_CLI_CONFIG_DIR=...  # lark-cli 配置目录，必填，不回落到默认的 ~/.lark-cli
export FEISHU_BASE_TOKEN=... FEISHU_TABLE_ID=...
export SITE_URL=http://127.0.0.1:8787 # 服务器本机地址
export SYNC_TOKEN=...                 # 与服务环境文件相同，--dry-run 不需要

pnpm sync:feishu --dry-run           # 只打印将发布的内容和跳过原因
pnpm sync:feishu
```

表格字段：中转站名称、网址、提交类型（推荐新站 / 更新信息 / 使用评价 / 避坑反馈）、模型与倍率（多行，每行「模型名=倍率」）、最低充值（元）、支付方式、推荐指数（1-5）、使用体验、展示昵称、审核状态（待审核 / 通过 / 拒绝）、审核备注、提交时间。审核备注不会外传。

读取失败、返回结构无法识别或关键字段被改名时，脚本中止且不发布，避免把站点清空。

## 数据说明

- 名称带「虚构」的站点、倍率、可用率、延迟、评论和评测是演示数据，不对应任何真实服务。
- 标注「群友提交，未经平台核实」的站点和评价来自表单。它们没有可用率和延迟数据，页面显示「暂无」，正文按纯文本显示。
- 以上内容都不构成消费建议。

## 免责声明

本项目与什么值得买及任何模型厂商、中转站均无关联。厂商名称和图标仅作分类标识，商标归各自权利人所有。

## 已知未修

- 没有找回密码，也不能注销账号。
- 登录限流在进程内，重启清零，也只适用于单进程。
- 按用户名计数的登录退避可以被别人用来把某个账号挡在登录外最多 15 分钟。
- 没有数据库迁移工具，上线后再改表结构要自己写 `ALTER`。
- 禁用账号不会自动隐藏它已发布的内容，要逐条隐藏评论或拒绝投稿。
- 中转站 URL 只去掉 query 和 fragment，路径里的邀请码过滤不到，靠人工审核。
- 真实站没有可用率，默认排序排在演示站之后；前端站点目录只取 50 个，超过后部分文章卡片缺站名。

## 第三方素材

- 厂商图标来自 [@lobehub/icons-static-svg](https://www.npmjs.com/package/@lobehub/icons-static-svg)，MIT 许可。
- 字体通过 Fontsource 自托管 Noto Sans SC、Noto Serif SC 和 JetBrains Mono，均为 SIL Open Font License。
- 首页 Banner（`web/public/banners/`）是 AI 生成的插画。

## 许可证

[MIT](./LICENSE)
