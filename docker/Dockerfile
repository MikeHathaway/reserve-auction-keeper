FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist/ dist/
RUN mkdir -p /app/.cache/pool-discovery

# Config is mounted at runtime and secrets are passed via environment.
# Discovery cache can be persisted by mounting /app/.cache/pool-discovery.

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then((res)=>process.exit(res.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/index.js"]
