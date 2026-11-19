import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { PostKind, RateBasis } from '@zhidedeng/shared';
import { api } from '../api';
import Markdown from '../components/Markdown';
import { Empty } from '../components/AsyncView';
import { loginPath } from '../format';
import { useCatalog, useHere, useMe, useToast } from '../state';

/** 补录模型不是文章，但和投稿共用一个入口，所以类型放宽一格。 */
type SubmitKind = PostKind | 'model' | 'station';

const KINDS: { value: SubmitKind; label: string }[] = [
  { value: 'deal', label: '发爆料' },
  { value: 'review', label: '写评测' },
  { value: 'guide', label: '写指南' },
  { value: 'community', label: '发社区' },
  { value: 'model', label: '补充模型' },
  // 站点供给原来只靠飞书同步和 Agent：读者发现一个新站，页面上根本没有地方提交。
  { value: 'station', label: '推荐新站' },
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
  const isStation = kind === 'station';
  const [form, setForm] = useState({ title: '', summary: '', body: '', stationSlug: '', modelSlug: '' });
  // 补录模型自己的字段；模型不属于文章，不共用 title/summary/body。
  const [modelForm, setModelForm] = useState({ slug: '', vendor: '', name: '', description: '' });
  // 推荐站点同理。报价是可选的：推荐人常常只知道站名和网址，
  // 倍率由审核时补，不该因此挡住「先让这个站被收录」。
  const [stationForm, setStationForm] = useState({ name: '', url: '', description: '', rate: '', basis: 'blended' });
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
        me.refreshMe();
        toast('已提交，审核通过后进入模型库');
        navigate('/me?tab=posts');
      } catch (error) {
        setServerError((error as Error).message);
        setSubmitting(false);
      }
      return;
    }
    // 推荐站点走独立接口：站点不是文章，没有标题/摘要/正文。
    if (isStation) {
      const name = stationForm.name.trim();
      const url = stationForm.url.trim();
      if (!name || !url) {
        setServerError('请填写站点名称和网址');
        return;
      }
      setSubmitting(true);
      setServerError(undefined);
      try {
        await api.suggestStation({
          name, url,
          ...(stationForm.description.trim() ? { description: stationForm.description.trim() } : {}),
          ...(stationForm.rate.trim() ? { offers: [{
            modelSlug: stationForm.rate.trim().split('=')[0]!,
            rate: Number(stationForm.rate.trim().split('=')[1]),
            // 不带口径的报价会和别的口径混在一起比大小，推荐时能选就别留空。
            basis: stationForm.basis as RateBasis,
          }] } : {}),
        });
        me.refreshMe();
        toast('已提交，审核通过后进入中转站库');
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
              <input
                type="radio" name="kind" value={value} checked={kind === value}
                onChange={() => {
                  // 换类型等于换一套字段，上一类的校验和报错都不再适用。
                  setErrors({});
                  setServerError(undefined);
                  setParams({ kind: value }, { replace: true });
                }}
              />
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
        {isStation && (
          <>
            <p className="hint">推荐平台还没收录的中转站。审核通过后会进入中转站库，其他人就能在对比页看到它。</p>
            <div className="field">
              <label className="field-label" htmlFor="station-name">站点名称</label>
              <input id="station-name" maxLength={60} value={stationForm.name} onChange={event => setStationForm({ ...stationForm, name: event.target.value })} />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="station-url">网址</label>
              <input id="station-url" maxLength={300} inputMode="url" placeholder="https://" value={stationForm.url} onChange={event => setStationForm({ ...stationForm, url: event.target.value })} />
              <p className="hint">同一个域名只收录一个站点，带不带端口或 www 都视为同一站。</p>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="station-description">一句话说明（可选）</label>
              <textarea id="station-description" rows={2} maxLength={300} value={stationForm.description} onChange={event => setStationForm({ ...stationForm, description: event.target.value })} />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="station-rate">报价倍率（可选）</label>
              <input id="station-rate" placeholder="例如 gpt-4-1=0.5" value={stationForm.rate} onChange={event => setStationForm({ ...stationForm, rate: event.target.value })} />
              <p className="hint">格式「模型slug=倍率」。不确定就留空，审核时再补。</p>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="station-basis">计价口径</label>
              <select
                id="station-basis"
                value={stationForm.basis}
                onChange={event => setStationForm({ ...stationForm, basis: event.target.value })}
              >
                <option value="blended">综合倍率（输入输出混算）</option>
                <option value="input">按输入计价</option>
                <option value="output">按输出计价</option>
                <option value="package">打包价</option>
              </select>
              <p className="hint">不同口径的倍率不能直接比大小，选错会让榜上的排序失真。</p>
            </div>
          </>
        )}
        {!isModel && !isStation && (<>
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
