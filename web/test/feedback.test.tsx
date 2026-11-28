import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { callsTo, renderApp, stubApi, apiError } from './helpers';
import { makePost, page, station } from './fixtures';

/**
 * 站点详情页要的数据：少了 GET /api/stations/:slug 整页都不渲染。
 * source 必须是真实来源——fixtures 里的 station 是 demo，而演示站按设计不给表单。
 */
const detail = { ...station, offers: [], source: 'user' as const };
/** 演示站版本，专门给「不给表单」那条用例。 */
const demoDetail = { ...station, offers: [], source: 'demo' as const };

const item = (id: string, patch = {}) => ({
  id, stationSlug: station.slug, verdict: 'slow' as const, content: `反馈 ${id}`,
  createdAt: '2026-11-24T00:00:00.000Z', mine: false,
  author: { handle: 'bob', nickname: '鲍勃', avatar: '' }, ...patch,
});

describe('站点一句话反馈', () => {
  it('必须标明是用户自述，不能说成实测', async () => {
    stubApi({ 'GET /api/stations/yunzhan': detail, 'GET /api/feedback': page([item('f1')]) });
    // 站点详情页需要 GET /api/stations/:slug，否则整页不渲染。
    renderApp(`/stations/${station.slug}`);
    expect(await screen.findByText('反馈 f1', {}, { timeout: 5000 })).toBeInTheDocument();
    // 这条是数据诚信的硬约束：读者不能把「挂了」当成平台实测结论。
    expect(screen.getByText(/用户自述，未经平台核实/)).toBeInTheDocument();
  });

  it('提交时带上三个选项之一与这句话', async () => {
    const fetchMock = stubApi({
      'GET /api/stations/yunzhan': detail,
      'GET /api/feedback': page([]),
      'POST /api/feedback': { ...item('f2'), mine: true, verdict: 'broken', content: '第二天 502' },
    });
    // 站点详情页需要 GET /api/stations/:slug，否则整页不渲染。
    renderApp(`/stations/${station.slug}`);
    fireEvent.click(await screen.findByRole('button', { name: '挂了' }));
    fireEvent.change(screen.getByLabelText('一句话反馈'), { target: { value: '第二天 502' } });
    fireEvent.click(screen.getByRole('button', { name: '记一句' }));

    expect(await screen.findByText('已记下，谢谢你')).toBeInTheDocument();
    expect(callsTo(fetchMock, 'POST', '/api/feedback').at(-1)!.body).toEqual({
      stationSlug: station.slug, verdict: 'broken', content: '第二天 502',
    });
  });

  it('今天已经留过时说明白，而不是报红', async () => {
    stubApi({
      'GET /api/stations/yunzhan': detail,
      'GET /api/feedback': page([]),
      'POST /api/feedback': apiError(409, 'ALREADY_FEEDBACK', '今天已经给这个站留过一句话了'),
    });
    // 站点详情页需要 GET /api/stations/:slug，否则整页不渲染。
    renderApp(`/stations/${station.slug}`);
    fireEvent.change(await screen.findByLabelText('一句话反馈'), { target: { value: '再来一条' } });
    fireEvent.click(screen.getByRole('button', { name: '记一句' }));
    expect(await screen.findByText('今天已经给这个站留过一句话了')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('演示站不给表单：服务端一定拒绝，别让人填一个永远提交不上的框', async () => {
    const fetchMock = stubApi({
      'GET /api/stations/yunzhan': demoDetail,
      'GET /api/feedback': page([]),
    });
    renderApp(`/stations/${station.slug}`);
    expect(await screen.findByText('这是虚构演示站点，不需要反馈。')).toBeInTheDocument();
    expect(screen.queryByLabelText('一句话反馈')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '记一句' })).not.toBeInTheDocument();
    expect(callsTo(fetchMock, 'POST', '/api/feedback')).toHaveLength(0);
  });

  it('自己的反馈才有删除入口，删完重新取列表', async () => {
    let deleted = false;
    // 站点详情页需要 GET /api/stations/:slug，否则整页不渲染。
    const fetchMock = stubApi({
      'GET /api/stations/yunzhan': detail,
      'GET /api/feedback': () => page(deleted ? [item('f1')] : [item('f1'), item('f2', { mine: true })]),
      'DELETE /api/feedback/f2': () => { deleted = true; return { id: 'f2', deleted: true }; },
    });
    renderApp(`/stations/${station.slug}`);
    expect(await screen.findByText('反馈 f2')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '删除' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(screen.queryByText('反馈 f2')).not.toBeInTheDocument());
    expect(callsTo(fetchMock, 'DELETE', '/api/feedback/f2')).toHaveLength(1);
  });
});

void makePost;
