#!/usr/bin/env bash
# 本地构建，rsync 到服务器，重启服务，健康检查。服务器不需要 node_modules。
#
#   DEPLOY_HOST=user@host deploy/deploy.sh
#
# 环境变量：
#   DEPLOY_HOST   必填，ssh 目标（也可以是 ~/.ssh/config 里的别名）
#   DEPLOY_PATH   服务器上的程序目录，默认 /opt/zhidedeng，部署用户要有写权限
#   DEPLOY_SERVICE systemd 服务名，默认 zhidedeng，部署用户要能免密 sudo systemctl restart 它
#   APP_PORT      服务监听端口，默认 8787，与服务器环境文件里的 PORT 一致
#   SKIP_TESTS    设为 1 时跳过本地测试
set -euo pipefail

: "${DEPLOY_HOST:?需要 DEPLOY_HOST，例如 user@host}"
deploy_path="${DEPLOY_PATH:-/opt/zhidedeng}"
service="${DEPLOY_SERVICE:-zhidedeng}"
port="${APP_PORT:-8787}"

cd "$(dirname "$0")/.."

pnpm install --frozen-lockfile
if [ "${SKIP_TESTS:-}" != "1" ]; then
  pnpm -r typecheck
  pnpm -r test
fi
pnpm build

# 只同步 release/ 的内容；数据库在 /var/lib/zhidedeng，不受 --delete 影响。
rsync -az --delete release/ "$DEPLOY_HOST:$deploy_path/"
ssh "$DEPLOY_HOST" "sudo systemctl restart $(printf '%q' "$service")"

for _ in $(seq 1 30); do
  if ssh "$DEPLOY_HOST" "curl -fsS --max-time 2 http://127.0.0.1:$(printf '%q' "$port")/api/health" >/dev/null 2>&1; then
    echo "部署完成，健康检查通过"
    exit 0
  fi
  sleep 1
done

echo "健康检查失败，最近日志：" >&2
ssh "$DEPLOY_HOST" "sudo journalctl -u $(printf '%q' "$service") -n 50 --no-pager" >&2 || true
exit 1
