import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { PostKind } from '@zhidedeng/shared';
import { api } from '../api';
import AsyncView, { Empty } from '../components/AsyncView';
import PostFields, { EMPTY_POST_FORM } from '../components/PostFields';
import type { PostFormValue } from '../components/PostFields';
import { useAsync } from '../hooks';
import { useCatalog, useMe, useToast } from '../state';

const KINDS: { value: PostKind; label: string }[] = [
  { value: 'deal', label: '爆料' },
  { value: 'review', label: '评测' },
  { value: 'guide', label: '指南' },
  { value: 'community', label: '社区' },
];
const REQUIRED = { title: '请填写标题', summary: '请填写摘要', body: '请填写正文' };

/**
 * 编辑已发布文章。
 *
 * 「旧版本继续在线」是这个页面存在的前提：提交后这里只等审核，读者那边一个
 * 字节都不变。所以底部不写「已保存」，而写「已提交，审核通过后生效」——
 * 用户最怕的是「改完自己的文章立刻消失了」。
 *
 * 被驳回时预填**被拒的那一版**，不是线上版：作者照着线上版重填等于白改一遍。
 */
export default function PostEdit() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data: catalog } = useCatalog();
  const me = useMe();
  const toast = useToast();
  const post = useAsync((signal) => api.getPost(id, signal), [id]);
  const revision = useAsync((signal) => api.getRevision(id, signal), [id]);
  const [form, setForm] = useState<PostFormValue>(EMPTY_POST_FORM);
  const [kind, setKind] = useState<PostKind>('community');
  const [errors, setErrors] = useState<Partial<typeof REQUIRED>>({});
  const [serverError, setServerError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState(false);

  // 预填优先级：待审/被拒的那一版 > 线上版。只在首次加载时灌一次，
  // 之后用户正在输入的内容不能被后台刷新覆盖。
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    // 必须等**两个**请求都回来再灌值。只等 post 的话，文章详情先返回（正常网络
    // 顺序就是这样）就会拿线上版填表并标记 loaded，随后被拒那一版到了也进不来——
    // 而 banner 还写着「下面预填的是被拒的那一版」，正好说了反话。
    // revision.error 也算「回来了」：那一版读不到时退回线上版，总比一直空着强。
    if (loaded || !post.data || (revision.data === undefined && revision.error === undefined)) return;
    const source = revision.data?.revision?.payload ?? post.data;
    setForm({
      title: source.title, summary: source.summary, body: source.body,
      stationSlug: source.stationSlug ?? '', modelSlug: source.modelSlug ?? '',
    });
    setKind((revision.data?.revision?.payload.kind ?? post.data.kind) as PostKind);
    setLoaded(true);
  }, [loaded, post.data, revision.data, revision.error]);

  const change = (field: keyof PostFormValue, value: string) => setForm((current) => ({ ...current, [field]: value }));
  const pending = revision.data?.revision?.status === 'pending' ? revision.data.revision : null;
  const rejected = revision.data?.revision?.status === 'rejected' ? revision.data.revision : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const title = form.title.trim();
    const summary = form.summary.trim();
    const body = form.body.trim();
    const missing = Object.fromEntries(
      Object.entries({ title, summary, body }).filter(([, value]) => !value)
        .map(([field]) => [field, REQUIRED[field as keyof typeof REQUIRED]]),
    );
    setErrors(missing);
    if (Object.keys(missing).length) return;
    setSubmitting(true);
    setServerError(undefined);
    try {
      await api.submitRevision(id, {
        kind, title, summary, body,
        stationSlug: form.stationSlug || null,
        modelSlug: form.modelSlug || null,
        baseVersion: post.data?.contentVersion ?? 1,
      });
      revision.reload();
      toast('修改已提交，审核通过后生效；线上仍是当前版本');
      navigate(`/posts/${id}`);
    } catch (error) {
      setServerError((error as Error).message);
      setSubmitting(false);
    }
  }

  async function withdraw() {
    setSubmitting(true);
    try {
      await api.withdrawRevision(id);
      revision.reload();
      toast('已撤回这次修改，线上内容没有变化');
    } catch (error) {
      setServerError((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (me.data === null) {
    return (
      <section className="module page form-page">
        <title>编辑文章 · 什么值得蹬</title>
        <Empty title="登录后才能编辑" action={{ to: '/login', label: '登录' }} />
      </section>
    );
  }

  return (
    <section className="module page form-page">
      <title>{`编辑 ${post.data?.title ?? '文章'} · 什么值得蹬`}</title>
      <header className="page-head">
        <h1 className="page-title">编辑文章</h1>
        <p className="page-sub">
          改动要经过审核才会生效，<strong>这期间线上仍是现在这一版</strong>，读者看不到草稿。
        </p>
      </header>
      <AsyncView state={post}>
        {(current) => {
          // 只能编辑自己的、已上线的、非演示的文章。服务端也拦，这里只是别让人白填。
          if (current.author.handle !== me.data?.handle) {
            return <Empty title="只能编辑自己的文章" action={{ to: `/posts/${id}`, label: '回到文章' }} />;
          }
          if (current.status !== 'approved') {
            return <Empty title="只有已通过审核的文章才能编辑" action={{ to: `/posts/${id}`, label: '回到文章' }} />;
          }
          return (
            <>
              {pending && (
                <p className="demo-notice" role="note">
                  已有一版修改在审核中（{new Date(pending.submittedAt).toLocaleString('zh-CN')} 提交）。
                  想重新改就先撤回那一次。
                  <button type="button" className="text-btn" onClick={withdraw} disabled={submitting}>撤回修改</button>
                </p>
              )}
              {rejected && (
                <p className="demo-notice" role="note">
                  上一次修改未通过{rejected.reviewReason ? `：${rejected.reviewReason}` : ''}。
                  下面预填的是被拒的那一版，改完可以重新提交。
                </p>
              )}
              <form onSubmit={submit} noValidate>
                <fieldset className="kind-picker">
                  <legend className="field-label">类型</legend>
                  {KINDS.map(({ value, label }) => (
                    <label key={value} className="kind-option">
                      <input type="radio" name="kind" value={value} checked={kind === value} onChange={() => setKind(value)} />
                      <span>{label}</span>
                    </label>
                  ))}
                </fieldset>
                <PostFields
                  idPrefix="edit" value={form} onChange={change} errors={errors}
                  catalog={catalog} preview={preview} onTogglePreview={() => setPreview((value) => !value)}
                />
                {serverError && <p className="form-error" role="alert">{serverError}</p>}
                <button type="submit" className="btn btn-red submit-btn" disabled={submitting || Boolean(pending)}>
                  {submitting ? '提交中…' : pending ? '有一版在审核中' : '提交修改'}
                </button>
                <p className="hint">
                  <Link to={`/posts/${id}`}>回到文章</Link>。当前版本第 {current.contentVersion ?? 1} 版
                  {current.revisedAt ? `，上次更新 ${new Date(current.revisedAt).toLocaleDateString('zh-CN')}` : ''}。
                </p>
              </form>
            </>
          );
        }}
      </AsyncView>
    </section>
  );
}
