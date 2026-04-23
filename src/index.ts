import "dotenv/config";
import { loadConfig } from "./config.js";
import { startKeeper, requestShutdown } from "./keeper.js";
import { setHealthy, startHealthCheck, stopHealthCheck } from "./utils/health.js";
import { logger, setAlertWebhookUrl, setLogLevel } from "./utils/logger.js";

const CONFIG_PATH = process.env.CONFIG_PATH || "config.json";
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

function resolveHealthCheckPort(configPort: number): number {
  const raw = process.env.HEALTH_CHECK_PORT;
  if (!raw) {
    return configPort;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid HEALTH_CHECK_PORT: ${raw}`);
  }

  return parsed;
}

async function main() {
  setLogLevel(LOG_LEVEL as "debug" | "info" | "warn" | "error");

  logger.info("Ajna Reserve Auction Keeper starting", {
    configPath: CONFIG_PATH,
    nodeVersion: process.version,
  });

  const config = (() => {
    try {
      return loadConfig(CONFIG_PATH);
    } catch (error) {
      logger.fatal("Failed to load config", {
        configPath: CONFIG_PATH,
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  })();

  logger.info("Config loaded", {
    strategies: config.chains.map((c) => `${c.chainConfig.name}:${c.strategy}`),
    pricingProvider: config.pricing.provider,
    dryRun: config.dryRun,
  });

  const healthCheckPort = (() => {
    try {
      return resolveHealthCheckPort(config.healthCheckPort);
    } catch (error) {
      logger.fatal("Invalid health check port configuration", {
        configHealthCheckPort: config.healthCheckPort,
        envHealthCheckPort: process.env.HEALTH_CHECK_PORT,
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  })();

  setAlertWebhookUrl(config.alertWebhookUrl);

  // Start health check server
  try {
    await startHealthCheck(healthCheckPort);
  } catch (error) {
    logger.fatal("Failed to start health check server", {
      port: healthCheckPort,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  let forcedShutdownTimer: ReturnType<typeof setTimeout> | undefined;
  let shutdownInitiated = false;

  // Graceful shutdown handler
  const shutdown = async () => {
    if (shutdownInitiated) return;
    shutdownInitiated = true;
    requestShutdown();
    // Give loops 30 seconds to finish their current cycle
    forcedShutdownTimer = setTimeout(async () => {
      logger.warn("Forced shutdown after timeout");
      await stopHealthCheck();
      process.exit(1);
    }, 30_000);
    forcedShutdownTimer.unref?.();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  let exitCode = 0;

  try {
    await startKeeper(config);
  } catch (error) {
    logger.fatal("Keeper crashed", {
      error: error instanceof Error ? error.message : String(error),
    });
    exitCode = 1;
  }

  if (forcedShutdownTimer) {
    clearTimeout(forcedShutdownTimer);
  }
  setHealthy(false);
  await stopHealthCheck();

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
  logger.info("Keeper stopped cleanly");
}

main();
