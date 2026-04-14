import { createServer, type Server } from "node:http";
import { formatErrorForLogs, logger } from "./logger.js";

let server: Server | null = null;
let healthy = true;
const dependencies = new Map<string, {
  healthy: boolean;
  updatedAt: number;
  reason?: string;
}>();

export function setHealthy(value: boolean) {
  healthy = value;
}

export function setHealthDependency(
  name: string,
  value: boolean,
  reason?: string,
) {
  dependencies.set(name, {
    healthy: value,
    updatedAt: Date.now(),
    reason,
  });
}

export function clearHealthDependency(name: string) {
  dependencies.delete(name);
}

export function clearAllHealthDependencies() {
  dependencies.clear();
}

function getHealthSnapshot() {
  const dependencyStatuses = Object.fromEntries(
    [...dependencies.entries()].map(([name, status]) => [
      name,
      {
        healthy: status.healthy,
        updatedAt: status.updatedAt,
        reason: status.reason,
      },
    ]),
  );
  const unhealthyDependencies = Object.entries(dependencyStatuses)
    .filter(([, status]) => !status.healthy)
    .map(([name]) => name);

  return {
    healthy: healthy && unhealthyDependencies.length === 0,
    unhealthyDependencies,
    dependencies: dependencyStatuses,
  };
}

export function startHealthCheck(port: number): Promise<Server> {
  if (server) {
    return Promise.resolve(server);
  }

  const healthServer = createServer((req, res) => {
    const snapshot = getHealthSnapshot();
    if (req.url === "/health") {
      res.writeHead(snapshot.healthy ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: snapshot.healthy ? "ok" : "degraded",
        ts: Date.now(),
        unhealthyDependencies: snapshot.unhealthyDependencies,
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server = healthServer;
  healthServer.on("close", () => {
    if (server === healthServer) {
      server = null;
    }
  });
  healthServer.on("error", (error) => {
    setHealthy(false);
    if (server === healthServer) {
      server = null;
    }
    logger.error("Health check server error", {
      port,
      error: formatErrorForLogs(error),
    });
  });

  return new Promise((resolve, reject) => {
    const handleStartupError = (error: Error) => {
      reject(error);
    };

    healthServer.once("error", handleStartupError);
    healthServer.listen(port, () => {
      healthServer.off("error", handleStartupError);
      logger.info("Health check server started", { port });
      resolve(healthServer);
    });
  });
}

export function stopHealthCheck(): Promise<void> {
  return new Promise((resolve) => {
    const activeServer = server;
    if (!activeServer) {
      resolve();
      return;
    }

    server = null;
    activeServer.close(() => resolve());
  });
}
