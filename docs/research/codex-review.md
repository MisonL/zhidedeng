## 核实结果

| 核查项 | 判断 | 证据 |
|---|---|---|
| SQLite 建表与迁移 | 核心判断成立：`CREATE TABLE IF NOT EXISTS` 不会改造已有表，缺列需要显式 `ALTER TABLE`。但调研称“新列迁移必须在 `SCHEMA` 之后”不准确。现有代码已在 `SCHEMA` 前补旧库的 `entities.removedAt` 和 `submissions` 列，在之后补 `offers` 列。F3 新增的 `entities.removedBy/removedReason` 还必须进入新库的建表定义，否则新库不会执行针对既有表的迁移分支。[database.ts](/Volumes/Work/orca/zhidedeng-wt/deploy-test/server/src/database.ts:20) [node-app.ts](/Volumes/Work/orca/zhidedeng-wt/deploy-test/server/src/node-app.ts:26) [research-tech.md](/tmp/research-tech.md:429) |
| `removedAt`、唯一约束与统计 | 软删除不会删除实体行或释放 `(kind,id)` 主键。`Store.put` 会清空 `removedAt`，因此没有额外守卫时重写实体会复活内容。投票、收藏、评论是独立表，不会级联删除；目标下架后收藏数按可见性排除，文章恢复后互动记录仍在。调研对“复活”和互动保留的担忧成立，但必须把下架与物理删除分开表述。[database.ts](/Volumes/Work/orca/zhidedeng-wt/deploy-test/server/src/database.ts:213) [service.ts](/Volumes/Work/orca/zhidedeng-wt/deploy-test/server/src/service.ts:350) |
| 一层回复与删父评论 | 回复按 `parentId` 分组，顶层分页只选 `parentId IS NULL`，因此保留父评论墓碑确有上下文作用。父行有任何子行时物理删除会触发外键错误。调研的判断还不完整：它按“可见子回复”决定是否物理删除，隐藏子回复仍有外键引用，照样会失败；按 `parentId` 计数也没有专用索引。[database.ts](/Volumes/Work/orca/zhidedeng-wt/deploy-test/server/src/database.ts:48) [service.ts](/Volumes/Work/orca/zhidedeng-wt/deploy-test/server/src/service.ts:779) [node-app.ts](/Volumes/Work/orca/zhidedeng-wt/deploy-test/server/src/node-app.ts:21) |
| `Service.author()` 非空断言 | 断言存在。用户实体缺失时解构会抛异常。不过调研把它说成注销后必然导致列表 500，过于绝对：如果注销流程保留墓碑用户并正确改写文章作者和评论作者引用，公开内容仍能找到用户实体。若删除用户实体却遗漏引用，才会触发故障。兜底仍值得做，作为损坏或历史孤儿数据的韧性措施。[service.ts](/Volumes/Work/orca/zhidedeng-wt/deploy-test/server/src/service.ts:167) [research-tech.md](/tmp/research-tech.md:1246) |
| 关注通知与 SQLite 性能 | 采用同步 SQLite 写扩散可能造成事件循环阻塞，这个方向合理；但“500 粉必然撞墙”“每人 50 条、10–30ms”等数字没有当前库的基准支持。22 个账号也不足以证明需要 500 人硬上限。 proposed 的 actor 索引不能天然消除多作者范围上的全局排序成本，需用真实查询计划和数据规模测量。[database.ts](/Volumes/Work/orca/zhidedeng-wt/deploy-test/server/src/database.ts:49) [research-tech.md](/tmp/research-tech.md:1345) |
| SPA 的 sitemap/RSS/OG 路径 | 技术路径成立：当前 Hono 与前端同进程，`mountWeb` 会将未知前端 GET 回退到 `index.html`，所以 sitemap、RSS、robots 需要显式服务端响应，社交预览需要 HTML head 元信息。[static.ts](/Volumes/Work/orca/zhidedeng-wt/deploy-test/server/src/static.ts:22) [node-app.ts](/Volumes/Work/orca/zhidedeng-wt/deploy-test/server/src/node-app.ts:135) |
| `compare` 静态路由顺序 | 调研的警告成立。锁定 Hono 4.13.16 默认 SmartRouter 在静态段与参数段冲突时会尝试 TrieRouter；TrieRouter 按注册顺序排列匹配处理器。因此 `/api/stations/compare` 应先于 `/api/stations/:slug` 注册。[Hono router](/Volumes/Work/orca/zhidedeng-wt/deploy-test/node_modules/.pnpm/hono@4.13.16/node_modules/hono/dist/router/trie-router/node.js:127) [app.ts](/Volumes/Work/orca/zhidedeng-wt/deploy-test/server/src/app.ts:768) |
| 当前功能缺口与规格文档 | Token 目前由注册初始值和签到增加，没有消费入口。头像写入值为空且更新接口不接收头像，不过前端已有昵称首字母与颜色构成的默认头像。文章没有作者自助编辑/删除，评论没有作者自助删除，也没有举报、关注、通知、对比或 SEO 路由。另一个重要漂移是 `docs/spec.md` 仍称站内文章直接写入实体，当前 `POST /api/posts` 实际经 `enqueueSubmission` 入队。[service.ts](/Volumes/Work/orca/zhidedeng-wt/deploy-test/server/src/service.ts:526) [visuals.tsx](/Volumes/Work/orca/zhidedeng-wt/deploy-test/web/src/components/visuals.tsx:54) [docs/spec.md](/Volumes/Work/orca/zhidedeng-wt/deploy-test/docs/spec.md:64) [app.ts](/Volumes/Work/orca/zhidedeng-wt/deploy-test/server/src/app.ts:771) |

