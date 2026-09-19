# 单一镜像，API / 采集 Worker / 邮件 Worker 通过不同的启动命令运行
FROM node:20-bookworm-slim AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:20-bookworm-slim AS server-build
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim
ENV NODE_ENV=production WEB_DIST=/app/web/dist
WORKDIR /app/server
COPY --from=server-build /app/server/node_modules ./node_modules
COPY --from=server-build /app/server/dist ./dist
COPY server/package.json ./
COPY server/migrations ./migrations
COPY remote /app/remote
COPY --from=web /app/web/dist /app/web/dist
USER node
EXPOSE 3000
CMD ["node", "dist/main-api.js"]
