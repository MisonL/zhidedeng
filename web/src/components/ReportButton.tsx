import { useState } from 'react';
import { api } from '../api';
import { useRequireLogin, useMe } from '../state';

/** 常见举报原因。点一下填上，也可以自己写。 */
const REASONS = ['内容不实或夸大', '含广告或推广', '人身攻击或辱骂', '泄露他人隐私', '其他违规内容'];

/**
 * 举报入口。
 *
 * 刻意做成「展开一小块表单」而不是弹窗：举报是一个低频动作，弹窗会遮住
 * 被举报的内容，用户反而看不清自己要举报什么。
 *
 * 提交成功后按钮变成「已举报」并禁用——服务端对同一人对同一对象的重复举报
 * 返回 409，前端不该让用户靠点第二次才知道自己已经报过了。
 */
export default function ReportButton({ targetType, targetId }: { targetType: 'post' | 'station' | 'comment'; targetId: string }) {
  const me = useMe();
  const requireLogin = useRequireLogin();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);

  // 未登录不渲染入口：举报必须能追到人，匿名的「有人说」在处置时毫无用处。
  if (!me.data) return null;
  if (done) return <span className="hint">已举报，等待处理</span>;

  if (!open) {
    return (
      <button type="button" className="text-btn" onClick={() => { if (requireLogin()) setOpen(true); }}>
        举报
      </button>
    );
  }

  async function submit() {
    const text = reason.trim();
    if (!text) return setError('请选择或填写举报原因');
    setBusy(true);
    setError(undefined);
    try {
      await api.createReport({ targetType, targetId, reason: text, ...(detail.trim() ? { detail: detail.trim() } : {}) });
      setDone(true);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      // 已经报过不算失败：目的已经达到了，再让用户对着红色错误发呆没有意义。
      if (code === 'ALREADY_REPORTED') setDone(true);
      else setError((cause as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="report-box">
      <p className="field-label">举报原因</p>
      <div className="tags">
        {REASONS.map((preset) => (
          <button
            key={preset} type="button" className="tag" aria-pressed={reason === preset}
            onClick={() => { setReason(preset); setError(undefined); }}
          >
            {preset}
          </button>
        ))}
      </div>
      <input
        aria-label="举报原因" value={reason} maxLength={200} placeholder="也可以自己写一句"
        aria-invalid={Boolean(error)} onChange={(event) => { setReason(event.target.value); setError(undefined); }}
      />
      <textarea
        aria-label="补充说明（可选）" rows={2} maxLength={500} value={detail}
        placeholder="补充说明（可选）" onChange={(event) => setDetail(event.target.value)}
      />
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="tags">
        <button type="button" className="btn btn-small btn-red" disabled={busy} onClick={() => { void submit(); }}>
          {busy ? '提交中…' : '提交举报'}
        </button>
        <button type="button" className="btn btn-small btn-ghost" onClick={() => setOpen(false)}>取消</button>
      </div>
      <p className="hint">举报会进入人工审核队列。我们不会自动下架内容，也不会告知你处理结果。</p>
    </div>
  );
}