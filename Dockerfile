# 三阶段构建：依赖 → 打包 → 运行。
# 运行镜像里只放 release/ 产物，不带源码和 devDependencies。

FROM node:22-slim AS deps
WORKDIR /app
# pnpm 版本由 package.json 的 packageManager 字段决定，这里不另写一份。
RUN corepack enable
# 先只拷清单和锁文件：源码改动不会让这一层失效。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY web/package.json ./web/
COPY scripts/package.json ./scripts/
RUN pnpm install --frozen-lockfile

FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
# 复用上一层的 node_modules，避免重复下载。
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 产出 release/server.mjs 与 release/web。
RUN pnpm build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# 数据库要落在挂载卷上，不放容器可写层，否则重建容器数据就没了。
ENV DB_PATH=/data/zhidedeng.db
# 只监听 127.0.0.1 是给宿主机 nginx 反代用的；容器里必须监听全部网卡。
ENV HOST=0.0.0.0
ENV PORT=8787
# sqlite 的 -wal / -shm 与主库同目录，备份脚本也依赖这一点。
RUN mkdir -p /data && chown -R node:node /data
COPY --from=build --chown=node:node /app/release ./release
USER node
WORKDIR /app/release
EXPOSE 8787
# 用 node 的内置能力做就绪探针，镜像里没有 curl。
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
