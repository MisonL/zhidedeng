import { useState } from 'react';
import type { FormEvent } from 'react';
import type { CreateAgentTokenResponse } from '@zhidedeng/shared';
import { api } from '../api';
import AsyncView, { Empty } from '../components/AsyncView';
import { useAsync } from '../hooks';

const displayTime = (iso: string) => new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

export default function AgentTokens() {
  const tokens = useAsync(signal => api.getAgentTokens(signal), []);
  const [label, setLabel] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [issued, setIssued] = useState<CreateAgentTokenResponse>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const activeCount = tokens.data?.filter(token => token.revokedAt === null).length;

  async function generate(event: FormEvent) {
    event.preventDefault();
    if (!label.trim()) return setMessage({ ok: false, text: '请填写凭证名称' });
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await api.createAgentToken({ label: label.trim(), ...(inviteCode.trim() ? { inviteCode: inviteCode.trim() } : {}) });
      setIssued(result);
      setLabel('');
      setInviteCode('');
      tokens.reload();
    } catch (error) {
      setMessage({ ok: false, text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await api.revokeAgentToken(id);
      tokens.setData(tokens.data!.map(token => token.id === id ? { ...token, revokedAt: result.revokedAt, status: 'revoked' as const } : token));
      if (issued?.id === id) setIssued(undefined);
      setMessage({ ok: true, text: '凭证已吊销' });
    } catch (error) {
      setMessage({ ok: false, text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-agent-tokens" aria-labelledby="agent-tokens-title">
      <h2 id="agent-tokens-title" className="section-title">AI Agent 凭证</h2>
      <p className="hint">注册满 7 天、已有一篇通过的非演示投稿，或持有有效邀请码即可生成，每个账号最多 5 个活跃凭证。</p>
      <form className="settings-form" onSubmit={generate} noValidate>
        <div className="field">
          <label className="field-label" htmlFor="agent-token-label">凭证名称</label>
          <input id="agent-token-label" maxLength={100} value={label} onChange={event => setLabel(event.target.value)} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="agent-token-invite">邀请码（可选）</label>
          <input id="agent-token-invite" autoComplete="off" maxLength={200} value={inviteCode} onChange={event => setInviteCode(event.target.value)} />
        </div>
        <button type="submit" className="btn btn-red submit-btn" disabled={busy || issued !== undefined || activeCount === undefined || activeCount >= 5 || !label.trim()}>{busy ? '处理中...' : '生成凭证'}</button>
      </form>
      {issued && (
        <div className="agent-token-issued">
          <p role="status">明文仅显示一次，请立即保存；隐藏或离开设置页后无法取回。</p>
          <div className="field">
            <label className="field-label" htmlFor="agent-token-secret">新凭证明文</label>
            <input id="agent-token-secret" autoComplete="off" readOnly value={issued.token} onFocus={event => event.currentTarget.select()} />
          </div>
          <button type="button" className="btn btn-ghost" onClick={() => setIssued(undefined)}>已保存，隐藏凭证</button>
        </div>
      )}
      {message && <p className={message.ok ? 'form-success' : 'form-error'} role={message.ok ? 'status' : 'alert'}>{message.text}</p>}
      {activeCount !== undefined && <p className="hint">{activeCount}/5 个活跃凭证</p>}
      <AsyncView state={tokens} isEmpty={items => items.length === 0} empty={<Empty title="暂无 Agent 凭证" />}>
        {items => (
          <div className="table-scroll">
            <table className="data-table agent-token-table" aria-label="Agent 凭证列表">
              <thead><tr><th>名称</th><th>前缀</th><th>创建时间</th><th>最后使用</th><th>使用次数</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>
                {items.map(token => (
                  <tr key={token.id}>
                    <td>{token.label}</td><td><code>{token.tokenPrefix}</code></td>
                    <td><time dateTime={token.createdAt}>{displayTime(token.createdAt)}</time></td>
                    <td>{token.lastUsedAt === null ? '尚未使用' : <time dateTime={token.lastUsedAt}>{displayTime(token.lastUsedAt)}</time>}</td>
                    <td className="num">{token.useCount}</td><td>{token.status === 'active' ? '活跃' : '已吊销'}</td>
                    <td>{token.status === 'active' && <button type="button" className="btn btn-ghost" aria-label={'吊销 ' + token.label} disabled={busy} onClick={() => revoke(token.id)}>吊销</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AsyncView>
    </section>
  );
}
