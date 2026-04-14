FROM node:20-alpine@sha256:f598378b5240225e6beab68fa9f356db1fb8efe55173e6d4d8153113bb8f333c AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:20-alpine@sha256:f598378b5240225e6beab68fa9f356db1fb8efe55173e6d4d8153113bb8f333c

RUN addgroup -S keeper && adduser -S keeper -G keeper
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist/ dist/
RUN mkdir -p /app/.cache/pool-discovery && chown -R keeper:keeper /app/.cache
USER keeper

# Config is mounted at runtime and secrets are passed via environment.
# Discovery cache can be persisted by mounting /app/.cache/pool-discovery.

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then((res)=>process.exit(res.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/index.js"]
