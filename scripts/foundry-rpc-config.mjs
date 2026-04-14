import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function stripRpcEndpointsSection(configText) {
  return configText.replace(/\n\[rpc_endpoints\][\s\S]*$/m, "\n").trimEnd();
}

export function createEphemeralFoundryRpcConfig(alias, rpcUrl) {
  const projectConfigPath = join(process.cwd(), "foundry.toml");
  const projectConfig = readFileSync(projectConfigPath, "utf-8");
  const tempDir = mkdtempSync(
    join(tmpdir(), "reserve-auction-keeper-foundry-"),
  );
  const configPath = join(tempDir, "foundry.toml");
  const sanitizedConfig = stripRpcEndpointsSection(projectConfig);

  writeFileSync(
    configPath,
    `${sanitizedConfig}\n\n[rpc_endpoints]\n${alias} = "${rpcUrl}"\n`,
    { mode: 0o600 },
  );

  let cleaned = false;
  const cleanupSignals = [
    "exit",
    "uncaughtException",
    "unhandledRejection",
  ];
  const handlers = cleanupSignals.map((signal) => {
    const handler = () => {
      if (cleaned) return;
      cleaned = true;
      rmSync(tempDir, { recursive: true, force: true });
    };
    process.once(signal, handler);
    return [signal, handler];
  });

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
    rmSync(tempDir, { recursive: true, force: true });
  };

  return {
    configPath,
    workdir: tempDir,
    cleanup,
  };
}
