import { Link } from 'react-router';
import type { Author } from '@zhidedeng/shared';
import { authorPath } from '../pages/Author';

/**
 * 作者名。有账号的链到主页，没有账号的不出链接。
 *
 * 飞书同步来的文章作者是 `anonymous-submission`（没有真实账号），
 * Agent 提交的也可能只有 handle 没有实体。把它们也链到 `/u/:handle`，
 * 用户点进去必然是 404——链接就得能点得动，点不动的就别做成链接。
 */
/**
 * 内置/导入来源的 handle 白名单：这些不是注册用户，没有 `/u/:handle` 主页。
 *
 * 飞书同步的文章作者是 `feishu-submission`，Agent 提交的可能是
 * `agent-submission` 之类；导出的历史数据里还出现过 `anonymous-submission`。
 * 逐个枚举容易漏，所以再叠一条「昵称是服务端降级占位」的判断。
 */
const NO_PROFILE_HANDLES = new Set([
  'feishu-submission', 'anonymous-submission', 'agent-submission',
  // submissions.ts 在既无 actorHandle 也无 authorHandle 时写 'unknown'。
  'unknown',
]);

export default function AuthorName({ author }: { author: Author }) {
  const hasProfile = !NO_PROFILE_HANDLES.has(author.handle) && !author.nickname.startsWith('已注销用户·');
  if (!hasProfile) return <span className="post-source">{author.nickname}</span>;
  return <Link className="post-source" to={authorPath(author.handle)}>{author.nickname}</Link>;
}
