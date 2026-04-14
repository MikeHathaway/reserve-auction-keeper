import {
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { keccak256, type Hex } from "viem";

const PRIVATE_KEY_REGEX = /^0x[0-9a-fA-F]{64}$/;
const HEX_REGEX = /^[0-9a-fA-F]+$/;
const SCRYPT_MAXMEM_LIMIT_BYTES = 512 * 1024 * 1024;
const SCRYPT_MAXMEM_HEADROOM_BYTES = 32 * 1024 * 1024;

interface KeystoreCrypto {
  cipher?: string;
  ciphertext?: string;
  cipherparams?: {
    iv?: string;
  };
  kdf?: string;
  kdfparams?: Record<string, unknown>;
  mac?: string;
}

interface KeystorePayload {
  version?: number;
  crypto?: KeystoreCrypto;
  Crypto?: KeystoreCrypto;
}

function readSecretFile(filePath: string, label: string): string {
  try {
    return readFileSync(filePath, "utf-8").trim();
  } catch (error) {
    throw new Error(`${label} could not be read from ${filePath}: ${getErrorMessage(error)}`);
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function ensureHex(label: string, value: string): string {
  if (value.length === 0 || value.length % 2 !== 0 || !HEX_REGEX.test(value)) {
    throw new Error(`${label} must be a valid even-length hex string`);
  }
  return value.toLowerCase();
}

function parseHexBytes(label: string, value: string): Buffer {
  return Buffer.from(ensureHex(label, value), "hex");
}

function parsePositiveInteger(label: string, value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Unsupported keystore: ${label} must be a positive integer`);
  }
  return parsed;
}

export function normalizePrivateKey(value: string, label: string): Hex {
  const trimmed = value.trim();
  if (!PRIVATE_KEY_REGEX.test(trimmed)) {
    throw new Error(`${label} must be a 32-byte hex string starting with 0x`);
  }
  return trimmed.toLowerCase() as Hex;
}

export function loadOptionalHexSecret(
  env: NodeJS.ProcessEnv,
  envKey: string,
  fileEnvKey: string,
): Hex | undefined {
  const envValue = env[envKey]?.trim();
  const filePath = env[fileEnvKey]?.trim();

  if (envValue && filePath) {
    throw new Error(`Configure only one of ${envKey} or ${fileEnvKey}`);
  }

  if (envValue) {
    return normalizePrivateKey(envValue, envKey);
  }

  if (filePath) {
    return normalizePrivateKey(readSecretFile(filePath, fileEnvKey), fileEnvKey);
  }

  return undefined;
}

export function loadOptionalStringSecret(
  env: NodeJS.ProcessEnv,
  envKey: string,
  fileEnvKey: string,
): string | undefined {
  const envValue = env[envKey]?.trim();
  const filePath = env[fileEnvKey]?.trim();

  if (envValue && filePath) {
    throw new Error(`Configure only one of ${envKey} or ${fileEnvKey}`);
  }

  if (envValue) {
    return envValue;
  }

  if (filePath) {
    return readSecretFile(filePath, fileEnvKey);
  }

  return undefined;
}

function getKeystorePassword(env: NodeJS.ProcessEnv): string {
  const inlinePassword = env.KEYSTORE_PASSWORD?.trim();
  const passwordFile = env.KEYSTORE_PASSWORD_FILE?.trim();

  if (inlinePassword && passwordFile) {
    throw new Error("Configure only one of KEYSTORE_PASSWORD or KEYSTORE_PASSWORD_FILE");
  }

  if (inlinePassword) return inlinePassword;
  if (passwordFile) return readSecretFile(passwordFile, "KEYSTORE_PASSWORD_FILE");

  throw new Error(
    "One of KEYSTORE_PASSWORD or KEYSTORE_PASSWORD_FILE is required when KEYSTORE_PATH is set",
  );
}

function deriveScryptKey(kdfparams: Record<string, unknown>, password: string): Buffer {
  const salt = String(kdfparams.salt ?? "");
  const dklen = parsePositiveInteger("keystore.kdfparams.dklen", kdfparams.dklen);
  const n = parsePositiveInteger("keystore.kdfparams.n", kdfparams.n);
  const r = parsePositiveInteger("keystore.kdfparams.r", kdfparams.r);
  const p = parsePositiveInteger("keystore.kdfparams.p", kdfparams.p);

  if (!salt) {
    throw new Error("Unsupported keystore: invalid scrypt parameters");
  }

  const estimatedMemoryBytes =
    128n * BigInt(n) * BigInt(r) + 1024n * BigInt(r) * BigInt(p);
  const maxmemLimit = BigInt(SCRYPT_MAXMEM_LIMIT_BYTES);
  if (estimatedMemoryBytes > maxmemLimit) {
    throw new Error("Unsupported keystore: scrypt parameters exceed memory limit");
  }

  const requestedMaxmem = estimatedMemoryBytes + BigInt(SCRYPT_MAXMEM_HEADROOM_BYTES);
  const maxmem = Number(
    requestedMaxmem > maxmemLimit ? maxmemLimit : requestedMaxmem,
  );

  return scryptSync(password, parseHexBytes("keystore.kdfparams.salt", salt), dklen, {
    N: n,
    r,
    p,
    maxmem,
  });
}

function derivePbkdf2Key(kdfparams: Record<string, unknown>, password: string): Buffer {
  const salt = String(kdfparams.salt ?? "");
  const dklen = parsePositiveInteger("keystore.kdfparams.dklen", kdfparams.dklen);
  const iterations = parsePositiveInteger("keystore.kdfparams.c", kdfparams.c);
  const prf = String(kdfparams.prf ?? "");

  if (!salt || !prf) {
    throw new Error("Unsupported keystore: invalid pbkdf2 parameters");
  }

  const digest = prf.startsWith("hmac-") ? prf.slice(5) : prf;
  return pbkdf2Sync(password, parseHexBytes("keystore.kdfparams.salt", salt), iterations, dklen, digest);
}

export function decryptEthereumKeystore(keystoreJson: string, password: string): Hex {
  let parsed: KeystorePayload;
  try {
    parsed = JSON.parse(keystoreJson) as KeystorePayload;
  } catch (error) {
    throw new Error(`KEYSTORE_PATH must contain valid JSON: ${getErrorMessage(error)}`);
  }

  if (parsed.version !== undefined && parsed.version !== 3) {
    throw new Error(`Unsupported keystore version: ${parsed.version}`);
  }

  const crypto = parsed.crypto ?? parsed.Crypto;
  if (!crypto) {
    throw new Error("Unsupported keystore: missing crypto section");
  }

  if (crypto.cipher !== "aes-128-ctr") {
    throw new Error(`Unsupported keystore cipher: ${crypto.cipher ?? "unknown"}`);
  }

  const ciphertext = parseHexBytes("keystore.ciphertext", String(crypto.ciphertext ?? ""));
  const iv = parseHexBytes("keystore.cipherparams.iv", String(crypto.cipherparams?.iv ?? ""));
  const mac = parseHexBytes("keystore.mac", String(crypto.mac ?? ""));
  const kdf = String(crypto.kdf ?? "").toLowerCase();
  const kdfparams = crypto.kdfparams ?? {};

  const derivedKey =
    kdf === "scrypt"
      ? deriveScryptKey(kdfparams, password)
      : kdf === "pbkdf2"
        ? derivePbkdf2Key(kdfparams, password)
        : (() => {
            throw new Error(`Unsupported keystore kdf: ${crypto.kdf ?? "unknown"}`);
          })();

  const computedMac = Buffer.from(keccak256(`0x${Buffer.concat([
    derivedKey.subarray(16, 32),
    ciphertext,
  ]).toString("hex")}`).slice(2), "hex");

  if (computedMac.length !== mac.length || !timingSafeEqual(computedMac, mac)) {
    throw new Error("Invalid keystore password or MAC mismatch");
  }

  const decipher = createDecipheriv("aes-128-ctr", derivedKey.subarray(0, 16), iv);
  const privateKey = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return normalizePrivateKey(`0x${privateKey.toString("hex")}`, "KEYSTORE_PATH");
}

export function resolvePrivateKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Hex {
  const rawPrivateKey = env.PRIVATE_KEY?.trim();
  const privateKeyFile = env.PRIVATE_KEY_FILE?.trim();
  const keystorePath = env.KEYSTORE_PATH?.trim();

  const configuredSources = [rawPrivateKey, privateKeyFile, keystorePath].filter(Boolean);
  if (configuredSources.length === 0) {
    throw new Error("One of PRIVATE_KEY, PRIVATE_KEY_FILE, or KEYSTORE_PATH is required");
  }
  if (configuredSources.length > 1) {
    throw new Error("Configure exactly one of PRIVATE_KEY, PRIVATE_KEY_FILE, or KEYSTORE_PATH");
  }

  if (rawPrivateKey) {
    return normalizePrivateKey(rawPrivateKey, "PRIVATE_KEY");
  }

  if (privateKeyFile) {
    return normalizePrivateKey(readSecretFile(privateKeyFile, "PRIVATE_KEY_FILE"), "PRIVATE_KEY_FILE");
  }

  const keystoreJson = readSecretFile(keystorePath!, "KEYSTORE_PATH");
  return decryptEthereumKeystore(keystoreJson, getKeystorePassword(env));
}

export function generateEphemeralPrivateKey(): Hex {
  return `0x${randomBytes(32).toString("hex")}` as Hex;
}
