import { describe, expect, it } from 'vitest';
import { openDatabase, openStore } from '../../server/src/node-app.ts';
import { seed } from '../../server/src/seed.ts';
import { applyPurge, planPurge } from '../purge-demo.ts';

const at = new Date('2026-11-20T00:00:00.000Z');
const demoStore = () => {
  const store = openStore(openDatabase(':memory:'));
  seed(store, at, 'demo');
  return store;
};

describe('清除演示数据', () => {
  it('默认能找到全部演示内容与它们的关联数据', () => {
    const plan = planPurge(demoStore());
    expect(plan.stations.length).toBe(12);
    expect(plan.posts.length).toBe(48);
    expect(plan.users.length).toBeGreaterThan(0);
    expect(plan.banners.length).toBe(3);
    // 演示站 12 个，每个 6~15 条报价，不能是 0。
    expect(plan.offers).toBeGreaterThan(0);
    expect(plan.votes).toBeGreaterThan(0);
    expect(plan.commentCount).toBeGreaterThan(0);
    expect(plan.comments.length).toBe(plan.commentCount);
  });

  it('只删演示数据，真实投稿与真实账号一条不动', () => {
    const store = demoStore();
    // 造一条真实站、一篇真实文章、一个真实用户，模拟生产库里混着两种情况。
    store.put('station', 'real-example-com', {
      slug: 'real-example-com', name: '真实站', description: '', url: 'https://real.example.com',
      source: 'submission', rechargeThreshold: null, paymentMethods: [],
      uptime: null, firstTokenLatencyMs: null, foundedAt: null, status: null,
    } as never);
    store.put('post', 'real-post', {
      id: 'real-post', kind: 'review', title: '真实文章', summary: '', body: '', authorHandle: 'realuser',
      stationSlug: null, modelSlug: null, cover: null, publishedAt: at.toISOString(), source: 'user', status: 'approved',
    } as never);
    store.put('user', 'realuser', { handle: 'realuser', nickname: '真人', avatar: '', bio: '', tokens: 120 } as never);
    store.db.prepare("INSERT INTO offers (stationSlug, modelSlug, rate, basis, quotedAt) VALUES ('real-example-com','deepseek-chat',0.5,'blended',NULL)").run();

    const plan = planPurge(store);
    applyPurge(store, plan);

    expect(store.get('station', 'real-example-com')?.name).toBe('真实站');
    expect(store.get('post', 'real-post')?.title).toBe('真实文章');
    expect(store.get('user', 'realuser')?.nickname).toBe('真人');
    const offers = store.db.prepare("SELECT COUNT(*) c FROM offers WHERE stationSlug = 'real-example-com'").get() as { c: number };
    expect(Number(offers.c)).toBe(1);
    // 演示数据全没了。
    expect(store.allWithRemoved('station').some(s => s.source === 'demo')).toBe(false);
    expect(store.allWithRemoved('post').some(p => p.source === 'demo')).toBe(false);
    expect(store.all('user').some(u => u.handle.startsWith('demo-'))).toBe(false);
    expect(store.all('banner')).toEqual([]);
  });

  it('清完不留孤儿行：指向已删内容的投票/收藏/评论一并消失', () => {
    const store = demoStore();
    const before = store.db.prepare('SELECT COUNT(*) c FROM votes').get() as { c: number };
    expect(Number(before.c)).toBeGreaterThan(0);
    applyPurge(store, planPurge(store));
    for (const table of ['votes', 'favorites', 'comments']) {
      const row = store.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number };
      expect(Number(row.c)).toBe(0);
    }
    const offers = store.db.prepare('SELECT COUNT(*) c FROM offers').get() as { c: number };
    expect(Number(offers.c)).toBe(0);
  });

  it('生产模式的空库没什么可清，重跑也是幂等的', () => {
    const store = openStore(openDatabase(':memory:'));
    seed(store, at, 'production');
    const plan = planPurge(store);
    expect(plan.stations).toEqual([]);
    expect(plan.posts).toEqual([]);
    expect(plan.users).toEqual([]);
    applyPurge(store, plan);
    applyPurge(store, planPurge(store));
    // 目录不该被清理波及。
    expect(store.all('vendor').length).toBeGreaterThan(0);
    expect(store.all('model').length).toBeGreaterThan(0);
  });
});

