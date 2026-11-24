import { API_ROUTES } from '@zhidedeng/shared';
import type { ApiRouteName } from '@zhidedeng/shared';

const GROUPS: { title: string; routes: Partial<Record<ApiRouteName, { summary: string; params?: string }>> }[] = [
  {
    title: '账号',
    routes: {
      register: { summary: '注册并登录，会话写入 HttpOnly Cookie', params: 'body: username（3~20 位字母数字下划线）, password（至少 10 位）, nickname?' },
      login: { summary: '登录，失败多次会被临时限制', params: 'body: username, password' },
      logout: { summary: '退出登录，当前会话立即失效' },
      changePassword: { summary: '改密码，成功后该账号的其他会话全部失效', params: 'body: currentPassword, newPassword（至少 10 位）' },
    },
  },
  {
    title: '当前用户（需登录，未登录返回 401 UNAUTHENTICATED）',
    routes: {
      getMe: { summary: '当前账号，含 Token、签到状态、连续天数、收藏数和分享数' },
      updateMe: { summary: '修改资料', params: 'body: nickname?, bio?, avatar?（预设 emoji，空串回到默认）' },
      deletePost: { summary: '作者撤下自己已发布的文章（软删除，恢复需联系管理员）', params: 'path: id' },
      checkIn: { summary: '每日签到，当天重复调用返回 409 ALREADY_CHECKED_IN' },
      getMyFavorites: { summary: '我的收藏', params: 'query: page, pageSize' },
      getMyPosts: { summary: '我的分享', params: 'query: page, pageSize' },
 getMySubmissions: { summary: '我的投稿（站点/模型/评价三类，含审核状态与理由）', params: 'query: page, pageSize' },
      createAgentToken: { summary: '签发 AI Agent 凭证，明文只返回一次；需满足注册时长、通过的投稿或邀请码之一', params: 'body: label（1~100 字）, inviteCode?' },
      getAgentTokens: { summary: '列出本人凭证的元数据数组，不含明文和哈希' },
      revokeAgentToken: { summary: '吊销本人凭证，重复调用保留首次吊销时间', params: 'path: id' },
    },
  },
  {
    title: '厂商与模型',
    routes: {
      getVendors: { summary: '厂商列表，含模型摘要' },
      getModels: { summary: '模型列表', params: 'query: vendor, q, page, pageSize' },
      getModel: { summary: '模型详情，offers 为各站倍率，先按计价口径分组、组内按倍率升序；含 basis 与 quotedAt' },
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
    title: '投稿与推荐（需登录，审核通过后才会出现在公开列表）',
    routes: {
      suggestStation: { summary: '推荐新中转站，进待审队列，可只填名称与地址；重复推荐同一站会合并', params: 'body: name（1~60 字）, url（1~300 字）, description?, offers?, rechargeThreshold?, paymentMethods?' },
      suggestModel: { summary: '补录缺失的模型，进待审队列；模型已存在返回 409 MODEL_EXISTS', params: 'body: slug, vendor, name, description' },
    },
  },
  {
    title: '互动',
    routes: {
      putVote: { summary: '投票，每人每对象一票，可改可撤，返回最新汇总', params: 'body: targetType=post|station, targetId, value=up|down|null' },
      putFavorite: { summary: '收藏或取消收藏', params: 'body: targetType, targetId, favorited' },
      getComments: { summary: '评论列表，回复在 replies 内', params: 'query: targetType, targetId, page, pageSize' },
      createComment: { summary: '发表评论或一层回复，登录后发布即公开，有频率限制', params: 'body: targetType, targetId, content（1~2000 字）, parentId?' },
      deleteComment: { summary: '作者删除自己的评论。有人回复时保留「该评论已删除」占位，回复不跟着消失', params: 'path: id' },
      createReport: { summary: '举报文章/站点/评论，进人工队列；不会自动下架，同一对象未处理时重复举报返回 409 ALREADY_REPORTED', params: 'body: targetType=post|station|comment, targetId, reason（1~200 字）, detail?' },
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
  {
    title: 'Agent 通道（请求头 authorization: Bearer <Agent 凭证>，非会话 Cookie）',
    routes: {
      getAgentStatus: { summary: '凭证身份、配额余量、名下最近投稿与已认领的域名', params: 'query: limit（1~50）' },
      createAgentStation: { summary: '提交中转站与报价，URL 归一化后作为去重键', params: 'body: name, url, offers[{ modelSlug, rate, basis?, quotedAt? }], description?, rechargeThreshold?, paymentMethods?' },
      createAgentModel: { summary: '补录模型，进待审队列', params: 'body: slug, vendor, name, description' },
      createAgentPost: { summary: '提交评测文章，可关联已有站点与模型', params: 'body: title, summary, body, modelSlug?, stationSlug?, kind?' },
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
