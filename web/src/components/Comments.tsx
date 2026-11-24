import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import type { Comment, CommentReply, TargetType } from '@zhidedeng/shared';
import { api } from '../api';
import { formatDate, loginPath } from '../format';
import { usePaged } from '../hooks';
import { useHere, useMe, useRequireLogin } from '../state';
import AsyncView, { Empty, LoadMore } from './AsyncView';
import ConfirmButton from './ConfirmButton';
import ReportButton from './ReportButton';
import { Avatar } from './visuals';

const MAX_LENGTH = 2000;

function CommentForm({ label, submitLabel, onSubmit }: {
  label: string; submitLabel: string; onSubmit: (content: string) => Promise<void>;
}) {
  const [content, setContent] = useState('');
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const text = content.trim();
    if (!text) return setError('评论内容不能为空');
    setSubmitting(true);
    setError(undefined);
    try {
      await onSubmit(text);
      setContent('');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="comment-form" onSubmit={handleSubmit}>
      <textarea
        aria-label={label} placeholder="说说你的真实体验…" rows={3} maxLength={MAX_LENGTH}
        value={content} onChange={(event) => setContent(event.target.value)}
      />
      <div className="comment-form-foot">
        {error ? <span className="form-error">{error}</span> : <span className="num hint">{content.length}/{MAX_LENGTH}</span>}
        <button type="submit" className="btn btn-red btn-small" disabled={submitting}>{submitLabel}</button>
      </div>
    </form>
  );
}

export default function Comments({ targetType, targetId }: { targetType: TargetType; targetId: string }) {
  const paged = usePaged(
    (page, signal) => api.getComments({ targetType, targetId, page, pageSize: 20 }, signal),
    [targetType, targetId],
  );
  const [added, setAdded] = useState<Comment[]>([]);
  const [replies, setReplies] = useState<Record<string, CommentReply[]>>({});
  const [replyTo, setReplyTo] = useState<string>();
  // 本地已删除/已墓碑的 id。删除后就地更新，不再整页重取：
  // 重取会让列表跳回第一页，用户正看到第 3 页时删一条会莫名其妙回到顶部。
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [tombstones, setTombstones] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<string>();
  const me = useMe();
  const here = useHere();
  const requireLogin = useRequireLogin();

  async function addComment(content: string) {
    const created = await api.createComment({ targetType, targetId, content }) as Comment;
    setAdded((list) => [created, ...list]);
  }

  async function removeComment(id: string) {
    // 只有自己写的评论才会渲染这个按钮，所以不用再问一次「这是你的吗」；
    // 但服务端仍会校验（不是自己的回 404），前端不是权限边界。
    setDeleting(id);
    try {
      const result = await api.deleteComment(id);
      if (result.deleted === 'tombstoned') setTombstones((set) => new Set(set).add(id));
      else setRemovedIds((set) => new Set(set).add(id));
    } finally {
      setDeleting(undefined);
    }
  }

  async function addReply(parentId: string, content: string) {
    const created = await api.createComment({ targetType, targetId, content, parentId }) as CommentReply;
    setReplies((map) => ({ ...map, [parentId]: [...(map[parentId] ?? []), created] }));
    setReplyTo(undefined);
  }

  return (
    <section className="module comments" id="comments" aria-label="评论">
      <header className="module-head"><h2 className="module-title">评论</h2></header>
      {me.data === null
        ? <p className="hint comment-login"><Link to={loginPath(here)}>登录</Link>后发表评论</p>
        : <CommentForm label="写评论" submitLabel="发表评论" onSubmit={addComment} />}
      <AsyncView
        state={paged}
        isEmpty={(items) => items.length + added.length === 0}
        empty={<Empty title="还没有评论，来抢沙发" />}
      >
        {(items) => (
          <ul className="comment-list">
            {/* 发表后分页偏移，后续页会再次返回已显示的评论；保留先出现的一条，其本地回复才不会与服务端回复重复。 */}
            {[...added, ...items]
              // 本地删掉的先滤掉；服务端已标记墓碑的保留一行，因为下面还挂着别人的回复。
              .filter((comment) => !removedIds.has(comment.id))
              .filter((comment, index, list) => list.findIndex(({ id }) => id === comment.id) === index)
              .map((comment) => {
                const tombstoned = tombstones.has(comment.id) || comment.deleted;
                return (
              <li key={comment.id} className="comment">
                <Avatar nickname={comment.author.nickname} />
                <div className="comment-main">
                  <p className="comment-meta">
                    <strong>{comment.author.nickname}</strong>
                    <time className="num" dateTime={comment.createdAt}>{formatDate(comment.createdAt)}</time>
                  </p>
                  {tombstoned
                    ? <p className="comment-content comment-deleted">该评论已删除</p>
                    : <p className="comment-content">{comment.content}</p>}
                  <div className="comment-actions">
                    {!tombstoned && (
                      <button type="button" className="text-btn" onClick={() => { if (requireLogin()) setReplyTo(comment.id); }}>回复</button>
                    )}
                    {!tombstoned && me.data?.handle !== comment.author.handle && (
                      <ReportButton targetType="comment" targetId={comment.id} />
                    )}
                    {!tombstoned && me.data?.handle === comment.author.handle && (
                      <ConfirmButton
                        label="删除" tone="red" busy={deleting === comment.id}
                        description="删除后无法恢复，确定删除这条评论？"
                        confirmLabel="删除"
                        onConfirm={() => removeComment(comment.id)}
                      />
                    )}
                  </div>
                  {replyTo === comment.id && (
                    <CommentForm
                      label={`回复 ${comment.author.nickname}`} submitLabel="发表回复"
                      onSubmit={(content) => addReply(comment.id, content)}
                    />
                  )}
                  {[...comment.replies, ...(replies[comment.id] ?? [])].map((reply) => (
                    <div key={reply.id} className="comment-reply">
                      <Avatar nickname={reply.author.nickname} size={24} />
                      <div className="comment-main">
                        <p className="comment-meta">
                          <strong>{reply.author.nickname}</strong>
                          <time className="num" dateTime={reply.createdAt}>{formatDate(reply.createdAt)}</time>
                        </p>
                        <p className="comment-content">{reply.content}</p>
                        {me.data?.handle === reply.author.handle && (
                          <ConfirmButton
                            label="删除" tone="red" busy={deleting === reply.id}
                            description="删除后无法恢复，确定删除这条回复？"
                            confirmLabel="删除"
                            onConfirm={() => removeComment(reply.id)}
                          />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </li>
                );
              })}
          </ul>
        )}
      </AsyncView>
      <LoadMore paged={paged} />
    </section>
  );
}
