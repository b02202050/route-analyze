# ---- 第一階段：建置前端（需要完整的開發套件：TypeScript、Vite、React…）----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY shared shared
COPY web web
RUN npm run build -w web

# ---- 第二階段：執行環境，只保留 server 的正式相依套件與建置好的前端 ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    BROUTER_URL=http://brouter:17777

# npm workspaces 需要所有 workspace 的 package.json 才能安裝，但只裝 server 的正式相依
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace server --no-audit --no-fund \
 && npm cache clean --force

COPY server/src server/src
COPY shared shared
COPY brouter/profiles/running.brf brouter/profiles/running.brf
COPY --from=build /app/web/dist web/dist

# 便利商店資料快取目錄（以非 root 使用者執行）
RUN mkdir -p server/data && chown node:node server/data
USER node

EXPOSE 8787
# 直接以 node 執行（不經過 npm），容器停止時能正確收到訊號
CMD ["node", "--import", "tsx", "server/src/index.ts"]