describe('清理演示数据时不留死举报', () => {
  it('指向演示内容的举报、以及演示用户发出的举报，一并删掉', () => {
    const store = demoStore();
    const post = store.allWithRemoved('post').find(item => item.source === 'demo')!;
    const station = store.allWithRemoved('station').find(item => item.source === 'demo')!;
    const demoUser = store.all('user').find(user => user.handle.startsWith('demo-'))!;
    const comment = store.db.prepare("SELECT id FROM comments WHERE targetType = 'post' AND targetId = ? LIMIT 1")
      .get(post.id) as { id: string } | undefined;

    // 真实用户举报演示内容（正常情况下服务端会拒，但历史数据可能有）。
    store.db.prepare("INSERT INTO reports (id,targetType,targetId,reporterHandle,reason,status,createdAt) VALUES ('r1','post',?,'realuser','内容不实','open',?)")
      .run(post.id, at.toISOString());
    store.db.prepare("INSERT INTO reports (id,targetType,targetId,reporterHandle,reason,status,createdAt) VALUES ('r2','station',?,'realuser','广告','open',?)")
      .run(station.slug, at.toISOString());
    if (comment) {
      store.db.prepare("INSERT INTO reports (id,targetType,targetId,reporterHandle,reason,status,createdAt) VALUES ('r3','comment',?,'realuser','辱骂','open',?)")
        .run(comment.id, at.toISOString());
    }
    // 需要一篇**真实存在**的文章当举报目标：指向不存在对象的举报现在会被
    // 当成孤儿举报清掉（另一条用例覆盖），那样这条用例就测不出「保留真实举报」了。
    store.put('post', 'real-post', {
      id: 'real-post', kind: 'review', title: '真实文章', summary: '', body: '', authorHandle: 'realuser',
      stationSlug: null, modelSlug: null, cover: null, publishedAt: at.toISOString(), source: 'user', status: 'approved',
    } as never);
    // 演示用户发出的举报（举报目标可以是真实内容，但举报人本身要被清掉）。
    store.db.prepare("INSERT INTO reports (id,targetType,targetId,reporterHandle,reason,status,createdAt) VALUES ('r4','post','real-post','" + demoUser.handle + "','x','open',?)")
      .run(at.toISOString());
    // 真实用户举报真实内容：**不能动**。
    store.db.prepare("INSERT INTO reports (id,targetType,targetId,reporterHandle,reason,status,createdAt) VALUES ('r5','post','real-post','realuser','x','open',?)")
      .run(at.toISOString());

    const plan = planPurge(store);
    expect(plan.reports).toBe(comment ? 4 : 3);
    applyPurge(store, plan);

    const left = store.db.prepare('SELECT id FROM reports ORDER BY id').all() as Array<{ id: string }>;
    expect(left.map(row => row.id)).toEqual(['r5']);
  });
});

describe('清理举报的时点问题', () => {
  it('plan 之后才插进来的匹配举报，也会被清掉（不能用快照计数当开关）', () => {
    const store = demoStore();
    const post = store.allWithRemoved('post').find(item => item.source === 'demo')!;
    const plan = planPurge(store);
    expect(plan.reports).toBe(0);

    // 规划之后、执行之前，又有人举报了一条演示文章。
    store.db.prepare("INSERT INTO reports (id,targetType,targetId,reporterHandle,reason,status,createdAt) VALUES ('late','post',?,'realuser','事后补的','open',?)")
      .run(post.id, at.toISOString());
    applyPurge(store, plan);

    const left = store.db.prepare('SELECT id FROM reports').all() as Array<{ id: string }>;
    expect(left).toEqual([]);
  });

  it('plan 之后才插入、但目标在计划内的举报，同样会被清掉', () => {
    // 与上一条的区别：目标就是演示内容，只是举报行是事后才出现的。
    const store = demoStore();
    const post = store.allWithRemoved('post').find(item => item.source === 'demo')!;
    const plan = planPurge(store);
    store.db.prepare("INSERT INTO reports (id,targetType,targetId,reporterHandle,reason,status,createdAt) VALUES ('late2','post',?,'realuser','事后补的','open',?)")
      .run(post.id, at.toISOString());
    applyPurge(store, plan);
    expect(store.db.prepare('SELECT COUNT(*) c FROM reports').get()).toMatchObject({ c: 0 });
  });
});

describe('清理顺序：举报要在评论之前', () => {
  it('plan 之后新挂到演示文章下的评论，连同它被举报的那条，一起清掉', () => {
    const store = demoStore();
    const post = store.allWithRemoved('post').find(item => item.source === 'demo')!;
    const plan = planPurge(store);
    expect(plan.comments.every(id => typeof id === 'string')).toBe(true);

    // 规划之后才出现的评论：它在 plan.comments 里没有，但 applyPurge 会按
    // 「targetId 是演示文章」把它删掉。它的举报必须一起走，否则留下死举报。
    store.db.prepare("INSERT INTO comments (id,targetType,targetId,userHandle,content,createdAt) VALUES ('late-c','post',?,'realuser','事后评论','2026-11-24T00:00:00.000Z')")
      .run(post.id);
    store.db.prepare("INSERT INTO reports (id,targetType,targetId,reporterHandle,reason,status,createdAt) VALUES ('late-r','comment','late-c','realuser','举报事后评论','open','2026-11-24T00:00:00.000Z')")
      .run();

    applyPurge(store, plan);

    const comments = store.db.prepare('SELECT id FROM comments').all() as Array<{ id: string }>;
    expect(comments.map(c => c.id)).not.toContain('late-c');
    expect(store.db.prepare('SELECT COUNT(*) c FROM reports').get()).toMatchObject({ c: 0 });
  });
});