## 三份调研的问题

1. **F3 新增实体列的迁移对新库不完整。** 调研给出了 `ensureEntityColumns`，但没有要求把新列加入 `SCHEMA`。当前 `openDatabase` 只在 `hasEntities` 为真时补旧实体列。新库跳过这段，随后按不含新列的定义建表，代码若使用新列就会失败。[research-tech.md](/tmp/research-tech.md:429) [node-app.ts](/Volumes/Work/orca/zhidedeng-wt/deploy-test/server/src/node-app.ts:32)

2. **文章与评论删除路由没有接上路径参数。** `/api/posts/:id` 和 `/api/comments/:id` 的设计使用 `route()`，但该派发器对非 GET 只解析请求体，不把 `c.req.param()` 合进输入，handler 也拿不到 `c`。F2 提到了修派发器，F3/F4 的排期却在 F2 之前，且两项没有写明采用手写路由或先扩展派发器。[research-tech.md](/tmp/research-tech.md:417) [research-tech.md](/tmp/research-tech.md:516) [app.ts](/Volumes/Work/orca/zhidedeng-wt/deploy-test/server/src/app.ts:524)

3. **评论墓碑策略忽略了隐藏回复。** F4 只统计可见回复，再决定物理删父行。隐藏回复仍然引用父 ID，外键不会因为它不可见就消失。最后一条可见回复删除后也只有在没有任何子行时才能删除墓碑父行。[research-tech.md](/tmp/research-tech.md:560) [database.ts](/Volumes/Work/orca/zhidedeng-wt/deploy-test/server/src/database.ts:50)

4. **注销文章作者的 SQL 会碰撞实体主键。** F10 草案以一条 `UPDATE entities SET id = ?` 更新该账号所有文章。若一个账号有多篇文章，它们会被赋同一个实体 ID，违反 `(kind,id)` 主键；即使改成逐行唯一 ID，也会破坏文章 URL。匿名化作者字段应保留文章实体 ID。[research-tech.md](/tmp/research-tech.md:1230) [database.ts](/Volumes/Work/orca/zhidedeng-wt/deploy-test/server/src/database.ts:26)

5. **注销流程内部互相矛盾，统计身份也需先定规则。** 一处称保留账号和用户实体，另一处又要求改 `accounts.handle`、删除旧用户实体；运营文档建议永久保留旧用户名，技术稿则释放用户名并换墓碑 handle。投票、收藏、关注、投稿、举报和 Agent 凭证的匿名化策略也不一致，必须先形成一个可执行的身份和保留期契约。[research-tech.md](/tmp/research-tech.md:1150) [research-tech.md](/tmp/research-tech.md:1238) [research-tech.md](/tmp/research-tech.md:1275) [research-ops.md](/tmp/research-ops.md:126)

6. **运营文档把法律判断写成了已验证要求，并与技术稿冲突。** “举报是法定义务”“具体 SLA 是法律实践下限”等结论没有本轮独立法律依据。运营稿还建议特定举报先自动隐藏，技术稿却明确反对举报数触发自动下架。对外承诺时限或自动隐藏应由实际处置能力和法律意见决定，不能直接从这份调研变成代码规则。[research-ops.md](/tmp/research-ops.md:315) [research-tech.md](/tmp/research-tech.md:697)

7. **“必须 revision 表”被过度表述。** 运营稿称文章编辑必须有 revision 表，技术稿的方案则是保留已上线旧版、将新版本放进现有投稿队列，并在审核通过时替换。这个流程不要求新建历史表，独立表只在需要完整版本历史、diff 或回滚时才成立。[research-ops.md](/tmp/research-ops.md:270) [research-tech.md](/tmp/research-tech.md:274)

8. **demo 和 SEO 的建议互相冲突，也高估了硬约束。** 技术稿允许 demo 进入 sitemap，并认为标记足够；运营稿要求清理 demo、默认排除对比。当前 `sourceLabel()` 对 demo 返回 `null`，所以“显示 sourceLabel 就能区分 demo”不成立。被搜索引擎缓存是风险，但不能据此断言违反 `docs/spec.md` 的明确规则。对比和 sitemap 应显式排除 demo 或展示明确的虚构标记。[research-tech.md](/tmp/research-tech.md:1118) [research-ops.md](/tmp/research-ops.md:224) [format.ts](/Volumes/Work/orca/zhidedeng-wt/deploy-test/web/src/format.ts:18) [docs/spec.md](/Volumes/Work/orca/zhidedeng-wt/deploy-test/docs/spec.md:17)

