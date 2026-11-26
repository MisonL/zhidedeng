import { useState } from 'react';
import type { Feedback as Item, FeedbackVerdict } from '@zhidedeng/shared';
import { api } from '../api';
import { useMe } from '../state';
import { formatDate } from '../format';
import AsyncView, { LoadMore } from './AsyncView';
import { usePaged } from '../hooks';

const VERDICTS: { value: FeedbackVerdict; label: string }[] = [
  { value: 'works', label: '能用' },
  { value: 'slow', label: '有点慢' },
  { value: 'broken', label: '挂了' },
];

const VERDICT_LABEL: Record<FeedbackVerdict, string> = { works: '能用', slow: '有点慢', broken: '挂了' };

/**
 * 站点页的「一句话反馈」。
 *
 * 刻意和评论区并列而不是合并：评论是讨论，这里是签到。合成一个框的结果是
 * 评论区变成一堆「+1」和「502 了」，真正想说话的反而被淹掉。
 *
 * 页面上必须写明这是**用户自述**。读者很容易把「挂了」当成平台实测结论，
 * 那正好违反数据诚信那条约束（不编造实测指标）。
 */
export default function Feedback({ stationSlug }: { stationSlug: string }) {
  const me = useMe();
  const paged = usePaged((page, signal) => api.getFeedback({ stationSlug, page, pageSize: 10 }, signal), [stationSlug]);
  const [verdict, setVerdict] = useState<FeedbackVerdict>('works');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();

  async function submit() {
    const text = content.trim();
    if (!text) return setError('写一句话再提交');
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      await api.createFeedback({ stationSlug, verdict, content: text });
      setContent('');
      setMessage('已记下，谢谢你');
      // 不整页重取：重取会把用户刚写的自己那条挤到列表顶部之外的位置。
      paged.reload();
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      // 「今天已经留过」不是错误，是事实：说清楚比让人反复点强。
      if (code === 'ALREADY_FEEDBACK') setMessage((cause as Error).message);
      else setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(undefined);
    try {
      await api.deleteFeedback(id);
      paged.reload();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="feedback">
      <h2 className="section-title">最近有人试过</h2>
      <p className="hint">用户自述，未经平台核实。下面的「能用/挂了」是一句话反馈，不是实测指标。</p>

      {me.data ? (
        <div className="feedback-form">
          <div className="tags">
            {VERDICTS.map(option => (
              <button
                key={option.value} type="button" className={`tag ${verdict === option.value ? 'tag-good' : ''}`}
                aria-pressed={verdict === option.value} onClick={() => setVerdict(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <input
            aria-label="一句话反馈" value={content} maxLength={140} placeholder="比如：充了 10 块，第二天 502"
            onChange={(event) => { setContent(event.target.value); setError(undefined); }}
          />
          <button type="button" className="btn btn-small btn-red" disabled={busy} onClick={() => { void submit(); }}>
            {busy ? '提交中…' : '记一句'}
          </button>
          {error && <p className="form-error" role="alert">{error}</p>}
          {message && <p className="form-success" role="status">{message}</p>}
        </div>
      ) : <p className="hint">登录后可以留一句话。</p>}

      <AsyncView state={paged} isEmpty={(items: Item[]) => items.length === 0} empty={<p className="hint">还没有人留下反馈。</p>}>
        {(items: Item[]) => (
          <ul className="feedback-list">
            {items.map(item => (
              <li key={item.id}>
                <span className={`tag ${item.verdict === 'broken' ? 'tag-warn' : item.verdict === 'works' ? 'tag-good' : ''}`}>
                  {VERDICT_LABEL[item.verdict]}
                </span>
                <span className="feedback-text">{item.content}</span>
                <span className="hint">
                  {item.author.nickname} · <time className="num" dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
                </span>
                {item.mine && (
                  <button type="button" className="text-btn" disabled={busy} onClick={() => { void remove(item.id); }}>删除</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </AsyncView>
      <LoadMore paged={paged} />
    </section>
  );
}
