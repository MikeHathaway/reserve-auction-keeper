import "dotenv/config";
import { loadConfig } from "./config.js";
import { startKeeper, requestShutdown } from "./keeper.js";
import { startHealthCheck, stopHealthCheck } from "./utils/health.js";
import { logger, setLogLevel } from "./utils/logger.js";

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
    dryRun: config.dryRun,
  });

  // Start health check server
  startHealthCheck(config.healthCheckPort);

  // Graceful shutdown handler
  const shutdown = async () => {
    requestShutdown();
    // Give loops 30 seconds to finish their current cycle
    setTimeout(async () => {
      logger.warn("Forced shutdown after timeout");
      await stopHealthCheck();
      process.exit(1);
    }, 30_000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await startKeeper(config);
  } catch (error) {
    logger.fatal("Keeper crashed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  await stopHealthCheck();
  logger.info("Keeper stopped cleanly");
}

main();
