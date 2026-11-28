import Markdown from './Markdown';
import type { VendorWithModels, Station } from '@zhidedeng/shared';

/**
 * 投稿与编辑共用的文章字段。
 *
 * 抽出来的理由很具体：编辑页要是另抄一份，字段一改就只改一处——比如新增一个
 * 「关联模型」，投稿页有、编辑页没有，作者改一次就把那个字段清空了。
 */
export interface PostFormValue {
  title: string;
  summary: string;
  body: string;
  stationSlug: string;
  modelSlug: string;
}

export const EMPTY_POST_FORM: PostFormValue = { title: '', summary: '', body: '', stationSlug: '', modelSlug: '' };

export default function PostFields({ idPrefix, value, onChange, errors, catalog, preview, onTogglePreview }: {
  idPrefix: string;
  value: PostFormValue;
  onChange: (field: keyof PostFormValue, value: string) => void;
  errors: Partial<Record<'title' | 'summary' | 'body', string>>;
  catalog: { stations: Station[]; vendors: VendorWithModels[] } | undefined;
  preview: boolean;
  onTogglePreview: () => void;
}) {
  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor={`${idPrefix}-title`}>标题</label>
        <input id={`${idPrefix}-title`} maxLength={100} value={value.title} onChange={(event) => onChange('title', event.target.value)} aria-invalid={Boolean(errors.title)} />
        {errors.title && <p className="form-error">{errors.title}</p>}
      </div>
      <div className="field">
        <label className="field-label" htmlFor={`${idPrefix}-summary`}>摘要</label>
        <textarea id={`${idPrefix}-summary`} rows={2} maxLength={200} value={value.summary} onChange={(event) => onChange('summary', event.target.value)} aria-invalid={Boolean(errors.summary)} />
        {errors.summary && <p className="form-error">{errors.summary}</p>}
      </div>
      <div className="field-row">
        <div className="field">
          <label className="field-label" htmlFor={`${idPrefix}-station`}>关联中转站（可选）</label>
          <select id={`${idPrefix}-station`} value={value.stationSlug} onChange={(event) => onChange('stationSlug', event.target.value)}>
            <option value="">不关联</option>
            {catalog?.stations.map((station) => <option key={station.slug} value={station.slug}>{station.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor={`${idPrefix}-model`}>关联模型（可选）</label>
          <select id={`${idPrefix}-model`} value={value.modelSlug} onChange={(event) => onChange('modelSlug', event.target.value)}>
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
          <label className="field-label" htmlFor={`${idPrefix}-body`}>正文（支持 Markdown）</label>
          <button type="button" className="text-btn" onClick={onTogglePreview}>{preview ? '继续编辑' : '预览'}</button>
        </div>
        {preview
          ? <div className="preview-box"><Markdown>{value.body || '还没有内容'}</Markdown></div>
          : <textarea id={`${idPrefix}-body`} rows={12} value={value.body} onChange={(event) => onChange('body', event.target.value)} aria-invalid={Boolean(errors.body)} />}
        {errors.body && <p className="form-error">{errors.body}</p>}
      </div>
    </>
  );
}
