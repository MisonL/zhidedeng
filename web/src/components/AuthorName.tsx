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
export default function AuthorName({ author }: { author: Author }) {
  // 服务端对缺失用户实体的降级昵称是「已注销用户·handle」，那个同样没有主页。
  const hasProfile = author.handle !== 'anonymous-submission' && !author.nickname.startsWith('已注销用户·');
  if (!hasProfile) return <span className="post-source">{author.nickname}</span>;
  return <Link className="post-source" to={authorPath(author.handle)}>{author.nickname}</Link>;
}
