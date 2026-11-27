import { existsSync } from 'node:fs';
import { openDatabase, openStore } from '../server/src/node-app.ts';

/**
 * 清除演示数据。
 *
 * 只在**曾经用演示模式跑过**的库里需要：`SITE_MODE` 是空库时的一次性决定，
 * 把模式改成 production 不会删掉已经灌进去的虚构站点和文章，只会停止继续灌。
 * 所以切模式后要另外跑一次这个脚本。
 *
 * 识别规则只看来源标记，不猜名字：
 * - 站点/文章：`source === 'demo'`
 * - 用户：种子用户的 handle 都在 `demo-` 前缀下（真实用户的 handle 由注册流程生成，不受影响）
 * - 横幅：种子里只有三条，且真实运营也不会建 banner，整类清掉
 *
 * 关联数据一起清：demo 站的报价、指向 demo 内容的投票/收藏/评论/举报，
 * 以及 demo 用户自己发出的投票/收藏/评论/举报。留着会变成指向不存在条目的孤儿行。
 *
 * **已知不覆盖**：如果演示实体早先被别的途径删掉、只剩指向它们的举报行，
 * 这个脚本认不出这些孤儿（它们的目标 id 已不在库里，无从判断属于哪一批）。
 * 那种情况要人工按 `targets 已不在线` 在审核台逐条处置。
 *
 * 默认 dry-run 只打印，加 --apply 才写库——删数据没有回滚。
 */

export interface PurgePlan {
  stations: string[];
  posts: string[];
  users: string[];
  banners: string[];
  /** 会被一并删除的评论 id：举报行里按评论 id 引用它们，得先记下来。 */
  comments: string[];
  offers: number;
  votes: number;
  favorites: number;
  commentCount: number;
  reports: number;
  /** 会一并删除的一句话反馈条数。 */
  feedback: number;
  /**
   * 目标已经不在库里的举报（对象被别的途径删掉了）。
   *
   * 这类行认不出「属于哪一批演示数据」，但它们的共同特征是**目标不存在**——
   * 审核台会一直显示「已不在线」，永远处理不完也永远没有意义。所以按「目标
   * 不存在」单独识别并清掉，而不是靠 demo 名单去碰。
   */
  orphanReports: Array<{ id: string; targetType: string; targetId: string }>;
}

const inList = (values: readonly string[]) => values.map(() => '?').join(', ');

