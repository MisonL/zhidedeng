# @zhidedeng/shared

前后端共用的 API 契约，依据 `docs/spec.md`。入口为 `src/index.ts`，不包含服务器或页面实现。

- `domain.ts`：领域实体、详情聚合、互动状态、评论回复、排行榜条目。
- `api.ts`：25 个公开接口的请求与成功响应、分页、统一错误和 `ApiContracts` 对照表，以及导入接口的内容类型（管理接口不进 `ApiContracts`）。
- `routes.ts`：带 `/api` 前缀的 `API_ROUTES`，键必须与 `ApiContracts` 一致。

请求类型表示已解析的参数：列表请求为 query，详情请求为 path 参数，写请求为 JSON body。网络边界负责解析和校验。

文章 ID、评论 ID 使用字符串；中转站的互动 targetId 使用 slug，文章使用 id。可用率使用 0~100 的百分数，没有实测数据的指标为 null，赞同比例使用 0~1，价格仅使用相对倍率。时间使用 ISO 字符串，可缺省的关联在响应中显式为 null。评论列表分页顶层评论，回复放入 replies，禁止多层嵌套。
