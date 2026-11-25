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

  return {
    stations, posts, users, banners, comments: commentIds,
    offers: count(stations.length > 0 ? `SELECT COUNT(*) c FROM offers WHERE stationSlug IN (${inList(stations)})` : 'SELECT 0 c', stations),
    votes: count(`${where('SELECT COUNT(*) c FROM votes') ?? 'SELECT 0 c'}`, targetParams.concat(users)),
    favorites: count(`${where('SELECT COUNT(*) c FROM favorites') ?? 'SELECT 0 c'}`, targetParams.concat(users)),
    commentCount: count(`${where('SELECT COUNT(*) c FROM comments') ?? 'SELECT 0 c'}`, targetParams.concat(users)),
    reports: reportParts.length === 0 ? 0 : count(`SELECT COUNT(*) c FROM reports WHERE ${reportParts.join(' OR ')}`, reportParams),
  };
}

export function applyPurge(store: ReturnType<typeof openStore>, plan: PurgePlan): void {
  store.transaction(() => {
    // 先删关联表再删实体：虽然没有外键约束，但反过来的话中途失败会留下孤儿行。
    if (plan.offers > 0) store.db.prepare(`DELETE FROM offers WHERE stationSlug IN (${inList(plan.stations)})`).run(...plan.stations);
    const targets = [...plan.stations, ...plan.posts];
    if (targets.length > 0) {
      for (const table of ['votes', 'favorites', 'comments']) {
        store.db.prepare(`DELETE FROM ${table} WHERE (targetType = 'station' AND targetId IN (${inList(plan.stations)})) OR (targetType = 'post' AND targetId IN (${inList(plan.posts)}))`)
          .run(...plan.stations, ...plan.posts);
      }
    }
    if (plan.users.length > 0) {
      for (const table of ['votes', 'favorites', 'comments', 'checkins']) {
        store.db.prepare(`DELETE FROM ${table} WHERE userHandle IN (${inList(plan.users)})`).run(...plan.users);
      }
    }
    // 举报行最后清：它按 id 引用上面被删掉的对象，早删或漏删都会留下死举报。
    //
    // 不能拿 `plan.reports > 0` 当开关：plan 是之前拍的快照，从 plan 到 apply 之间
    // 可能又插进来一条匹配的举报（实删 2 > 计划 1），也可能 plan 时是 0 而之后
    // 变成了孤儿举报——那样整块被跳过，删完留下一堆指向不存在对象的死举报。
    // 所以这里有条件就执行，删多少让 DELETE 自己决定。
    const reportParts: string[] = [];
    if (plan.stations.length > 0) reportParts.push(`(targetType = 'station' AND targetId IN (${inList(plan.stations)}))`);
    if (plan.posts.length > 0) reportParts.push(`(targetType = 'post' AND targetId IN (${inList(plan.posts)}))`);
    if (plan.comments.length > 0) reportParts.push(`(targetType = 'comment' AND targetId IN (${inList(plan.comments)}))`);
    if (plan.users.length > 0) reportParts.push(`reporterHandle IN (${inList(plan.users)})`);
    if (reportParts.length > 0) {
      store.db.prepare(`DELETE FROM reports WHERE ${reportParts.join(' OR ')}`)
        .run(...plan.stations, ...plan.posts, ...plan.comments, ...plan.users);
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
    console.log(`关联数据：报价 ${plan.offers}、投票 ${plan.votes}、收藏 ${plan.favorites}、评论 ${plan.commentCount}、举报 ${plan.reports}（执行时按同一条件重算，可能更多）`);
    if (plan.stations.length > 0) console.log(`  站点：${plan.stations.join(', ')}`);
    if (plan.posts.length > 0) console.log(`  文章：${plan.posts.slice(0, 10).join(', ')}${plan.posts.length > 10 ? ` …共 ${plan.posts.length} 篇` : ''}`);
    if (total === 0) {
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
