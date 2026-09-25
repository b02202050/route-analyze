FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY . .
RUN npm run build -w web

ENV NODE_ENV=production \
    PORT=8787 \
    BROUTER_URL=http://brouter:17777
EXPOSE 8787
CMD ["npm", "start"]
