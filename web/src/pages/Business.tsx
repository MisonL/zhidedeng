export default function Business() {
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
      <p className="contact-pending">本站暂未开通公开客服邮箱。</p>
      <ul className="prose-list">
        <li>站点资料纠错：在该站点详情页点「一句话反馈」，会进入人工整理。</li>
        <li>投稿、撤稿、账号恢复：通过你提交内容时使用的渠道（飞书表单或群）联系运营者，附上文章或站点链接。</li>
        <li>内容申诉：走同一条渠道即可，说明要恢复的具体文章标题。</li>
      </ul>
    </section>
  );
}
