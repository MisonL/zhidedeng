import { useEffect, useId, useRef, useState } from 'react';

/**
 * 需要二次确认的破坏性操作。
 *
 * 为什么不用 `window.confirm`：它阻塞整个渲染进程，在移动端浏览器里样式不可控，
 * 而且读屏软件只能念到一串没有上下文的文字。更实际的问题是——它在测试里必须
 * 一个个打桩，于是**大部分调用点干脆没有测试**，误点下架、误点「全部通过」
 * 这类不可撤销的操作就一直没有回归保护。
 *
 * 行为：点一下在原按钮旁边展开「追问 + 确认 / 取消」，确认后执行。展开时焦点
 * 落到确认按钮上，收起后还给原按钮。原按钮始终留在 DOM 里（只是禁用），
 * 这样焦点不会掉到 body、`aria-expanded` 也始终指向一个真实存在的节点。
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
    // 展开时确认按钮接管了焦点，收起后要把焦点还回去。
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  return (
    <span className="confirm-slot">
      <button
        ref={triggerRef} type="button" className="text-btn"
        disabled={busy || open}
        aria-expanded={open} aria-controls={id}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      {open && (
        <span className="confirm-inline" id={id} role="group" aria-label={description}>
          <span className="confirm-ask">{description}</span>
          <button
            ref={confirmRef} type="button" disabled={busy}
            className={tone === 'red' ? 'btn btn-small btn-red' : 'btn btn-small btn-ghost'}
            onClick={() => {
              // 失败也要收起：每个调用点自己负责把错误显示出来。留在这里不收，
              // 用户会面对一个「处理中…」永远不会变的按钮。
              void Promise.resolve(onConfirm()).then(close, () => close());
            }}
          >
            {busy ? '处理中…' : confirmLabel}
          </button>
          <button type="button" className="btn btn-small btn-ghost" onClick={close}>取消</button>
        </span>
      )}
    </span>
  );
}
