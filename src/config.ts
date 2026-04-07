import { z } from "zod";
import { readFileSync } from "node:fs";
import { isAddress, type Address, type Hex } from "viem";
import { CHAIN_CONFIGS, buildRpcUrl, type ChainConfig, type RpcProvider } from "./chains/index.js";
import { loadOptionalHexSecret, resolvePrivateKeyFromEnv } from "./utils/secrets.js";
import {
  requiresAlchemyPricing,
  requiresCoingeckoPricing,
  type PriceProvider,
} from "./pricing/oracle.js";
import type { CoingeckoApiPlan } from "./pricing/coingecko.js";

const addressSchema = z.string().refine(isAddress, "Invalid Ethereum address");
const hexSchema = z.string().regex(/^0x[0-9a-fA-F]*$/, "Invalid hex string");
const quoteTokenOverrideSchema = z.object({
  address: addressSchema,
  coingeckoId: z.string().min(1).optional(),
});
const flashArbRouteSchema = z.object({
  quoterAddress: addressSchema,
  executorAddress: addressSchema.optional(),
  flashLoanPools: z.record(z.string(), addressSchema),
  quoteToAjnaPaths: z.record(z.string(), hexSchema),
});

const chainConfigSchema = z.object({
  enabled: z.boolean().default(true),
  rpcUrl: z.string().url("RPC URL must be a valid URL").optional(),
  privateRpcUrl: z.string().url().optional(),
  pools: z.array(addressSchema).default([]),
  quoteTokens: z.record(z.string().min(1), quoteTokenOverrideSchema).default({}),
});

