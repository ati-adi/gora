# Gora — single instance only (one SQLite writer). 01 §14.
# ── builder: install everything and build the Mini App
FROM node:26-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY webapp ./webapp
RUN npm run build:webapp

# ── runtime: production deps + TypeScript sources (Node 26 strips types natively)
FROM node:26-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    KEYS_DB_PATH=/keys/keys.db \
    BACKUP_DIR=/backups
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY scripts ./scripts
COPY --from=builder /app/dist/webapp ./dist/webapp
RUN mkdir -p /data /keys /backups && chown -R node:node /data /keys /backups /app
USER node
VOLUME ["/data", "/keys", "/backups"]
EXPOSE 8080
CMD ["node", "src/main.ts"]