export function planPurge(store: ReturnType<typeof openStore>): PurgePlan {
  // station 的身份是 slug，post 的身份是 id：分开取，别用一个联合类型硬凑。
  const stations = store.allWithRemoved('station').filter(item => item.source === 'demo').map(item => item.slug);
  const posts = store.allWithRemoved('post').filter(item => item.source === 'demo').map(item => item.id);

  // 演示用户没有 source 字段（User 类型里没有这个概念），只能按 handle 认。
  // 注册流程生成的是真实 handle，不会撞上 demo- 前缀。
  const users = store.allWithRemoved('user').filter(user => user.handle.startsWith('demo-')).map(user => user.handle);
  const banners = store.all('banner').map(banner => banner.id);

  const count = (sql: string, params: readonly string[]) => {
    if (params.length === 0) return 0;
    return Number((store.db.prepare(sql).get(...params) as { c: number }).c);
  };

  const targetClause = (stationIds: readonly string[], postIds: readonly string[]) => {
    const parts: string[] = [];
    if (stationIds.length > 0) parts.push(`(targetType = 'station' AND targetId IN (${inList(stationIds)}))`);
    if (postIds.length > 0) parts.push(`(targetType = 'post' AND targetId IN (${inList(postIds)}))`);
    return parts;
  };

  const orphanTargets = targetClause(stations, posts);
  const targetParams = [...stations, ...posts];
  const userClause = users.length > 0 ? `userHandle IN (${inList(users)})` : '';

  const where = (table: string) => {
    const parts = [...orphanTargets];
    if (userClause) parts.push(userClause);
    return parts.length === 0 ? null : `${table} WHERE ${parts.join(' OR ')}`;
  };

  // 举报行按 id 引用对象，不跟着实体删除就会变成孤儿：
  // 审核台会列出「目标已不在线」的死举报，占着队列还没法处理。
  // 先把将被删掉的评论 id 取出来，它们的举报同样要清。
  const commentRows = store.db.prepare(
    `${where('SELECT id FROM comments') ?? 'SELECT id FROM comments WHERE 0'}`,
  ).all(...targetParams.concat(users)) as Array<{ id: string }>;
  const commentIds = commentRows.map(row => row.id);

  const reportParts = [...orphanTargets];
  if (commentIds.length > 0) reportParts.push(`(targetType = 'comment' AND targetId IN (${inList(commentIds)}))`);
  if (users.length > 0) reportParts.push(`reporterHandle IN (${inList(users)})`);
  const reportParams = [...targetParams, ...commentIds, ...users];

  // 一句话反馈：挂在演示站下面的（那站本来就没人该反馈），以及演示账号发的。
  // 和举报不同，feedback 没有 hidden 之类的软删概念，只有 deletedAt 墓碑，
  // 所以这里连墓碑一起删——演示数据整批清掉时不该留半截。
  const feedbackParts: string[] = [];
  const feedbackParams: string[] = [];
  if (stations.length > 0) {
    feedbackParts.push(`stationSlug IN (${inList(stations)})`);
    feedbackParams.push(...stations);
  }
  if (users.length > 0) {
    feedbackParts.push(`userHandle IN (${inList(users)})`);
    feedbackParams.push(...users);
  }

  // 孤儿举报：目标实体/评论已经不在了。判定按 kind 分开写，因为 post/station
  // 存在 entities 里、comment 存在 comments 里，混在一个 NOT IN 里会误判。
  const orphanReports = store.db.prepare(
    `SELECT id, targetType, targetId FROM reports WHERE
       (targetType IN ('post','station') AND NOT EXISTS (SELECT 1 FROM entities WHERE entities.kind = reports.targetType AND entities.id = reports.targetId))
       OR (targetType = 'comment' AND NOT EXISTS (SELECT 1 FROM comments WHERE comments.id = reports.targetId))`,
  ).all() as Array<{ id: string; targetType: string; targetId: string }>;

  return {
    stations, posts, users, banners, comments: commentIds,
    offers: count(stations.length > 0 ? `SELECT COUNT(*) c FROM offers WHERE stationSlug IN (${inList(stations)})` : 'SELECT 0 c', stations),
    votes: count(`${where('SELECT COUNT(*) c FROM votes') ?? 'SELECT 0 c'}`, targetParams.concat(users)),
    favorites: count(`${where('SELECT COUNT(*) c FROM favorites') ?? 'SELECT 0 c'}`, targetParams.concat(users)),
    commentCount: count(`${where('SELECT COUNT(*) c FROM comments') ?? 'SELECT 0 c'}`, targetParams.concat(users)),
    reports: reportParts.length === 0 ? 0 : count(`SELECT COUNT(*) c FROM reports WHERE ${reportParts.join(' OR ')}`, reportParams),
    feedback: feedbackParts.length === 0 ? 0 : count(`SELECT COUNT(*) c FROM feedback WHERE ${feedbackParts.join(' OR ')}`, feedbackParams),
    orphanReports,
  };
}

