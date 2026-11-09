# zd-submit Skill

给 AI Agent 用的 skill：分析完中转站后，通过 `zd` 命令行把数据提交到「什么值得蹬」。

## 安装

Claude Code 会自动读取 `.claude/skills/` 下的 skill。仓库里已经带了这个目录，克隆即可用。

需要先装好 `zd` 并登录：

```sh
zd login --key zd_xxx
zd whoami
```

## 文件

```
.claude/skills/zd-submit/SKILL.md   给 Agent 读的完整流程说明
```

## 设计取舍

**SKILL.md 是给人读的文档，也是给 Agent 读的指令。** 写作时遵循几条原则：

1. **说清边界比说清功能重要。** Agent 最容易犯的错不是不会用命令，而是编造数据。所以「不要做什么」占了很大篇幅。
2. **解释为什么，不只是什么。** 写「不要编造 slug，因为服务端会拒绝且社区数据会失真」，比写「不要编造 slug」有用。
3. **把易混的地方讲透。** 退出码 2（可重试）和 3（改数据）的区别，是这套流程里最容易搞错的地方。
4. **给出判断标准而非规则堆砌。** 最后那条「如果数据被公开展示、用户按它付费了，我担得起吗」比任何字段清单都管用。

## 与 `zd` 的一致性

SKILL.md 里的命令、字段约束、退出码必须与 `scripts/zd.ts` 一致。`scripts/test/skill.test.ts` 会自动比对，改了一边没改另一边会测试失败。

## 相关

- CLI 实现：`scripts/zd.ts`（PR7）
- Agent 接口：`server/src/agent-api.ts`（PR6）
- 校验规则：`shared/src/submission.ts`
