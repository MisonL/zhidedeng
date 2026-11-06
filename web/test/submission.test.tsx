import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Station, StationDetail } from '@zhidedeng/shared';
import PostCard from '../src/components/PostCard';
import StationCard from '../src/components/StationCard';
import { makePost, page, station } from './fixtures';
import { renderApp, renderWithProviders, stubApi } from './helpers';

const submitted: Station = {
  ...station, slug: 'sub-example-com', name: '群友站', url: 'https://example.com/', source: 'submission',
  uptime: null, firstTokenLatencyMs: null, foundedAt: null, status: null, rechargeThreshold: null, paymentMethods: [], score: null,
};
const detail: StationDetail = { ...submitted, offers: [] };

const LABEL = '群友提交，未经平台核实';

describe('群友提交的内容要标明来源', () => {
  it('站点卡片和文章卡片带标签，演示内容不带', () => {
    stubApi();
    renderWithProviders(
      <>
        <StationCard station={submitted} />
        <PostCard post={makePost('s', { source: 'submission', title: '群友文章' })} />
      </>,
    );
    expect(screen.getAllByText(LABEL)).toHaveLength(2);
  });

  it('演示卡片不带群友标签', () => {
    stubApi();
    renderWithProviders(<StationCard station={station} />);
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
  });

  it('站点详情顶部声明未核实，给出外链且不把来路带给对方', async () => {
    stubApi({ 'GET /api/stations/sub-example-com': detail, 'GET /api/posts': page([]) });
    renderApp('/stations/sub-example-com');
    expect(await within(screen.getByRole('main')).findByRole('note')).toHaveTextContent(LABEL);
    const link = await screen.findByRole('link', { name: 'https://example.com/' });
    expect(link).toHaveAttribute('href', 'https://example.com/');
    expect(link).toHaveAttribute('rel', 'nofollow noopener noreferrer');
  });

  it('演示站点详情不显示外链行，声明仍是演示数据', async () => {
    stubApi({ 'GET /api/stations/yunzhan': { ...station, offers: [] }, 'GET /api/posts': page([]) });
    renderApp('/stations/yunzhan');
    expect(await within(screen.getByRole('main')).findByRole('note')).toHaveTextContent('当前为演示数据');
    expect(screen.queryByText('站点网址')).not.toBeInTheDocument();
  });

  it('群友文章正文按纯文本显示：Markdown 链接、图片和 HTML 都不生效', async () => {
    const body = '第一行 [点我](https://evil.example/x)\n![跟踪](https://evil.example/p.png)\n<img src=x onerror=alert(1)>\n# 不是标题';
    stubApi({ 'GET /api/posts/feishu-r1': makePost('feishu-r1', { source: 'submission', body, stationSlug: null, modelSlug: null }) });
    const { container } = renderApp('/posts/feishu-r1');
    expect(await within(screen.getByRole('main')).findByRole('note')).toHaveTextContent(LABEL);
    const article = container.querySelector('.article')!;
    expect(article.querySelector('.article-plain')!.textContent).toBe(body);
    expect(article.querySelector('.markdown')).toBeNull();
    expect(article.querySelector('.article-plain a, .article-plain img, .article-plain h1')).toBeNull();
  });

  it('其他文章照常渲染 Markdown', async () => {
    stubApi({ 'GET /api/posts/p1': makePost('p1', { body: '# 标题' }) });
    renderApp('/posts/p1');
    expect(await screen.findByRole('heading', { name: '标题' })).toBeInTheDocument();
  });

  it('页脚同时说清演示数据和群友提交', async () => {
    stubApi();
    renderApp('/');
    const footer = within(screen.getByRole('contentinfo'));
    expect(footer.getByText(/虚构.*演示数据.*群友提交.*未经平台核实.*不构成消费建议/)).toBeInTheDocument();
    await screen.findAllByText('云栈');
  });
});

describe('没有测量数据时显示暂无', () => {
  it('站点卡片不出现 null 也不编造数字', () => {
    stubApi();
    const { container } = renderWithProviders(<StationCard station={submitted} />);
    expect(screen.getByText('可用率 暂无')).toBeInTheDocument();
    expect(screen.getByText('首 token 暂无')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/null|NaN|undefined/);
  });

  it('评测封面的仪表显示暂无，不画进度', async () => {
    stubApi({ 'GET /api/stations': page([submitted]) });
    const post = makePost('r', { kind: 'review', stationSlug: submitted.slug, modelSlug: null });
    const { container } = renderWithProviders(<PostCard post={post} />);
    await waitFor(() => expect(container.querySelector('.cover-review .cover-value')).toHaveAttribute('data-value', '暂无'));
    expect(container.querySelector('.cover-review .cover-value')).not.toHaveAttribute('data-unit');
    expect(container.querySelector('.cover-review .cover-meter')).toHaveAttribute('data-value', '首 token 暂无');
    expect((container.querySelector('.cover-gauge') as HTMLElement).style.getPropertyValue('--p')).toBe('0');
    expect(screen.getByText('可用率 暂无')).toBeInTheDocument();
  });

  it('站点详情的全部指标显示暂无', async () => {
    stubApi({ 'GET /api/stations/sub-example-com': detail, 'GET /api/posts': page([]), 'GET /api/comments': page([]) });
    renderApp('/stations/sub-example-com');
    const dl = (await screen.findByText('综合得分')).closest('dl')!;
    for (const label of ['可用率', '首 token 延迟', '充值门槛', '支付方式', '成立时间', '运行状态', '综合得分']) {
      expect(within(dl).getByText(label).nextElementSibling).toHaveTextContent('暂无');
    }
  });

  it('模型比价表把可用率、延迟和状态都显示为暂无', async () => {
    const model = { slug: 'gpt-5', vendor: 'openai', name: 'GPT-5', description: '通用旗舰', tags: [] };
    stubApi({ 'GET /api/models/gpt-5': { ...model, offers: [{ stationSlug: submitted.slug, modelSlug: 'gpt-5', rate: 0.5, station: submitted }] } });
    renderApp('/models/gpt-5');
    const row = (await screen.findByRole('link', { name: '群友站' })).closest('tr')!;
    expect(within(row).getAllByText('暂无')).toHaveLength(3);
  });
});