const configFileSchema = z.object({
  chains: z.object({
    mainnet: chainConfigSchema.optional(),
    base: chainConfigSchema.optional(),
    arbitrum: chainConfigSchema.optional(),
    optimism: chainConfigSchema.optional(),
    polygon: chainConfigSchema.optional(),
  }),
  pricing: z
    .object({
      provider: z.enum(["coingecko", "alchemy", "hybrid"]).default("coingecko"),
    })
    .optional(),
  strategy: z.enum(["funded", "flash-arb"]).default("funded"),
  funded: z
    .object({
      targetExitPriceUsd: z.number().positive("Target exit price must be positive"),
      maxTakeAmount: z.string().optional(),
      autoApprove: z.boolean().default(false),
    })
    .optional(),
  flashArb: z
    .object({
      maxSlippagePercent: z.number().min(0).max(100).default(1),
      minLiquidityUsd: z.number().min(0).default(100),
      minProfitUsd: z.number().min(0).default(0),
      executorAddress: addressSchema.optional(),
      routes: z
        .object({
          mainnet: flashArbRouteSchema.optional(),
          base: flashArbRouteSchema.optional(),
          arbitrum: flashArbRouteSchema.optional(),
          optimism: flashArbRouteSchema.optional(),
          polygon: flashArbRouteSchema.optional(),
        })
        .optional(),
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
  coingeckoApiKey?: string;
  coingeckoApiPlan: CoingeckoApiPlan;
  alchemyApiKey?: string;
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
  strategy: "funded" | "flash-arb";
  pricing: {
    provider: PriceProvider;
  };
  funded: {
    targetExitPriceUsd: number;
    maxTakeAmount?: bigint;
    autoApprove: boolean;
  };
  flashArb: {
    maxSlippagePercent: number;
    minLiquidityUsd: number;
    minProfitUsd: number;
    executorAddress?: Address;
    routes: Partial<Record<
      "mainnet" | "base" | "arbitrum" | "optimism" | "polygon",
      {
        quoterAddress: Address;
        executorAddress?: Address;
        flashLoanPools: Record<string, Address>;
        quoteToAjnaPaths: Record<string, Hex>;
      }
    >>;
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

type ChainName = "mainnet" | "base" | "arbitrum" | "optimism" | "polygon";

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function normalizeRecordKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [normalizeSymbol(key), value]),
  );
}

function mergeChainConfig(
  chainName: ChainName,
  baseChainConfig: ChainConfig,
  chainFileConfig: ConfigFile["chains"][ChainName],
  priceProvider: PriceProvider,
): ChainConfig {
  if (!chainFileConfig) {
    return baseChainConfig;
  }

  const mergedQuoteTokens = { ...baseChainConfig.quoteTokens };
  const mergedCoingeckoIds = { ...baseChainConfig.coingeckoIds.quoteTokens };

  for (const [rawSymbol, override] of Object.entries(chainFileConfig.quoteTokens)) {
    const symbol = normalizeSymbol(rawSymbol);
    const previousAddress = mergedQuoteTokens[symbol]?.toLowerCase();
    const nextAddress = override.address.toLowerCase();
    const isAddressOverride = previousAddress !== undefined && previousAddress !== nextAddress;
    mergedQuoteTokens[symbol] = override.address as Address;

    if (override.coingeckoId) {
      mergedCoingeckoIds[symbol] = override.coingeckoId;
      continue;
    }

    if (isAddressOverride) {
      delete mergedCoingeckoIds[symbol];
    }

    if (!mergedCoingeckoIds[symbol] && requiresCoingeckoPricing(priceProvider)) {
      throw new Error(
        `chains.${chainName}.quoteTokens.${rawSymbol}.coingeckoId is required for the selected pricing provider`,
      );
    }
  }

  return {
    ...baseChainConfig,
    quoteTokens: normalizeRecordKeys(mergedQuoteTokens),
    coingeckoIds: {
      ...baseChainConfig.coingeckoIds,
      quoteTokens: normalizeRecordKeys(mergedCoingeckoIds),
    },
  };
}

function normalizeFlashArbRouteMaps(
  routes: AppConfig["flashArb"]["routes"],
): AppConfig["flashArb"]["routes"] {
  return {
    mainnet: routes.mainnet
      ? {
          ...routes.mainnet,
          flashLoanPools: normalizeRecordKeys(routes.mainnet.flashLoanPools),
          quoteToAjnaPaths: normalizeRecordKeys(routes.mainnet.quoteToAjnaPaths),
        }
      : undefined,
    base: routes.base
      ? {
          ...routes.base,
          flashLoanPools: normalizeRecordKeys(routes.base.flashLoanPools),
          quoteToAjnaPaths: normalizeRecordKeys(routes.base.quoteToAjnaPaths),
        }
      : undefined,
    arbitrum: routes.arbitrum
      ? {
          ...routes.arbitrum,
          flashLoanPools: normalizeRecordKeys(routes.arbitrum.flashLoanPools),
          quoteToAjnaPaths: normalizeRecordKeys(routes.arbitrum.quoteToAjnaPaths),
        }
      : undefined,
    optimism: routes.optimism
      ? {
          ...routes.optimism,
          flashLoanPools: normalizeRecordKeys(routes.optimism.flashLoanPools),
          quoteToAjnaPaths: normalizeRecordKeys(routes.optimism.quoteToAjnaPaths),
        }
      : undefined,
    polygon: routes.polygon
      ? {
          ...routes.polygon,
          flashLoanPools: normalizeRecordKeys(routes.polygon.flashLoanPools),
          quoteToAjnaPaths: normalizeRecordKeys(routes.polygon.quoteToAjnaPaths),
        }
      : undefined,
  };
}

function loadEnvSecrets(priceProvider: PriceProvider): EnvSecrets {
  // RPC provider: set RPC_PROVIDER (alchemy|infura) + RPC_API_KEY
  // and URLs are auto-constructed for all chains.
  const rpcProvider = process.env.RPC_PROVIDER as RpcProvider | undefined;
  const rpcApiKey = process.env.RPC_API_KEY;
  const coingeckoApiKey = process.env.COINGECKO_API_KEY;
  const coingeckoApiPlan = (process.env.COINGECKO_API_PLAN ?? "auto") as CoingeckoApiPlan;
  const alchemyApiKey = process.env.ALCHEMY_API_KEY ||
    (rpcProvider === "alchemy" ? rpcApiKey : undefined);

  if (!["auto", "demo", "pro"].includes(coingeckoApiPlan)) {
    throw new Error("COINGECKO_API_PLAN must be one of: auto, demo, pro");
  }

  if (requiresCoingeckoPricing(priceProvider) && !coingeckoApiKey) {
    throw new Error("COINGECKO_API_KEY is required for the selected pricing provider");
  }

  if (requiresAlchemyPricing(priceProvider) && !alchemyApiKey) {
    throw new Error(
      "ALCHEMY_API_KEY is required for the selected pricing provider unless RPC_PROVIDER=alchemy with RPC_API_KEY set",
    );
  }

  return {
    privateKey: resolvePrivateKeyFromEnv(process.env),
    coingeckoApiKey,
    coingeckoApiPlan,
    alchemyApiKey,
    rpcProvider,
    rpcApiKey,
    flashbotsAuthKey: loadOptionalHexSecret(
      process.env,
      "FLASHBOTS_AUTH_KEY",
      "FLASHBOTS_AUTH_KEY_FILE",
    ),
  };
}

export function loadConfig(configPath: string): AppConfig {
  const raw = readFileSync(configPath, "utf-8");
  const parsed = configFileSchema.parse(JSON.parse(raw));
  const pricing = { provider: (parsed.pricing?.provider ?? "coingecko") as PriceProvider };
  const secrets = loadEnvSecrets(pricing.provider);

  const chains: ResolvedChainConfig[] = [];

  for (const [name, chainFileConfig] of Object.entries(parsed.chains) as Array<
    [ChainName, ConfigFile["chains"][ChainName]]
  >) {
    if (!chainFileConfig?.enabled) continue;

    const chainConfig = CHAIN_CONFIGS[name];
    if (!chainConfig) throw new Error(`Unknown chain: ${name}`);
    const resolvedChainConfig = mergeChainConfig(name, chainConfig, chainFileConfig, pricing.provider);

    // RPC URL resolution priority:
    // 1. Explicit rpcUrl in config.json (per-chain override)
    // 2. Auto-constructed from RPC_PROVIDER + RPC_API_KEY (one key, all chains)
    // 3. Chain's default public RPC (free, rate-limited)
    const rpcUrl: string =
      chainFileConfig.rpcUrl ||
      (secrets.rpcProvider && secrets.rpcApiKey
        ? buildRpcUrl(resolvedChainConfig, secrets.rpcProvider, secrets.rpcApiKey)
        : null) ||
      resolvedChainConfig.defaultRpcUrl;

    const privateRpcUrl = chainFileConfig.privateRpcUrl;

    chains.push({
      chainConfig: resolvedChainConfig,
      rpcUrl,
      privateRpcUrl,
      pools: (chainFileConfig.pools || []) as Address[],
    });
  }

  if (chains.length === 0) {
    throw new Error("No chains enabled in config. Enable at least one chain.");
  }

  const funded = parsed.funded || { targetExitPriceUsd: 0.1, autoApprove: false };
  const flashArb = parsed.flashArb || {
    maxSlippagePercent: 1,
    minLiquidityUsd: 100,
    minProfitUsd: 0,
    routes: {},
  };
  const polling = parsed.polling || {
    idleIntervalMs: 60_000,
    activeIntervalMs: 10_000,
    profitabilityThreshold: 0.2,
  };

  return {
    chains,
    strategy: parsed.strategy,
    pricing,
    funded: {
      targetExitPriceUsd: funded.targetExitPriceUsd,
      maxTakeAmount: funded.maxTakeAmount ? BigInt(funded.maxTakeAmount) : undefined,
      autoApprove: funded.autoApprove,
    },
    flashArb: {
      maxSlippagePercent: flashArb.maxSlippagePercent,
      minLiquidityUsd: flashArb.minLiquidityUsd,
      minProfitUsd: flashArb.minProfitUsd,
      executorAddress: flashArb.executorAddress as Address | undefined,
      routes: normalizeFlashArbRouteMaps({
        mainnet: flashArb.routes?.mainnet
          ? {
              quoterAddress: flashArb.routes.mainnet.quoterAddress as Address,
              executorAddress: flashArb.routes.mainnet.executorAddress as Address | undefined,
              flashLoanPools: flashArb.routes.mainnet.flashLoanPools as Record<string, Address>,
              quoteToAjnaPaths: flashArb.routes.mainnet.quoteToAjnaPaths as Record<string, Hex>,
            }
          : undefined,
        base: flashArb.routes?.base
          ? {
              quoterAddress: flashArb.routes.base.quoterAddress as Address,
              executorAddress: flashArb.routes.base.executorAddress as Address | undefined,
              flashLoanPools: flashArb.routes.base.flashLoanPools as Record<string, Address>,
              quoteToAjnaPaths: flashArb.routes.base.quoteToAjnaPaths as Record<string, Hex>,
            }
          : undefined,
        arbitrum: flashArb.routes?.arbitrum
          ? {
              quoterAddress: flashArb.routes.arbitrum.quoterAddress as Address,
              executorAddress: flashArb.routes.arbitrum.executorAddress as Address | undefined,
              flashLoanPools: flashArb.routes.arbitrum.flashLoanPools as Record<string, Address>,
              quoteToAjnaPaths: flashArb.routes.arbitrum.quoteToAjnaPaths as Record<string, Hex>,
            }
          : undefined,
        optimism: flashArb.routes?.optimism
          ? {
              quoterAddress: flashArb.routes.optimism.quoterAddress as Address,
              executorAddress: flashArb.routes.optimism.executorAddress as Address | undefined,
              flashLoanPools: flashArb.routes.optimism.flashLoanPools as Record<string, Address>,
              quoteToAjnaPaths: flashArb.routes.optimism.quoteToAjnaPaths as Record<string, Hex>,
            }
          : undefined,
        polygon: flashArb.routes?.polygon
          ? {
              quoterAddress: flashArb.routes.polygon.quoterAddress as Address,
              executorAddress: flashArb.routes.polygon.executorAddress as Address | undefined,
              flashLoanPools: flashArb.routes.polygon.flashLoanPools as Record<string, Address>,
              quoteToAjnaPaths: flashArb.routes.polygon.quoteToAjnaPaths as Record<string, Hex>,
            }
          : undefined,
      }),
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
