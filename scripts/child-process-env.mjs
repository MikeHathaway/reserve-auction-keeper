const PASSTHROUGH_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PWD",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "CI",
  "NO_COLOR",
  "COLORTERM",
  "FORGE_PROFILE",
  "FOUNDRY_PROFILE",
  "FOUNDRY_CONFIG",
  "FOUNDRY_CACHE_PATH",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "NVM_BIN",
  "NVM_DIR",
];

export function createRestrictedChildEnv(overrides = {}, extraKeys = []) {
  const env = {};
  const allowedExtraKeys = new Set(extraKeys);

  for (const key of PASSTHROUGH_ENV_KEYS) {
    const value = process.env[key];
    if (value != null && value !== "") {
      env[key] = value;
    }
  }

  for (const key of allowedExtraKeys) {
    const value = process.env[key];
    if (value != null && value !== "") {
      env[key] = value;
    }
  }

  return {
    ...env,
    ...overrides,
  };
}
