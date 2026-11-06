# 后端

Hono + Node 22 `node:sqlite`，契约与路径来自 `@zhidedeng/shared`，请求在路由边界用 Zod 校验。启动、部署和环境变量见[根 README](../README.md)。

## 约定

- 列表返回 `{ items, total, page, pageSize }`，默认 `pageSize=20`，超过 50 钳制到 50。
- 错误格式为 `{ error: { code, message } }`：非法输入 400 `INVALID_INPUT`，未登录 401 `UNAUTHENTICATED`，缺失资源 404 `NOT_FOUND`，请求体过大 413，非 JSON 写请求 415，限频 429 `RATE_LIMITED`。
- `Service` 按请求构造，身份只来自会话 Cookie，没有全局可变状态。
- 公开列表、搜索和榜单只读 `approved` 文章；待审和被拒投稿只有作者能在我的分享和详情页看到。
- 导入只替换 `source=submission` 的站点、报价和文章，不碰账号和互动。被撤销对象上的收藏和评论留在库里但不显示，对象恢复后回来。
- 文章正文存储时保留原文，渲染和清理是前端的责任；群友提交的正文按纯文本显示。

## 排序

- 模型榜按 `站点数 + 1 / 最低倍率`；社区榜按 `值票 × 2 + 评论数`；达人榜按作者文章收到的值票数，只列有公开文章的账号。各榜最多 12 条。
- hot 按 `净值票 / (文章年龄小时数 + 2)^1.3`，同分按最新时间。
- 站点 score 综合可用率、赞同比例与最低倍率；可用率为 null 时 score 也为 null，排序时排在有分数的站点之后。
- 签到日期按 `Asia/Shanghai` 计算，每日基础 10 Token，连续第 N 天额外 `min(N,7)`。