export function applyPurge(store: ReturnType<typeof openStore>, plan: PurgePlan): void {
  store.transaction(() => {
    // 先删关联表再删实体：虽然没有外键约束，但反过来的话中途失败会留下孤儿行。
    if (plan.offers > 0) store.db.prepare(`DELETE FROM offers WHERE stationSlug IN (${inList(plan.stations)})`).run(...plan.stations);

    // 评论的删除条件。举报要按**这个条件现场算出来的评论 id** 去清，
    // 而不是 plan 里那份快照：plan 之后新评论挂到演示文章下面，实删会带走它，
    // 但快照里没有它的 id，于是它的举报会留下来变成死举报（实测复现过）。
    const commentWhere = (() => {
      const parts: string[] = [];
      if (plan.stations.length > 0) parts.push(`(targetType = 'station' AND targetId IN (${inList(plan.stations)}))`);
      if (plan.posts.length > 0) parts.push(`(targetType = 'post' AND targetId IN (${inList(plan.posts)}))`);
      if (plan.users.length > 0) parts.push(`userHandle IN (${inList(plan.users)})`);
      return parts.length === 0 ? null : parts.join(' OR ');
    })();
    const commentParams = [...plan.stations, ...plan.posts, ...plan.users];

    // 举报必须在评论**删掉之前**清：删完就查不到那些评论 id 了。
    const reportParts: string[] = [];
    const reportParams: string[] = [];
    if (plan.stations.length > 0) {
      reportParts.push(`(targetType = 'station' AND targetId IN (${inList(plan.stations)}))`);
      reportParams.push(...plan.stations);
    }
    if (plan.posts.length > 0) {
      reportParts.push(`(targetType = 'post' AND targetId IN (${inList(plan.posts)}))`);
      reportParams.push(...plan.posts);
    }
    if (commentWhere !== null) {
      reportParts.push(`(targetType = 'comment' AND targetId IN (SELECT id FROM comments WHERE ${commentWhere}))`);
      reportParams.push(...commentParams);
    }
    if (plan.users.length > 0) {
      reportParts.push(`reporterHandle IN (${inList(plan.users)})`);
      reportParams.push(...plan.users);
    }
    // 不用 plan.reports 当开关：plan 是快照，从 plan 到 apply 之间库还可能变。
    // 有条件就执行，删多少让 DELETE 自己决定。
    if (reportParts.length > 0) {
      store.db.prepare(`DELETE FROM reports WHERE ${reportParts.join(' OR ')}`).run(...reportParams);
    }
    // 一句话反馈按 stationSlug 引用站点，所以要在站点删除**之前**处理。
    // 条件现场用 plan 的名单重算：plan 到 apply 之间库里还可能多出反馈。
    if (plan.stations.length > 0 || plan.users.length > 0) {
      const parts: string[] = [];
      const params: string[] = [];
      if (plan.stations.length > 0) { parts.push(`stationSlug IN (${inList(plan.stations)})`); params.push(...plan.stations); }
      if (plan.users.length > 0) { parts.push(`userHandle IN (${inList(plan.users)})`); params.push(...plan.users); }
      store.db.prepare(`DELETE FROM feedback WHERE ${parts.join(' OR ')}`).run(...params);
    }

    // 目标已经不存在的举报。放在最后一步：上面刚删完 demo 实体，原来指向它们的
    // 举报此刻正好变成孤儿，一条 SQL 收干净，不依赖 plan 快照里的名单。
    store.db.prepare(
      `DELETE FROM reports WHERE
         (targetType IN ('post','station') AND NOT EXISTS (SELECT 1 FROM entities WHERE entities.kind = reports.targetType AND entities.id = reports.targetId))
         OR (targetType = 'comment' AND NOT EXISTS (SELECT 1 FROM comments WHERE comments.id = reports.targetId))`,
    ).run();

    if (plan.posts.length > 0) {
      // 演示文章的下架/恢复流水一并清掉：文章都删了，流水指向的是不存在的 id。
      store.db.prepare(`DELETE FROM post_events WHERE postId IN (${inList(plan.posts)})`).run(...plan.posts);
    }
    if (plan.stations.length > 0 || plan.posts.length > 0) {
      for (const table of ['votes', 'favorites']) {
        store.db.prepare(`DELETE FROM ${table} WHERE (targetType = 'station' AND targetId IN (${inList(plan.stations)})) OR (targetType = 'post' AND targetId IN (${inList(plan.posts)}))`)
          .run(...plan.stations, ...plan.posts);
      }
    }
    if (plan.users.length > 0) {
      // comment_writes 是限流流水，演示账号被删后这些行永远是孤儿：留着只会
      // 让「demo- 前缀被新人复用」时白占额度（前缀可复用，见 planPurge 的注释）。
      for (const table of ['votes', 'favorites', 'checkins', 'comment_writes']) {
        store.db.prepare(`DELETE FROM ${table} WHERE userHandle IN (${inList(plan.users)})`).run(...plan.users);
      }
      // post_events 用 authorHandle 而不是 userHandle（它记的是「谁的文章」）。
      store.db.prepare(`DELETE FROM post_events WHERE authorHandle IN (${inList(plan.users)})`).run(...plan.users);
    }
    if (commentWhere !== null) {
      store.db.prepare(`DELETE FROM comments WHERE ${commentWhere}`).run(...commentParams);
    }
    // 实体本身直接物理删除：软删除（removedAt）会让它们继续参与 slug 认领，
    // 反而更容易和新投稿撞车。
    if (plan.stations.length > 0) store.db.prepare(`DELETE FROM entities WHERE kind = 'station' AND id IN (${inList(plan.stations)})`).run(...plan.stations);
    if (plan.posts.length > 0) store.db.prepare(`DELETE FROM entities WHERE kind = 'post' AND id IN (${inList(plan.posts)})`).run(...plan.posts);
    if (plan.users.length > 0) store.db.prepare(`DELETE FROM entities WHERE kind = 'user' AND id IN (${inList(plan.users)})`).run(...plan.users);
    if (plan.banners.length > 0) store.db.prepare(`DELETE FROM entities WHERE kind = 'banner' AND id IN (${inList(plan.banners)})`).run(...plan.banners);
    // 实体删完再让缓存失效：上面的 DELETE 绕过了 store.put/markRemoved，
    // 不调的话同一进程里会继续读到删之前的派生索引。
    store.invalidate();
  });
}

