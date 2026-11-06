import { API_ROUTES } from '@zhidedeng/shared';
import type { ApiRouteName } from '@zhidedeng/shared';

const GROUPS: { title: string; routes: Partial<Record<ApiRouteName, { summary: string; params?: string }>> }[] = [
  {
    title: '账号',
    routes: {
      register: { summary: '注册并登录，会话写入 HttpOnly Cookie', params: 'body: username（3~20 位字母数字下划线）, password（至少 8 位）, nickname?' },
      login: { summary: '登录，失败多次会被临时限制', params: 'body: username, password' },
      logout: { summary: '退出登录，当前会话立即失效' },
      changePassword: { summary: '改密码，成功后该账号的其他会话全部失效', params: 'body: currentPassword, newPassword（至少 8 位）' },
    },
  },
  {
    title: '当前用户（需登录，未登录返回 401 UNAUTHENTICATED）',
    routes: {
      getMe: { summary: '当前账号，含 Token、签到状态、连续天数、收藏数和分享数' },
      updateMe: { summary: '修改资料', params: 'body: nickname?, bio?' },
      checkIn: { summary: '每日签到，当天重复调用返回 409 ALREADY_CHECKED_IN' },
      getMyFavorites: { summary: '我的收藏', params: 'query: page, pageSize' },
      getMyPosts: { summary: '我的分享', params: 'query: page, pageSize' },
    },
  },
  {
    title: '厂商与模型',
    routes: {
      getVendors: { summary: '厂商列表，含模型摘要' },
      getModels: { summary: '模型列表', params: 'query: vendor, q, page, pageSize' },
      getModel: { summary: '模型详情，offers 为各站倍率，按倍率升序' },
    },
  },
  {
    title: '中转站',
    routes: {
      getStations: { summary: '中转站列表', params: 'query: vendor, sort=score|rate|uptime, q, page, pageSize' },
      getStation: { summary: '中转站详情，含倍率、指标、投票汇总、当前用户投票与收藏状态' },
    },
  },
  {
    title: '文章',
    routes: {
      getPosts: { summary: '文章列表', params: 'query: kind, vendor, station, model, sort=latest|hot, q, page, pageSize' },
      getPost: { summary: '文章详情' },
      createPost: { summary: '投稿，审核通过后公开', params: 'body: kind, title, summary, body, stationSlug?, modelSlug?' },
    },
  },
  {
    title: '互动',
    routes: {
      putVote: { summary: '投票，每人每对象一票，可改可撤，返回最新汇总', params: 'body: targetType=post|station, targetId, value=up|down|null' },
      putFavorite: { summary: '收藏或取消收藏', params: 'body: targetType, targetId, favorited' },
      getComments: { summary: '评论列表，回复在 replies 内', params: 'query: targetType, targetId, page, pageSize' },
      createComment: { summary: '发表评论或一层回复，登录后发布即公开，有频率限制', params: 'body: targetType, targetId, content（1~2000 字）, parentId?' },
    },
  },
  {
    title: '发现',
    routes: {
      getRankings: { summary: '排行榜', params: 'query: tab=model|community|expert, page, pageSize' },
      getBanners: { summary: '首页 Banner' },
      search: { summary: '跨模型、中转站、文章搜索，每组最多 10 条', params: 'query: q' },
      getHotSearches: { summary: '热门搜索词' },
    },
  },
];

const EXAMPLE = `// 列表
{ "items": [], "total": 0, "page": 1, "pageSize": 10 }

// 错误
{ "error": { "code": "ALREADY_CHECKED_IN", "message": "今天已经签到过了" } }`;

export default function Docs() {
  return (
    <section className="module page">
      <title>API 文档 · 什么值得蹬</title>
      <header className="page-head">
        <h1 className="page-title">API 文档</h1>
        <p className="page-sub">
          本站公开接口，全部 JSON，前缀 <code>/api</code>。接口返回演示数据和未经平台核实的群友提交，用 <code>source</code> 字段区分。所有倍率都是相对官方价的系数，不含绝对价格；可用率为 0~100 的百分数，没有实测数据的指标为 null，赞同比例为 0~1，时间为 ISO 字符串。
        </p>
      </header>
      <pre className="code-block"><code>{EXAMPLE}</code></pre>
      {GROUPS.map((group) => (
        <div key={group.title}>
          <h2 className="section-title">{group.title}</h2>
          <div className="table-scroll">
            <table className="data-table docs-table">
              <thead><tr><th>接口</th><th>说明</th><th>参数</th></tr></thead>
              <tbody>
                {(Object.entries(group.routes) as [ApiRouteName, { summary: string; params?: string }][]).map(([name, doc]) => (
                  <tr key={name}>
                    <td className="docs-route">
                      <span className={`method method-${API_ROUTES[name].method.toLowerCase()}`}>{API_ROUTES[name].method}</span>
                      <code>{API_ROUTES[name].path}</code>
                    </td>
                    <td>{doc.summary}</td>
                    <td><code className="docs-params">{doc.params ?? '无'}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </section>
  );
}
