#!/usr/bin/env bash
# 用 VACUUM INTO 做一致性备份，校验后保留最近 BACKUP_KEEP 份（默认 14）。
# 备份里有密码哈希和会话摘要，文件只有属主可读。
#
#   DB_PATH=... BACKUP_DIR=... deploy/backup-sqlite.sh
set -euo pipefail

: "${DB_PATH:?需要 DB_PATH}"
: "${BACKUP_DIR:?需要 BACKUP_DIR}"
keep="${BACKUP_KEEP:-14}"

umask 077
mkdir -p "$BACKUP_DIR"
target="$BACKUP_DIR/app-$(date +%Y%m%d-%H%M%S).db"
partial="$target.partial"
trap 'rm -f "$partial"' EXIT

case "$partial" in
  *\'*) echo "BACKUP_DIR 不能包含单引号" >&2; exit 2 ;;
esac

if [ ! -f "$DB_PATH" ]; then
 echo "备份中止：数据库文件不存在：$DB_PATH" >&2
 exit 2
fi

sqlite3 -cmd '.timeout 30000' "$DB_PATH" "VACUUM INTO '$partial'"

#只查 integrity_check不够：路径写错时 sqlite3会就地建一个**空库**再 VACUUM，
#integrity照样是 ok、退出码0，脚本打印「备份完成」——而保留策略接着把真正的
#备份按14份滚动删掉。所以必须同时要求核心表有数据。
result="$(sqlite3 "$partial" 'PRAGMA integrity_check')"
if [ "$result" != "ok" ]; then
 echo "备份校验失败：integrity=$result" >&2
 exit 1
fi
if ! tables="$(sqlite3 "$partial" 'SELECT COUNT(*) FROM entities')"; then
 echo "备份校验失败：备份库里没有 entities表，多半是 DB_PATH指到了错误位置" >&2
 exit 1
fi
if [ "${tables:-0}" -lt 1 ]; then
 echo "备份校验失败：备份库里 entities为0行，拒绝把空库当成有效备份（DB_PATH=${DB_PATH}）" >&2
 exit 1
fi
echo "备份校验：integrity=ok entities=$tables"
mv "$partial" "$target"

# 文件名带时间戳，按名字倒序就是从新到旧。
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'app-*.db' | sort -r | tail -n +"$((keep + 1))" | while IFS= read -r old; do
  rm -f -- "$old"
done

echo "备份完成：$target"