describe('孤儿举报（目标已不在库里）', () => {
  it('目标不存在的举报会被识别并清掉，真实对象上的举报不受影响', () => {
    const store = demoStore();
    // 三条孤儿：指向不存在的文章、站点、评论；一条正常：指向真实存在的演示文章。
    const live = store.allWithRemoved('post').find(item => item.source === 'demo')!;
    const insert = store.db.prepare(
      "INSERT INTO reports (id,targetType,targetId,reporterHandle,reason,status,createdAt) VALUES (?,?,?,?,?,'open',?)",
    );
    insert.run('o-post', 'post', '已经没了的文章', 'realuser', 'x', at.toISOString());
    insert.run('o-station', 'station', '已经没了的站', 'realuser', 'x', at.toISOString());
    insert.run('o-comment', 'comment', '已经没了的评论', 'realuser', 'x', at.toISOString());
    insert.run('live', 'post', live.id, 'realuser', '正常举报', at.toISOString());

    const plan = planPurge(store);
    expect(plan.orphanReports.map(item => item.id).sort()).toEqual(['o-comment', 'o-post', 'o-station']);

    applyPurge(store, plan);
    const left = store.db.prepare('SELECT id FROM reports').all() as Array<{ id: string }>;
    // 正常那条指向的演示文章被删了，所以它也成了孤儿、被一起清掉——这是预期：
    // 对象没了举报就没有意义。剩下的只可能是「真实对象上的真实举报」。
    expect(left).toEqual([]);
  });

  it('实体为空、只剩孤儿举报时，也能清干净（不再被「没有演示数据」提前返回挡住）', () => {
    const store = demoStore();
    // 先清一遍演示数据，再人为留一条孤儿举报。
    applyPurge(store, planPurge(store));
    store.db.prepare(
      "INSERT INTO reports (id,targetType,targetId,reporterHandle,reason,status,createdAt) VALUES ('late-orphan','post','早就不存在了','realuser','x','open',?)",
    ).run(at.toISOString());
    expect(store.db.prepare('SELECT COUNT(*) c FROM reports').get()).toMatchObject({ c: 1 });

    const plan = planPurge(store);
    expect(plan.stations).toEqual([]);
    expect(plan.orphanReports).toHaveLength(1);
    applyPurge(store, plan);
    expect(store.db.prepare('SELECT COUNT(*) c FROM reports').get()).toMatchObject({ c: 0 });
  });
});

describe('评论限流流水', () => {
  it('演示账号的写入流水会被清掉，真实账号的不动', () => {
    const store = demoStore();
    const demoUser = store.all('user').find(user => user.handle.startsWith('demo-'))!;
    const insert = store.db.prepare('INSERT INTO comment_writes (userHandle, createdAt) VALUES (?, ?)');
    insert.run(demoUser.handle, at.toISOString());
    insert.run('realuser', at.toISOString());

    applyPurge(store, planPurge(store));

    const left = store.db.prepare('SELECT userHandle FROM comment_writes').all() as Array<{ userHandle: string }>;
    expect(left.map(row => row.userHandle)).toEqual(['realuser']);
  });
});

describe('一句话反馈', () => {
  it('演示站下的反馈与演示账号发的反馈一并清掉，真实站上的真实反馈不动', () => {
    const store = demoStore();
    const demoStation = store.allWithRemoved('station').find(item => item.source === 'demo')!;
    const demoUser = store.all('user').find(user => user.handle.startsWith('demo-'))!;
    // 真实站。
    store.put('station', 'real-station', {
      slug: 'real-station', name: '真实站', description: 'd', url: null, rechargeThreshold: null,
      paymentMethods: [], uptime: null, firstTokenLatencyMs: null, foundedAt: null, status: null, source: 'user',
    } as never);
    const insert = store.db.prepare('INSERT INTO feedback (id,stationSlug,userHandle,verdict,content,createdAt,deletedAt) VALUES (?,?,?,?,?,?,NULL)');
    insert.run('fd-demo-station', demoStation.slug, 'realuser', 'broken', '挂了', at.toISOString());
    insert.run('fd-demo-user', 'real-station', demoUser.handle, 'works', '能用', at.toISOString());
    insert.run('fd-real', 'real-station', 'realuser', 'slow', '有点慢', at.toISOString());

    const plan = planPurge(store);
    expect(plan.feedback).toBe(2);
    applyPurge(store, plan);

    const left = store.db.prepare('SELECT id FROM feedback ORDER BY id').all() as Array<{ id: string }>;
    expect(left.map(row => row.id)).toEqual(['fd-real']);
  });

  it('演示站自己先被别处删了也不报错（反馈照常按 stationSlug 清）', () => {
    const store = demoStore();
    const plan = planPurge(store);
    applyPurge(store, plan);
    // 再跑一遍，幂等。
    const again = planPurge(store);
    expect(again.feedback).toBe(0);
    expect(() => applyPurge(store, again)).not.toThrow();
  });
});
