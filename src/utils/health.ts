import { createServer, type Server } from "node:http";
import { logger } from "./logger.js";

let server: Server | null = null;
let healthy = true;

export function setHealthy(value: boolean) {
  healthy = value;
}

export function startHealthCheck(port: number): Server {
  server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: healthy ? "ok" : "degraded", ts: Date.now() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, () => {
    logger.info("Health check server started", { port });
  });

  return server;
}

export function stopHealthCheck(): Promise<void> {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => resolve());
    } else {
      resolve();
    }
  });
}