9. **路线图把大量低证据功能一次性产品化。** “Token 积分只是装饰、兑换能增加回访”“站点对比一定要新接口”“单进程通知必须先设 500 关注上限”都缺少当前用户行为或性能基准。UX 稿还建议用 Token 换邀请码或投稿额度，这会把免费签到积分变成 Agent 准入或内容供给能力，增加审核负担。项目目前真实内容产出稀少，先实现整套奖励经济和社交图谱没有证据支持。[research-tech.md](/tmp/research-tech.md:57) [research-tech.md](/tmp/research-tech.md:976) [research-ux.md](/tmp/research-ux.md:145)

## 我的整合建议

| 功能 | 建议 | 理由 | 前置条件 |
|---|---|---|---|
| 举报 | **优先做最小人工处理闭环** | 已有公开 UGC，发现和处理入口的价值高；举报不得自动影响可见性或排名 | 明确处理负责人、回执内容、审计身份和不承诺 SLA 的运营流程 |
| 评论删除 | **近期做** | 是直接用户控制；父评论需保留上下文 | 以任何子行判断是否保留父墓碑；定义内容清除与备份保留语义 |
| 账号注销 | **尽快定策略后做** | 影响用户控制、身份重用和历史内容归属，是跨表高风险变更 | 明确是否释放用户名、会话宽限期、内容匿名化、投票/收藏/举报保留规则 |
| 文章删除 | **近期做“撤下公开展示”** | 范围比编辑小，但不能声称物理删除 | 区分作者撤回和管理员下架；覆盖未审核投稿的取消 |
| 头像 | **做预设选择** | 现有默认头像可用，字段和资料更新接口已经存在 | 枚举白名单；同步更新文章、评论、榜单和首页头像显示 |
| Token 消耗 | **推迟** | 没有证据表明用户需要兑换；积分经济、账本迁移、幂等和奖励运营会扩大范围 | 先验证真实用户对积分的用途需求；不得兑换排序、投票权重、邀请码或投稿额度 |
| 文章编辑 | **推迟** | 审核中保留旧版的队列方案可行，但会增加投稿、审核、列表和冲突处理复杂度 | 有真实作者编辑需求后限定可编辑来源和字段，并回归审核及发布排序 |
| 关注/通知 | **砍掉用户关注，通知推迟** | 当前没有作者主页，内容供给低；社交关系和事件系统投入大 | 有稳定内容后先做投稿结果、回复等本人相关的站内通知 |
| 站点对比 | **条件做，优先轻量版本** | 最多对比 2–3 个站，现有详情接口可提供报价，未必需要新 API | 排除或明确标示 demo；按计价口径比较；缺失值保持 null |
| SEO | **推迟 sitemap/RSS 的公开提交** | 缺少稳定真实内容与已确认的 canonical 域名；外部索引回收慢 | 确认公开域名、来源说明、demo 处理和内容分发授权；服务端输出 XML 与动态 OG |

**批次顺序**

1. 先定删除、匿名化、数据保留、人工处理职责和管理员身份记录。不要先做回执 SLA 或自动隐藏。
2. 做举报最小闭环、评论自删和文章撤下展示。评论删除先解决隐藏子回复和父墓碑的外键边界。
3. 做账户注销与头像预设。注销单独发布，逐项核对会话外键、文章作者、评论、投票、收藏、投稿和审计记录。
4. 在 demo 明确排除或标记后做站点对比，先复用详情 API 验证需求。
5. 真实内容稳定产生后评估站内通知，再评估文章编辑和 Token 消耗。
6. 有公开域名、稳定内容和明确的对外分发规则后上线 sitemap、RSS 与 OG。

## 最容易踩的三个坑

1. **新旧库走不同迁移路径。** F3 新增实体列若只靠 `ensureColumn`，新库不会在建表后自动拥有它们；必须同时维护新库 `SCHEMA` 和旧库迁移。
2. **评论删父的“可见性”不等于“没有子行”。** 隐藏回复仍受外键约束；同时 `route()` 不提供 DELETE 路径参数，接口方案必须补齐参数传递。
3. **注销时重写身份引用。** 不能用一个 tombstone ID 更新用户全部文章，也不能只看 `Service.author()`；账户主键有 sessions 外键，多个业务表保存独立的 handle 字符串。

本轮只做静态核验，没有运行测试或查询生产服务。仓库在开始和结束时均为指定 HEAD `11fab7e`、无工作区改动。由于只读权限，报告正文未能写入 `/tmp/codex-review.md`。


