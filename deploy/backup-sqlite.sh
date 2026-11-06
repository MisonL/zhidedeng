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

sqlite3 -cmd '.timeout 10000' "$DB_PATH" "VACUUM INTO '$partial'"
result="$(sqlite3 "$partial" 'PRAGMA integrity_check')"
if [ "$result" != "ok" ]; then
  echo "备份校验失败：$result" >&2
  exit 1
fi
mv "$partial" "$target"

# 文件名带时间戳，按名字倒序就是从新到旧。
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'app-*.db' | sort -r | tail -n +"$((keep + 1))" | while IFS= read -r old; do
  rm -f -- "$old"
done

echo "备份完成：$target"
