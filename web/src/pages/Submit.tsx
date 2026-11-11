import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { PostKind } from '@zhidedeng/shared';
import { api } from '../api';
import Markdown from '../components/Markdown';
import { Empty } from '../components/AsyncView';
import { loginPath } from '../format';
import { useCatalog, useHere, useMe, useToast } from '../state';

/** 补录模型不是文章，但和投稿共用一个入口，所以类型放宽一格。 */
type SubmitKind = PostKind | 'model';

const KINDS: { value: SubmitKind; label: string }[] = [
  { value: 'deal', label: '发爆料' },
  { value: 'review', label: '写评测' },
  { value: 'guide', label: '写指南' },
  { value: 'community', label: '发社区' },
  { value: 'model', label: '补充模型' },
];

const REQUIRED = { title: '请填写标题', summary: '请填写摘要', body: '请填写正文' };

export default function Submit() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { data: catalog } = useCatalog();
  const me = useMe();
  const here = useHere();
  const toast = useToast();
  const requested = params.get('kind');
  const kind: SubmitKind = KINDS.find(({ value }) => value === requested)?.value ?? 'deal';
  const isModel = kind === 'model';
  const [form, setForm] = useState({ title: '', summary: '', body: '', stationSlug: '', modelSlug: '' });
  // 补录模型自己的字段；模型不属于文章，不共用 title/summary/body。
  const [modelForm, setModelForm] = useState({ slug: '', vendor: '', name: '', description: '' });
  const [errors, setErrors] = useState<Partial<typeof REQUIRED>>({});
  const [serverError, setServerError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState(false);

  const change = (field: keyof typeof form, value: string) => setForm((current) => ({ ...current, [field]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    // 补录模型走另一个接口：模型不是文章，没有标题/摘要/正文。
    if (isModel) {
      const fields = {
        slug: modelForm.slug.trim().toLowerCase(),
        vendor: modelForm.vendor.trim(),
        name: modelForm.name.trim(),
        description: modelForm.description.trim(),
      };
      if (!fields.slug || !fields.vendor || !fields.name || !fields.description) {
        setServerError('模型需要填写 slug、厂商、名称和说明');
        return;
      }
      setSubmitting(true);
      setServerError(undefined);
      try {
        await api.suggestModel(fields);
        toast('已提交，审核通过后进入模型库');
        navigate('/me?tab=posts');
      } catch (error) {
        setServerError((error as Error).message);
        setSubmitting(false);
      }
      return;
    }
    const title = form.title.trim();
    const summary = form.summary.trim();
    const body = form.body.trim();
    const missing = Object.fromEntries(
      Object.entries({ title, summary, body }).filter(([, value]) => !value).map(([field]) => [field, REQUIRED[field as keyof typeof REQUIRED]]),
    );
    setErrors(missing);
    if (Object.keys(missing).length) return;

    setSubmitting(true);
    setServerError(undefined);
    try {
      await api.createPost({
        kind: kind as PostKind, title, summary, body,
        stationSlug: form.stationSlug || undefined,
        modelSlug: form.modelSlug || undefined,
      });
      me.refreshMe();
      toast('已提交，审核通过后公开');
      navigate('/me?tab=posts');
    } catch (error) {
      setServerError((error as Error).message);
      setSubmitting(false);
    }
  }

  if (me.data === null) {
    return (
      <section className="module page form-page">
        <title>投稿分享 · 什么值得蹬</title>
        <Empty title="登录后才能投稿" action={{ to: loginPath(here), label: '登录' }} />
      </section>
    );
  }

  return (
    <section className="module page form-page">
      <title>投稿分享 · 什么值得蹬</title>
      <header className="page-head">
        <h1 className="page-title">投稿分享</h1>
        <p className="page-sub">分享真实体验。价格请只写相对官方价的倍率，不写绝对价格。投稿审核通过后才会公开。</p>
      </header>
      <form onSubmit={submit} noValidate>
        <fieldset className="kind-picker">
          <legend className="field-label">类型</legend>
          {KINDS.map(({ value, label }) => (
            <label key={value} className="kind-option">
              <input type="radio" name="kind" value={value} checked={kind === value} onChange={() => setParams({ kind: value }, { replace: true })} />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        {isModel && (
          <>
            <p className="hint">补录平台还没收录的模型。厂商必须已存在，slug 已存在时会被拒绝。审核通过后进入模型库。</p>
            <div className="field">
              <label className="field-label" htmlFor="model-slug">模型 slug</label>
              <input id="model-slug" maxLength={64} value={modelForm.slug} onChange={event => setModelForm({ ...modelForm, slug: event.target.value })} />
              <p className="hint">小写字母、数字和连字符，例如 claude-sonnet-4-5</p>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="model-vendor">厂商</label>
              <select id="model-vendor" value={modelForm.vendor} onChange={event => setModelForm({ ...modelForm, vendor: event.target.value })}>
                <option value="">选择厂商</option>
                {catalog?.vendors.map(vendor => <option key={vendor.slug} value={vendor.slug}>{vendor.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="model-name">模型名称</label>
              <input id="model-name" maxLength={60} value={modelForm.name} onChange={event => setModelForm({ ...modelForm, name: event.target.value })} />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="model-description">一句话说明</label>
              <textarea id="model-description" rows={2} maxLength={200} value={modelForm.description} onChange={event => setModelForm({ ...modelForm, description: event.target.value })} />
            </div>
          </>
        )}
        {!isModel && (<>
        <div className="field">
          <label className="field-label" htmlFor="submit-title">标题</label>
          <input id="submit-title" maxLength={100} value={form.title} onChange={(event) => change('title', event.target.value)} aria-invalid={Boolean(errors.title)} />
          {errors.title && <p className="form-error">{errors.title}</p>}
        </div>
        <div className="field">
          <label className="field-label" htmlFor="submit-summary">摘要</label>
          <textarea id="submit-summary" rows={2} maxLength={200} value={form.summary} onChange={(event) => change('summary', event.target.value)} aria-invalid={Boolean(errors.summary)} />
          {errors.summary && <p className="form-error">{errors.summary}</p>}
        </div>
        <div className="field-row">
          <div className="field">
            <label className="field-label" htmlFor="submit-station">关联中转站（可选）</label>
            <select id="submit-station" value={form.stationSlug} onChange={(event) => change('stationSlug', event.target.value)}>
              <option value="">不关联</option>
              {catalog?.stations.map((station) => <option key={station.slug} value={station.slug}>{station.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="submit-model">关联模型（可选）</label>
            <select id="submit-model" value={form.modelSlug} onChange={(event) => change('modelSlug', event.target.value)}>
              <option value="">不关联</option>
              {catalog?.vendors.map((vendor) => (
                <optgroup key={vendor.slug} label={vendor.name}>
                  {vendor.models.map((model) => <option key={model.slug} value={model.slug}>{model.name}</option>)}
                </optgroup>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <div className="field-head">
            <label className="field-label" htmlFor="submit-body">正文（支持 Markdown）</label>
            <button type="button" className="text-btn" onClick={() => setPreview((value) => !value)}>{preview ? '继续编辑' : '预览'}</button>
          </div>
          {preview
            ? <div className="preview-box"><Markdown>{form.body || '还没有内容'}</Markdown></div>
            : <textarea id="submit-body" rows={12} value={form.body} onChange={(event) => change('body', event.target.value)} aria-invalid={Boolean(errors.body)} />}
          {errors.body && <p className="form-error">{errors.body}</p>}
        </div>
        </>)}
        {serverError && <p className="form-error" role="alert">{serverError}</p>}
        <button type="submit" className="btn btn-red submit-btn" disabled={submitting}>{submitting ? '提交中…' : '提交审核'}</button>
      </form>
    </section>
  );
}