/** 命令行入口：默认 dry-run，--apply 才写库。 */
export async function main(argv: readonly string[]): Promise<number> {
  const apply = argv.includes('--apply');
  const dbPath = argv.find(arg => arg.startsWith('--db='))?.slice(5) ?? process.env.DB_PATH;
  if (!dbPath) throw new Error('需要 --db=<路径> 或环境变量 DB_PATH');
  // 与 backfill 一致：库不存在就报错，绝不让 openDatabase 顺手造一个空库出来。
  if (!existsSync(dbPath)) throw new Error(`数据库不存在：${dbPath}`);
  const db = apply ? openDatabase(dbPath) : openDatabase(dbPath, { readOnly: true });
  try {
    const store = openStore(db);
    const plan = planPurge(store);
    const total = plan.stations.length + plan.posts.length + plan.users.length + plan.banners.length;
    console.log(`演示数据：站点 ${plan.stations.length}、文章 ${plan.posts.length}、用户 ${plan.users.length}、横幅 ${plan.banners.length}（共 ${total} 条实体）`);
    // 举报不用 plan 的数字：plan 之后新插入的举报会被 DELETE 一起清掉，说死一个
    // 更小的数会让运维以为「没有举报要清」。这里说清它是动态的。
    console.log(`关联数据：报价 ${plan.offers}、投票 ${plan.votes}、收藏 ${plan.favorites}、评论 ${plan.commentCount}、举报 ${plan.reports}、一句话反馈 ${plan.feedback}（执行时按同一条件重算，可能更多）`);
    if (plan.orphanReports.length > 0) {
      console.log(`目标已不存在的举报：${plan.orphanReports.length} 条（审核台会一直显示「已不在线」，一并清掉）`);
    }
    if (plan.stations.length > 0) console.log(`  站点：${plan.stations.join(', ')}`);
    if (plan.posts.length > 0) console.log(`  文章：${plan.posts.slice(0, 10).join(', ')}${plan.posts.length > 10 ? ` …共 ${plan.posts.length} 篇` : ''}`);
    // 实体为 0 也可能有事要做：孤儿举报（目标已被别的途径删掉）。
    if (total === 0 && plan.orphanReports.length === 0) {
      console.log('没有演示数据，无需清理。');
      return 0;
    }
    if (!apply) {
      console.log('\n当前是 dry-run，没有写库。确认无误后加 --apply 执行。');
      return 0;
    }
    applyPurge(store, plan);
    console.log('\n已清理。');
    return 0;
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
