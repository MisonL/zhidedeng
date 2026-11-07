# 什么值得蹬 · 规格

定位：AI API 中转站的导购与点评社区，用值/不值投票、排行榜和信息流帮人选站。
Slogan：我们的AI中转指南。

## 技术栈与布局

- pnpm workspace，Node 22，TypeScript 严格模式
- `shared/`：`@zhidedeng/shared`，只放 API 类型（前后端的唯一契约）
- `server/`：Hono + `node:sqlite`，端口 8787，测试用 vitest；启动时自动建表，空库自动灌种子；生产环境同时托管前端
- `web/`：Vite + React 19 + react-router，端口 5173，`/api` 代理到 8787；测试用 vitest + testing-library

## 数据诚信（硬约束）

- 种子里的中转站都是虚构样例，名称、倍率、可用率、延迟、评论、评测均为演示数据，严禁在种子里使用真实中转站名称
- 群友经飞书表单提交、审核状态为「通过」的内容，页面标明「群友提交，未经平台核实」，正文按纯文本显示
- 没有实测数据的可用率、延迟等指标一律为 null，页面显示「暂无」，不当 0 分也不编造；综合得分随可用率为 null，排序时排在最后
- 全站页脚常驻声明，同时说清演示数据和群友提交；中转站详情页顶部按来源显示对应声明
- 价格只用「相对官方价的倍率」（如 0.6x），不写任何官方绝对价格
- 厂商名和模型名可用真实名称，只作分类用途

## 领域模型

- Vendor：slug、名称、图标 key。固定 11 家，顺序：OpenAI、Anthropic、Google、DeepSeek、xAI、Meta、阿里通义、字节豆包、月之暗面、智谱AI、MiniMax
- Model：slug、vendor、名称、一句话简介、标签
- Station：slug、名称、简介、网址、来源、充值门槛、支付方式、可用率、首 token 延迟 ms、成立时间、状态（running / unstable），后六项无数据时为 null 或空
- StationOffer：station × model × 倍率
- Post：kind（deal 爆料 / review 评测 / community 社区 / guide 指南）、标题、摘要、正文 markdown、作者、可关联 station 与 model、封面、发布时间、来源、审核状态（pending / approved / rejected）
- Vote：user × post 或 station，值 / 不值，每人每对象一票，可改可撤
- Favorite、Comment（支持一层回复，可被隐藏）、CheckIn（每日一次，发放 Token 积分，连续天数）
- User：handle、昵称、头像、简介、token 积分；Account：用户名和密码哈希，种子用户没有账号，不能登录

## 账号与权限

- 用户名 + 密码注册，不要邮箱和手机号。用户名 3~20 位字母数字下划线，大小写不敏感唯一；昵称可中文；密码至少 8 位，scrypt 加随机盐。暂不支持找回密码；可在账户设置改密码，成功后其他会话失效
- 会话是随机 token，HttpOnly、SameSite=Lax、生产环境 Secure，30 天；库里只存 SHA-256；可登出
- 登录和注册进程内限流（IP + 用户名、用户名、IP 三层，失败次数在校验密码前预占），错误文案不区分用户名不存在、密码错和账号被禁用；拒绝常见弱密码；写接口要求 Content-Type: application/json
- 未登录只读，写接口和个人接口返回 401 UNAUTHENTICATED。新用户初始 120 Token
- 投票数和收藏数对所有人公开累计；评论登录后发布即公开，每账号每分钟 5 条
- 投稿每账号每小时 10 篇、待审最多 20 篇。提交后是 pending，只有作者能在我的分享和详情页看到，通过后才公开。种子文章公开；飞书内容先进入投稿队列，默认待人工审核

## 页面

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
- `/docs`：本站公开只读 API 文档，不含管理接口
- `/business`：商务合作说明页，不编造联系方式，写明「联系方式待配置」

## 首屏布局

1. 顶栏：红色圆形印章 Logo「蹬」+ 站名「什么值得蹬」+ slogan；居中大搜索框；下方热门搜索
2. 导航：左侧 首页 / 模型 / 社区 / 评测，右侧 API文档 / 商务合作 / 投稿分享 ▾ / 登录 | 注册（已登录显示昵称菜单）
3. 三栏：左为厂商列表（悬停展开该厂商模型浮层）；中为 Banner 轮播；右为用户卡（未登录显示引导和登录按钮，已登录显示 Token、签到、我已经分享）
4. 排行榜：标题 + 模型/社区/达人 tab + 查看更多
5. 其下为「值得蹬」信息流：卡片含值/不值投票与比例条、评论数、收藏、站点和模型标签，可筛选和加载更多

## 视觉规格

- 页面底暖白，内容区定宽 1200 居中，模块白底，圆角 8~12，柔和阴影
- 主红 `#E62828`；正文 `#333`，次级 `#666`，弱化 `#999`
- 字体自托管 Noto Serif SC（站名和标题）、Noto Sans SC（正文）、JetBrains Mono（数字）
- 适配 400px 手机宽度

## 管理接口

用 SYNC_TOKEN 做 Bearer 校验，未配置时一律拒绝。不写进公开的 `/docs`，也不进 `API_ROUTES`，具体路径见 README。只允许从服务器本机访问，nginx 对公网返回 404。能力：将站点、模型和评价写入投稿队列，列出待审内容、按 batchId 整批审核，隐藏或恢复评论、禁用或恢复账号。通用导入接口保留供运维使用，飞书同步不再走全量覆盖。另有不需要登录的健康检查，也不进 `API_ROUTES`。

飞书只读取表格中审核状态为「通过」的记录，聚合成投稿批次；每次请求最多 500 条，分块共用同一个 batchId 和渠道。站点 originKey 由服务端根据 payload.url 规范化，飞书沿用 www 与裸域名归并规则，同请求中的重复站点会整批拒绝。默认先审后发，开启自动通过只立即物化 upsert；下架始终 pending，需要管理员人工确认。下架携带 state 返回的当前 approved 投稿 id，版本已更新时返回 409 STALE_REMOVAL，站点和报价保留。没有 approved 飞书投稿记录的存量站点不参与下架比较，已有评价保留。

解析失败或成功解析的站点为零且线上仍有站点时，同步和 dry-run 都以退出码 2 中止，不发 POST。显式使用 --allow-skipped 可以跳过坏记录，但本次完全不同步下架，并打印警告；空表保护仍然生效。

## API（全部 JSON，前缀 /api）

列表统一 `{ items, total, page, pageSize }`，参数 `page`、`pageSize`。错误统一 `{ error: { code, message } }`。

- `POST /auth/register`（username、password、nickname?）、`POST /auth/login`、`POST /auth/logout`、`POST /auth/password`（currentPassword、newPassword）
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
