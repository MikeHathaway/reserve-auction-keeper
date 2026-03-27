import { z } from "zod";
import { readFileSync } from "node:fs";
import { isAddress, type Address, type Hex } from "viem";
import { CHAIN_CONFIGS, buildRpcUrl, type ChainConfig, type RpcProvider } from "./chains/index.js";

const addressSchema = z.string().refine(isAddress, "Invalid Ethereum address");

const chainConfigSchema = z.object({
  enabled: z.boolean().default(true),
  rpcUrl: z.string().url("RPC URL must be a valid URL").optional(),
  privateRpcUrl: z.string().url().optional(),
  pools: z.array(addressSchema).default([]),
});

const configFileSchema = z.object({
  chains: z.object({
    mainnet: chainConfigSchema.optional(),
    base: chainConfigSchema.optional(),
    arbitrum: chainConfigSchema.optional(),
    optimism: chainConfigSchema.optional(),
    polygon: chainConfigSchema.optional(),
  }),
  strategy: z.enum(["funded"]).default("funded"),
  funded: z
    .object({
      targetExitPriceUsd: z.number().positive("Target exit price must be positive"),
      maxTakeAmount: z.string().optional(),
      autoApprove: z.boolean().default(false),
    })
    .optional(),
  polling: z
    .object({
      idleIntervalMs: z.number().int().positive().default(60_000),
      activeIntervalMs: z.number().int().positive().default(10_000),
      profitabilityThreshold: z.number().min(0).max(1).default(0.2),
    })
    .optional(),
  dryRun: z.boolean().default(true),
  profitMarginPercent: z.number().min(0).default(5),
  gasPriceCeilingGwei: z.number().positive().default(100),
  alertWebhookUrl: z.string().url().optional(),
  healthCheckPort: z.number().int().positive().default(8080),
});

export type ConfigFile = z.infer<typeof configFileSchema>;

export interface EnvSecrets {
  privateKey: Hex;
  coingeckoApiKey: string;
  rpcProvider?: RpcProvider;
  rpcApiKey?: string;
  flashbotsAuthKey?: Hex;
}

export interface ResolvedChainConfig {
  chainConfig: ChainConfig;
  rpcUrl: string;
  privateRpcUrl?: string;
  pools: Address[];
}

export interface AppConfig {
  chains: ResolvedChainConfig[];
  strategy: "funded";
  funded: {
    targetExitPriceUsd: number;
    maxTakeAmount?: bigint;
    autoApprove: boolean;
  };
  polling: {
    idleIntervalMs: number;
    activeIntervalMs: number;
    profitabilityThreshold: number;
  };
  dryRun: boolean;
  profitMarginPercent: number;
  gasPriceCeilingGwei: number;
  alertWebhookUrl?: string;
  healthCheckPort: number;
  secrets: EnvSecrets;
}

function loadEnvSecrets(): EnvSecrets {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY is required in .env");
  if (!privateKey.startsWith("0x")) throw new Error("PRIVATE_KEY must start with 0x");

  const coingeckoApiKey = process.env.COINGECKO_API_KEY;
  if (!coingeckoApiKey) throw new Error("COINGECKO_API_KEY is required in .env");

  // RPC provider: set RPC_PROVIDER (alchemy|infura) + RPC_API_KEY
  // and URLs are auto-constructed for all chains.
  const rpcProvider = process.env.RPC_PROVIDER as RpcProvider | undefined;
  const rpcApiKey = process.env.RPC_API_KEY;

  return {
    privateKey: privateKey as Hex,
    coingeckoApiKey,
    rpcProvider,
    rpcApiKey,
    flashbotsAuthKey: process.env.FLASHBOTS_AUTH_KEY as Hex | undefined,
  };
}

export function loadConfig(configPath: string): AppConfig {
  const raw = readFileSync(configPath, "utf-8");
  const parsed = configFileSchema.parse(JSON.parse(raw));
  const secrets = loadEnvSecrets();

  const chains: ResolvedChainConfig[] = [];

  for (const [name, chainFileConfig] of Object.entries(parsed.chains)) {
    if (!chainFileConfig?.enabled) continue;

    const chainConfig = CHAIN_CONFIGS[name];
    if (!chainConfig) throw new Error(`Unknown chain: ${name}`);

    // RPC URL resolution priority:
    // 1. Explicit rpcUrl in config.json (per-chain override)
    // 2. Auto-constructed from RPC_PROVIDER + RPC_API_KEY (one key, all chains)
    // 3. Chain's default public RPC (free, rate-limited)
    const rpcUrl: string =
      chainFileConfig.rpcUrl ||
      (secrets.rpcProvider && secrets.rpcApiKey
        ? buildRpcUrl(chainConfig, secrets.rpcProvider, secrets.rpcApiKey)
        : null) ||
      chainConfig.defaultRpcUrl;

    const privateRpcUrl = chainFileConfig.privateRpcUrl;

    chains.push({
      chainConfig,
      rpcUrl,
      privateRpcUrl,
      pools: (chainFileConfig.pools || []) as Address[],
    });
  }

  if (chains.length === 0) {
    throw new Error("No chains enabled in config. Enable at least one chain.");
  }

  const funded = parsed.funded || { targetExitPriceUsd: 0.1, autoApprove: false };
  const polling = parsed.polling || {
    idleIntervalMs: 60_000,
    activeIntervalMs: 10_000,
    profitabilityThreshold: 0.2,
  };

  return {
    chains,
    strategy: parsed.strategy,
    funded: {
      targetExitPriceUsd: funded.targetExitPriceUsd,
      maxTakeAmount: funded.maxTakeAmount ? BigInt(funded.maxTakeAmount) : undefined,
      autoApprove: funded.autoApprove,
    },
    polling,
    dryRun: parsed.dryRun,
    profitMarginPercent: parsed.profitMarginPercent,
    gasPriceCeilingGwei: parsed.gasPriceCeilingGwei,
    alertWebhookUrl: parsed.alertWebhookUrl,
    healthCheckPort: parsed.healthCheckPort,
    secrets,
  };
}
