# Một image dùng cho cả ba khối (bot, admin, worker); lệnh chạy khác nhau trong docker-compose.yml.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY content ./content
# không chạy bằng root
RUN mkdir -p /app/data/media /app/data/vault /app/data/raw-data && chown -R node:node /app
USER node
EXPOSE 3000 3001
CMD ["node", "dist/bot.js"]
