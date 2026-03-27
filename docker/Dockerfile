FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY --from=builder /app/dist/ dist/

# Config and env are mounted at runtime
# docker run -v ./config.json:/app/config.json -v ./.env:/app/.env ...

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:8080/health || exit 1

CMD ["node", "dist/index.js"]
