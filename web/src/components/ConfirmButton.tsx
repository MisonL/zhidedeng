import { useEffect, useId, useRef, useState } from 'react';

/**
 * 需要二次确认的破坏性操作。
 *
 * 为什么不用 `window.confirm`：它阻塞整个渲染进程，在移动端浏览器里样式不可控，
 * 而且读屏软件只能念到一串没有上下文的文字。更实际的问题是——它在测试里必须
 * 一个个打桩，于是**大部分调用点干脆没有测试**，误点下架、误点「全部通过」
 * 这类不可撤销的操作就一直没有回归保护。
 *
 * 行为：点一下变成「确认 / 取消」两个按钮，确认后执行。展开时焦点自动落到
 * 确认按钮上，取消或成功后焦点还给原按钮，键盘用户不会掉到页面顶部。
 */
export default function ConfirmButton({
  label, description, confirmLabel = '确认', busy = false, tone = 'ghost', onConfirm,
}: {
  /** 未展开时的按钮文字。 */
  label: string;
  /** 展开后追问的那句话，要说清后果（尤其是不可撤销）。 */
  description: string;
  confirmLabel?: string;
  busy?: boolean;
  tone?: 'ghost' | 'red';
  onConfirm: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (open) confirmRef.current?.focus();
  }, [open]);

  function close() {
    setOpen(false);
    // 展开时确认按钮接管了焦点，收起后原按钮已经重新挂载，要把焦点还回去。
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  if (!open) {
    return (
      <button
        ref={triggerRef} type="button" className="text-btn" disabled={busy}
        aria-expanded={false} aria-controls={id}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
    );
  }

  return (
    <span className="confirm-inline" id={id} role="group" aria-label={description}>
      <span className="confirm-ask">{description}</span>
      <button
        ref={confirmRef} type="button" disabled={busy}
        className={tone === 'red' ? 'btn btn-small btn-red' : 'btn btn-small btn-ghost'}
        onClick={() => { void Promise.resolve(onConfirm()).then(() => close()); }}
      >
        {busy ? '处理中…' : confirmLabel}
      </button>
      <button type="button" className="btn btn-small btn-ghost" onClick={close}>取消</button>
    </span>
  );
}
