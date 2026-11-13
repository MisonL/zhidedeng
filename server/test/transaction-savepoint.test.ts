import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, openStore } from '../src/node-app.ts';

/** 事务嵌套的语义回归。内层失败只该撤销自己，不该把外层未提交的写入一起丢掉。 */
describe('嵌套事务', () => {
  const fresh = () => {
    const db = openDatabase(':memory:') as DatabaseSync;
    const store = openStore(db);
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
    return { store, db };
  };
  const ids = (db: DatabaseSync) => db.prepare('SELECT id FROM t ORDER BY id').all().map(row => row.id as string);

  it('内外层都成功时全部提交', () => {
    const { store, db } = fresh();
    store.transaction(() => {
      store.db.prepare('INSERT INTO t VALUES (?)').run('a');
      store.transaction(() => { store.db.prepare('INSERT INTO t VALUES (?)').run('b'); });
      store.db.prepare('INSERT INTO t VALUES (?)').run('c');
    });
    expect(ids(db)).toEqual(['a', 'b', 'c']);
    db.close();
  });

  it('内层失败被外层捕获时，外层已写入的内容仍然保留', () => {
    const { store, db } = fresh();
    store.transaction(() => {
      store.db.prepare('INSERT INTO t VALUES (?)').run('a');
      try {
        store.transaction(() => {
          store.db.prepare('INSERT INTO t VALUES (?)').run('b');
          throw new Error('内层失败');
        });
      } catch { /* 外层选择继续 */ }
      store.db.prepare('INSERT INTO t VALUES (?)').run('c');
    });
    expect(ids(db)).toEqual(['a', 'c']);
    db.close();
  });

  it('外层失败仍然整体回滚（包括内层已提交的部分）', () => {
    const { store, db } = fresh();
    expect(() => store.transaction(() => {
      store.transaction(() => { store.db.prepare('INSERT INTO t VALUES (?)').run('a'); });
      throw new Error('外层失败');
    })).toThrow('外层失败');
    expect(ids(db)).toEqual([]);
    db.close();
  });
});
