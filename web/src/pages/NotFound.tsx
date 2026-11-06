import { Empty } from '../components/AsyncView';

export default function NotFound() {
  return (
    <section className="module page notfound">
      <title>页面不存在 · 什么值得蹬</title>
      <p className="notfound-art num" aria-hidden="true">4<img src="/favicon.svg" alt="" />4</p>
      <h1 className="page-title">页面不存在</h1>
      <Empty title="这条路蹬不通，换个方向吧" action={{ to: '/', label: '回到首页' }} />
    </section>
  );
}
