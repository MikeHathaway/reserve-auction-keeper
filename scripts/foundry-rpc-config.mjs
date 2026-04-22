import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

function stripRpcEndpointsSection(configText) {
  return configText.replace(/\n\[rpc_endpoints\][\s\S]*$/m, "\n").trimEnd();
}

// Rewrite project-relative path values (src, test, out, cache_path, libs)
// to absolute paths rooted at `projectRoot`. Needed when the ephemeral
// config lives outside the project (in /tmp) and forge uses --config-path:
// forge resolves relative paths from the config file's directory, so
// `src = "contracts"` would point at /tmp/.../contracts and match nothing.
function absolutizeProjectPaths(configText, projectRoot) {
  const scalarKeys = ["src", "test", "out", "cache_path", "script", "broadcast"];
  let result = configText;
  for (const key of scalarKeys) {
    const pattern = new RegExp(`^(\\s*${key}\\s*=\\s*)"([^"]+)"`, "gm");
    result = result.replace(pattern, (_, prefix, value) => {
      if (isAbsolute(value)) return `${prefix}"${value}"`;
      return `${prefix}"${resolve(projectRoot, value)}"`;
    });
  }
  result = result.replace(/^(\s*libs\s*=\s*)\[([^\]]*)\]/gm, (_, prefix, inner) => {
    const rewritten = inner.replace(/"([^"]+)"/g, (__, value) => {
      if (isAbsolute(value)) return `"${value}"`;
      return `"${resolve(projectRoot, value)}"`;
    });
    return `${prefix}[${rewritten}]`;
  });
  return result;
}

export function createEphemeralFoundryRpcConfig(alias, rpcUrl, options = {}) {
  const { absolutePaths = false } = options;
  const projectRoot = process.cwd();
  const projectConfigPath = join(projectRoot, "foundry.toml");
  const projectConfig = readFileSync(projectConfigPath, "utf-8");
  const tempDir = mkdtempSync(
    join(tmpdir(), "reserve-auction-keeper-foundry-"),
  );
  const configPath = join(tempDir, "foundry.toml");
  let sanitizedConfig = stripRpcEndpointsSection(projectConfig);
  if (absolutePaths) {
    sanitizedConfig = absolutizeProjectPaths(sanitizedConfig, projectRoot);
  }

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
