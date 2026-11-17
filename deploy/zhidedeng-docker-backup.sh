#!/usr/bin/env bash
# 容器部署的 SQLite 备份。每天由 zhidedeng-backup.timer 触发。
#
# 为什么不在宿主机上直接跑 sqlite3：数据库在 docker 卷里，宿主机没有
# 对容器的写锁协调。VACUUM INTO 在**容器内**以只读连接执行，由 SQLite 自己
# 保证 WAL 下的一致性快照；再用 docker cp 取出来。
#
#   CONTAINER=zhidedeng BACKUP_DIR=... deploy/zhidedeng-docker-backup.sh
set -euo pipefail

container="${CONTAINER:-zhidedeng}"
: "${BACKUP_DIR:?需要 BACKUP_DIR}"
keep="${BACKUP_KEEP:-14}"

umask 077
mkdir -p "$BACKUP_DIR"
stamp="$(date +%Y%m%d-%H%M%S)"
target="$BACKUP_DIR/app-$stamp.db"
tmp_in_container="/data/.backup-$stamp.db"
trap 'docker exec "$container" rm -f "$tmp_in_container" 2>/dev/null || true' EXIT

# 只读连接 + VACUUM INTO：不改动线上库，也不会阻塞它太久（库只有几百 KB）。
docker exec "$container" node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/data/zhidedeng.db', { readOnly: true });
db.exec(\"VACUUM INTO '${tmp_in_container}'\");
db.close();
" 2>/dev/null

docker cp "$container:$tmp_in_container" "$target.partial"
# docker cp 会沿用容器内文件的权限（node 以默认 umask 建的，644），
# 脚本自己的 umask 对它不起作用。备份里有密码哈希和会话摘要，
# 不能只靠目录 700 兜底——显式收紧到 600。
chmod 600 "$target.partial"

# 校验：能打开、integrity_check 通过、核心表在。
integrity="$(sqlite3 "$target.partial" 'PRAGMA integrity_check' 2>/dev/null || echo failed)"
count="$(sqlite3 "$target.partial" 'SELECT COUNT(*) FROM entities' 2>/dev/null || echo 0)"
if [ "$integrity" != "ok" ] || [ "$count" -lt 1 ]; then
  echo "备份校验失败：integrity=$integrity entities=$count" >&2
  rm -f "$target.partial"
  exit 1
fi
mv "$target.partial" "$target"
echo "已备份 $target（integrity=ok, entities=$count）"

# 只留最近 keep 份。备份里有密码哈希和会话摘要，umask 已限成只有属主可读。
ls -1t "$BACKUP_DIR"/app-*.db 2>/dev/null | tail -n "+$((keep + 1))" | xargs -r rm -f
