import { useState } from 'react';
import { api } from '../api';
import { useMe, useToast } from '../state';

const COST = 5;

/**
 * 给一篇别人的文章送花（5 Token）。
 *
 * 只在登录、非作者、文章已上线时出现。花不能收回也不能转让——所以按钮上直接
 * 写明价格，点之前就知道要花多少，不做「先点再确认」那一套二次流程。
 */
export default function FlowerButton({ postId }: { postId: string }) {
  const me = useMe();
  const toast = useToast();
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const balance = me.data?.tokens ?? 0;
  if (me.data === null) return null;

  async function send() {
    setBusy(true);
    setError(undefined);
    try {
      await api.redeemTokens({
        itemKey: 'flower', targetId: postId,
        // 每次点击都是一个独立的意图；网络重试才该复用同一个键。
        idempotencyKey: `flower-${postId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
      setSent(true);
      await me.refreshMe();
      toast('花已经送到作者那里了');
    } catch (cause) {
      // 409 ALREADY_TIPPED：说明这一篇之前送过（可能换了设备/清了缓存）。
      // 切到「已送花」比留一个点了永远报错的按钮更诚实。
      if ((cause as Error).message.includes('已经给这篇文章送过花')) setSent(true);
      else setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (sent) return <span className="hint">已送花 🌸</span>;
  return (
    <span className="flower-button">
      <button type="button" className="btn btn-small btn-ghost" disabled={busy || balance < COST} onClick={send}>
        {busy ? '送花中…' : `送一朵花（${COST} Token）`}
      </button>
      {balance < COST && <span className="hint">Token 不够，去签到攒</span>}
      {error && <span className="form-error" role="alert">{error}</span>}
    </span>
  );
}
