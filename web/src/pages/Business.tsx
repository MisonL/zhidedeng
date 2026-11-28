import { api } from '../api';
import { useAsync } from '../hooks';

export default function Business() {
  // 联系方式由运维通过 OPERATOR_CONTACT 配置；没配就如实说「暂未开通」，
  // 不编地址也不留一句「待配置」——用户按「联系管理员」的提示走过来，
  // 会在最后一步卡住。
  const site = useAsync((signal) => api.getSite(signal), []);
  const contact = site.data?.contact ?? null;
  return (
    <section className="module page prose-page">
      <title>商务合作 · 什么值得蹬</title>
      <header className="page-head">
        <h1 className="page-title">商务合作</h1>
        <p className="page-sub">我们欢迎和模型厂商、中转服务方、开发者社区交流。</p>
      </header>
      <h2 className="section-title">可以聊什么</h2>
      <ul className="prose-list">
        <li>站点入驻与资料更新：提供公开、可核实的站点信息。</li>
        <li>评测与测试协作：支持社区用真实调用验证可用率和延迟。</li>
        <li>内容共建：指南、避坑经验和模型使用心得。</li>
      </ul>
      <h2 className="section-title">合作原则</h2>
      <ul className="prose-list">
        <li>榜单和评价不接受付费改动，商业内容必须明确标注。</li>
        <li>站内价格信息只使用相对官方价的倍率。</li>
      </ul>
      <h2 className="section-title">联系我们</h2>
      {/* 不编造联系方式（spec 明确要求），但也不能只留一句「待配置」——
          用户按「联系管理员」的提示走过来，会卡在最后一步。这里写清楚现在
          实际可用的是哪条通道。 */}
      {/* 还没拿到 /api/site 时不要先显示「暂未开通」：那会闪一下错误结论。
          加载失败（site.error）则按未配置处理——少一个联系方式，不影响说明页。 */}
      {site.data === undefined && site.error === undefined ? (
        <p className="hint">正在读取联系方式…</p>
      ) : contact === null ? (
        <>
          <p className="contact-pending">本站暂未开通公开客服邮箱。</p>
          <ul className="prose-list">
            <li>站点资料纠错：在该站点详情页点「一句话反馈」，会进入人工整理（需登录）。</li>
            <li>投稿、撤稿：在「我的分享」「我的投稿」里都有自助入口；撤下的文章可以由管理员恢复。</li>
            <li>账号恢复：只能由管理员在审核台操作。如果你是通过飞书表单或群提交过内容，请在原渠道联系运营者；本站目前没有别的对外通道。</li>
          </ul>
        </>
      ) : (
        <>
          <p>对外联系方式：{/^https?:\/\//.test(contact) ? <a href={contact} rel="noreferrer">{contact}</a> : contact}</p>
          <ul className="prose-list">
            <li>站点资料纠错：也可以在该站点详情页点「一句话反馈」。</li>
            <li>撤稿、账号恢复：说明具体文章标题或用户名，管理员可在审核台操作。</li>
          </ul>
        </>
      )}
    </section>
  );
}
