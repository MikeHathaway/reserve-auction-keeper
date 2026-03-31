import "dotenv/config";
import { loadConfig } from "./config.js";
import { startKeeper, requestShutdown } from "./keeper.js";
import { startHealthCheck, stopHealthCheck } from "./utils/health.js";
import { logger, setAlertWebhookUrl, setLogLevel } from "./utils/logger.js";

const CONFIG_PATH = process.env.CONFIG_PATH || "config.json";
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

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
    chains: config.chains.map((c) => c.chainConfig.name),
    strategy: config.strategy,
    pricingProvider: config.pricing.provider,
    dryRun: config.dryRun,
  });

  setAlertWebhookUrl(config.alertWebhookUrl);

  // Start health check server
  startHealthCheck(config.healthCheckPort);

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
  await stopHealthCheck();

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
  logger.info("Keeper stopped cleanly");
}

main();
