import { z } from "zod";
import { readFileSync } from "node:fs";
import { isAddress, type Address, type Hex } from "viem";
import { CHAIN_CONFIGS, buildRpcUrl, type ChainConfig, type RpcProvider } from "./chains/index.js";
import { logger } from "./utils/logger.js";
import {
  loadOptionalHexSecret,
  loadOptionalStringSecret,
  resolvePrivateKeyFromEnv,
} from "./utils/secrets.js";
import {
  requiresAlchemyPricing,
  requiresCoingeckoPricing,
  type PriceProvider,
} from "./pricing/oracle.js";
import type { CoingeckoApiPlan } from "./pricing/coingecko.js";
import { validateUniswapV3PathEndpoints } from "./utils/uniswap-v3.js";
import { validateUniswapV2PathEndpoints } from "./utils/uniswap-v2.js";

const addressSchema = z.string().refine(isAddress, "Invalid Ethereum address");
const hexSchema = z.string().regex(/^0x[0-9a-fA-F]*$/, "Invalid hex string");
const quoteTokenOverrideSchema = z.object({
  address: addressSchema,
  coingeckoId: z.string().min(1).optional(),
});
const flashArbSourceSchema = z.discriminatedUnion("protocol", [
  z.object({
    protocol: z.literal("uniswap-v2"),
    address: addressSchema,
  }),
  z.object({
    protocol: z.literal("uniswap-v3"),
    address: addressSchema,
  }),
]);
const flashArbSwapRouteSchema = z.discriminatedUnion("protocol", [
  z.object({
    protocol: z.literal("uniswap-v2"),
    path: z.array(addressSchema).min(2, "Uniswap V2 path must contain at least two tokens"),
  }),
  z.object({
    protocol: z.literal("uniswap-v3"),
    path: hexSchema,
  }),
]);
const flashArbExecutorsSchema = z.object({
  v3v3: addressSchema.optional(),
  v2v3: addressSchema.optional(),
  v3v2: addressSchema.optional(),
});
const flashArbRouteSchema = z.object({
  quoterAddress: addressSchema.optional(),
  uniswapV2FactoryAddress: addressSchema.optional(),
  executorAddress: addressSchema.optional(),
  executors: flashArbExecutorsSchema.optional(),
  flashLoanPools: z.record(z.string(), addressSchema).optional(),
  quoteToAjnaPaths: z.record(z.string(), hexSchema).optional(),
  sources: z.record(z.string(), z.array(flashArbSourceSchema).min(1)).optional(),
  swapRoutes: z.record(z.string(), z.array(flashArbSwapRouteSchema).min(1)).optional(),
});

// Per-chain override blocks: same fields as the top-level `flashArb` / `funded`
// blocks, all optional. `.strict()` so typos (e.g., the legacy
// `maxSlippagePercent` key) fail loudly rather than silently falling back to
// the top-level value.
const chainFlashArbOverrideSchema = z
  .object({
    onChainSlippageFloorPercent: z.number().min(0).max(100).optional(),
    minLiquidityUsd: z.number().min(0).optional(),
    minProfitUsd: z.number().min(0).optional(),
  })
  .strict();

// maxTakeAmount is a decimal integer string (parsed via BigInt). Restrict to
// positive integers so `"0"` (BigInt-falsy, silently treated as "no cap" in
// funded.ts), negatives (`"-1"` → negative plans), and non-numeric (`"abc"` →
// BigInt throws at load) all fail cleanly at config parse.
const maxTakeAmountSchema = z
  .string()
  .regex(/^[1-9]\d*$/, "maxTakeAmount must be a positive integer string (wei, no decimals)");

const chainFundedOverrideSchema = z
  .object({
    targetExitPriceUsd: z.number().positive("Target exit price must be positive").optional(),
    maxTakeAmount: maxTakeAmountSchema.optional(),
    autoApprove: z.boolean().optional(),
  })
  .strict();

// Strict throughout: a typo in a per-chain key (e.g. `stratgey` for `strategy`)
// is silently stripped by default-mode zod and falls back to the global default,
// so an operator who thinks they configured mainnet flash-arb would actually
// be running the top-level strategy on both chains. Strict mode makes every
// misspelling a loud parse error at load.
const chainConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    rpcUrl: z.string().url("RPC URL must be a valid URL").optional(),
    privateRpcUrl: z.string().url().optional(),
    privateRpcTrusted: z.boolean().default(false),
    pools: z.array(addressSchema).default([]),
    quoteTokens: z.record(z.string().min(1), quoteTokenOverrideSchema).default({}),
    // Optional per-chain strategy selector. If unset, falls back to the top-
    // level `strategy` field. Lets the operator run, e.g., flash-arb on mainnet
    // and funded on base from a single keeper process.
    strategy: z.enum(["funded", "flash-arb"]).optional(),
    // Optional per-chain overrides that merge on top of the global strategy
    // config. Only the fields you want to vary per chain need to appear.
    flashArb: chainFlashArbOverrideSchema.optional(),
    funded: chainFundedOverrideSchema.optional(),
  })
  .strict();

const configFileSchema = z
  .object({
    chains: z
      .object({
        mainnet: chainConfigSchema.optional(),
        base: chainConfigSchema.optional(),
        arbitrum: chainConfigSchema.optional(),
        optimism: chainConfigSchema.optional(),
        polygon: chainConfigSchema.optional(),
      })
      // Strict so a misspelled chain name (`arbitram`, `avalanche`) throws
      // instead of being silently dropped.
      .strict(),
    pricing: z
      .object({
        provider: z.enum(["coingecko", "alchemy", "hybrid"]).default("coingecko"),
      })
      .optional(),
    strategy: z.enum(["funded", "flash-arb"]).default("funded"),
    funded: z
      .object({
        targetExitPriceUsd: z.number().positive("Target exit price must be positive"),
        maxTakeAmount: maxTakeAmountSchema.optional(),
        autoApprove: z.boolean().default(false),
      })
      // Strict to match the sibling `flashArb` block and per-chain override
      // schemas. Typos like `tatgetExitPriceUsd` would otherwise silently fall
      // back to the default instead of failing loudly at load time.
      .strict()
      .optional(),
    flashArb: z
      .object({
        onChainSlippageFloorPercent: z.number().min(0).max(100).default(1),
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
      // Strict so legacy keys (e.g., the renamed `maxSlippagePercent`) surface
      // as a loud parse error rather than silently falling back to the default.
      .strict()
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
  })
  // Strict at the top level too: a typo'd key (`drrunn`, `strategcy`, misplaced
  // per-chain field at root) throws instead of being silently stripped.
  .strict();

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
  privateRpcTrusted: boolean;
  pools: Address[];
  // Effective strategy for this chain. Per-chain override wins over top-level.
  strategy: "funded" | "flash-arb";
  // Pre-merged strategy configs. Read from these instead of the top-level
  // AppConfig.{flashArb,funded} so per-chain overrides are respected.
  flashArb: {
    onChainSlippageFloorPercent: number;
    minLiquidityUsd: number;
    minProfitUsd: number;
  };
  funded: {
    targetExitPriceUsd: number;
    maxTakeAmount?: bigint;
    autoApprove: boolean;
  };
}

export interface AppConfig {
  chains: ResolvedChainConfig[];
  // Global strategy default. Used only inside `loadConfig` as the fallback
  // when a chain omits its own `strategy` override. Not read at runtime;
  // downstream code reads `ResolvedChainConfig.strategy` per chain instead.
  strategy: "funded" | "flash-arb";
  pricing: {
    provider: PriceProvider;
  };
  // Flash-arb routes live at the top level because they're genuinely global
  // (one route map per chain, not per-strategy). Threshold fields
  // (onChainSlippageFloorPercent, minLiquidityUsd, minProfitUsd) moved to
  // `ResolvedChainConfig.flashArb` — read them from there, not here.
  flashArb: {
    executorAddress?: Address;
    routes: Partial<Record<
      "mainnet" | "base" | "arbitrum" | "optimism" | "polygon",
      NormalizedFlashArbRoute
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

export type FlashArbExecutorFamily = "v3v3" | "v2v3" | "v3v2";

export interface FlashArbSourceV2Config {
  protocol: "uniswap-v2";
  address: Address;
}

export interface FlashArbSourceV3Config {
  protocol: "uniswap-v3";
  address: Address;
}

export type FlashArbSourceConfig = FlashArbSourceV2Config | FlashArbSourceV3Config;

export interface FlashArbSwapRouteV2Config {
  protocol: "uniswap-v2";
  path: Address[];
}

export interface FlashArbSwapRouteV3Config {
  protocol: "uniswap-v3";
  path: Hex;
}

export type FlashArbSwapRouteConfig =
  | FlashArbSwapRouteV2Config
  | FlashArbSwapRouteV3Config;

export interface NormalizedFlashArbRoute {
  quoterAddress?: Address;
  uniswapV2FactoryAddress?: Address;
  executors: Partial<Record<FlashArbExecutorFamily, Address>>;
  sources: Record<string, FlashArbSourceConfig[]>;
  swapRoutes: Record<string, FlashArbSwapRouteConfig[]>;
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function normalizeRecordKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [normalizeSymbol(key), value]),
  );
}

function normalizeFlashArbSources(
  rawSources: Record<string, Array<z.infer<typeof flashArbSourceSchema>>> | undefined,
  legacyFlashLoanPools: Record<string, Address> | undefined,
): Record<string, FlashArbSourceConfig[]> {
  const normalized = new Map<string, FlashArbSourceConfig[]>();

  for (const [rawSymbol, sources] of Object.entries(rawSources || {})) {
    normalized.set(normalizeSymbol(rawSymbol), sources.map((source) => ({
      protocol: source.protocol,
      address: source.address as Address,
    })));
  }

  for (const [rawSymbol, address] of Object.entries(legacyFlashLoanPools || {})) {
    const symbol = normalizeSymbol(rawSymbol);
    const existing = normalized.get(symbol) || [];
    if (!existing.some((source) =>
      source.protocol === "uniswap-v3" &&
      source.address.toLowerCase() === address.toLowerCase()
    )) {
      existing.push({
        protocol: "uniswap-v3",
        address: address as Address,
      });
    }
    normalized.set(symbol, existing);
  }

  return Object.fromEntries(normalized.entries());
}

function normalizeFlashArbSwapRoutes(
  rawSwapRoutes: Record<string, Array<z.infer<typeof flashArbSwapRouteSchema>>> | undefined,
  legacyQuoteToAjnaPaths: Record<string, Hex> | undefined,
): Record<string, FlashArbSwapRouteConfig[]> {
  const normalized = new Map<string, FlashArbSwapRouteConfig[]>();

  for (const [rawSymbol, routes] of Object.entries(rawSwapRoutes || {})) {
    normalized.set(normalizeSymbol(rawSymbol), routes.map((route) =>
      route.protocol === "uniswap-v3"
        ? {
            protocol: "uniswap-v3" as const,
            path: route.path as Hex,
          }
        : {
            protocol: "uniswap-v2" as const,
            path: route.path as Address[],
          }
    ));
  }

  for (const [rawSymbol, path] of Object.entries(legacyQuoteToAjnaPaths || {})) {
    const symbol = normalizeSymbol(rawSymbol);
    const existing = normalized.get(symbol) || [];
    if (!existing.some((route) =>
      route.protocol === "uniswap-v3" &&
      route.path.toLowerCase() === path.toLowerCase()
    )) {
      existing.push({
        protocol: "uniswap-v3",
        path: path as Hex,
      });
    }
    normalized.set(symbol, existing);
  }

  return Object.fromEntries(normalized.entries());
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
  routes: Partial<Record<ChainName, z.infer<typeof flashArbRouteSchema> | undefined>>,
  defaultExecutorAddress?: Address,
): AppConfig["flashArb"]["routes"] {
  const normalizeRoute = (
    route: z.infer<typeof flashArbRouteSchema> | undefined,
  ): NormalizedFlashArbRoute | undefined => {
    if (!route) return undefined;

    const executors: Partial<Record<FlashArbExecutorFamily, Address>> = {
      v3v3: (route.executors?.v3v3 || route.executorAddress || defaultExecutorAddress) as
        | Address
        | undefined,
      v2v3: route.executors?.v2v3 as Address | undefined,
      v3v2: route.executors?.v3v2 as Address | undefined,
    };

    return {
      quoterAddress: route.quoterAddress as Address | undefined,
      uniswapV2FactoryAddress: route.uniswapV2FactoryAddress as Address | undefined,
      executors,
      sources: normalizeFlashArbSources(
        route.sources,
        normalizeRecordKeys(route.flashLoanPools || {}) as Record<string, Address>,
      ),
      swapRoutes: normalizeFlashArbSwapRoutes(
        route.swapRoutes,
        normalizeRecordKeys(route.quoteToAjnaPaths || {}) as Record<string, Hex>,
      ),
    };
  };

  return {
    mainnet: normalizeRoute(routes.mainnet),
    base: normalizeRoute(routes.base),
    arbitrum: normalizeRoute(routes.arbitrum),
    optimism: normalizeRoute(routes.optimism),
    polygon: normalizeRoute(routes.polygon),
  };
}

function validateEnabledFlashArbRoutes(
  chains: ResolvedChainConfig[],
  routes: AppConfig["flashArb"]["routes"],
) {
  const resolveFamily = (
    sourceProtocol: FlashArbSourceConfig["protocol"],
    swapProtocol: FlashArbSwapRouteConfig["protocol"],
  ): FlashArbExecutorFamily | null => {
    if (sourceProtocol === "uniswap-v2" && swapProtocol === "uniswap-v3") return "v2v3";
    if (sourceProtocol === "uniswap-v3" && swapProtocol === "uniswap-v2") return "v3v2";
    if (sourceProtocol === "uniswap-v3" && swapProtocol === "uniswap-v3") return "v3v3";
    return null;
  };

  for (const resolved of chains) {
    const chainName = resolved.chainConfig.name as ChainName;
    const route = routes[chainName];
    if (!route) continue;

      const symbols = new Set([
      ...Object.keys(route.sources),
      ...Object.keys(route.swapRoutes),
    ]);

    for (const symbol of symbols) {
      const quoteToken = resolved.chainConfig.quoteTokens[symbol];
      if (!quoteToken) {
        throw new Error(
          `flashArb.routes.${chainName} references unsupported quote token symbol ${symbol}`,
        );
      }

      const sources = route.sources[symbol];
      if (!sources || sources.length === 0) {
        throw new Error(
          `flashArb.routes.${chainName}.sources.${symbol} is required when a swap route is configured`,
        );
      }

      const swapRoutes = route.swapRoutes[symbol];
      if (!swapRoutes || swapRoutes.length === 0) {
        throw new Error(
          `flashArb.routes.${chainName}.swapRoutes.${symbol} is required when a flash source is configured`,
        );
      }

      for (const swapRoute of swapRoutes) {
        if (swapRoute.protocol === "uniswap-v3") {
          if (!route.quoterAddress) {
            throw new Error(
              `flashArb.routes.${chainName}.quoterAddress is required when ${symbol} uses a Uniswap V3 swap route`,
            );
          }

          const pathError = validateUniswapV3PathEndpoints(
            swapRoute.path,
            quoteToken,
            resolved.chainConfig.ajnaToken,
          );
          if (pathError) {
            throw new Error(
              `flashArb.routes.${chainName}.swapRoutes.${symbol} must encode a ${symbol} -> AJNA route: ${pathError}`,
            );
          }
          continue;
        }

        if (!route.uniswapV2FactoryAddress) {
          throw new Error(
            `flashArb.routes.${chainName}.uniswapV2FactoryAddress is required when ${symbol} uses a Uniswap V2 swap route`,
          );
        }

        const pathError = validateUniswapV2PathEndpoints(
          swapRoute.path,
          quoteToken,
          resolved.chainConfig.ajnaToken,
        );
        if (pathError) {
          throw new Error(
            `flashArb.routes.${chainName}.swapRoutes.${symbol} must encode a ${symbol} -> AJNA route: ${pathError}`,
          );
        }
      }

      const hasExecutableFamily = sources.some((source) =>
        swapRoutes.some((swapRoute) => {
          const family = resolveFamily(source.protocol, swapRoute.protocol);
          return family != null && route.executors[family] != null;
        })
      );
      if (!hasExecutableFamily) {
        throw new Error(
          `flashArb.routes.${chainName}.${symbol} does not define any executable source/swap family with a configured executor`,
        );
      }
    }
  }
}

function loadEnvSecrets(priceProvider: PriceProvider): EnvSecrets {
  // RPC provider: set RPC_PROVIDER (alchemy|infura) + RPC_API_KEY / RPC_API_KEY_FILE
  // and URLs are auto-constructed for all chains.
  const rpcProvider = process.env.RPC_PROVIDER as RpcProvider | undefined;
  const rpcApiKey = loadOptionalStringSecret(
    process.env,
    "RPC_API_KEY",
    "RPC_API_KEY_FILE",
  );
  const coingeckoApiKey = loadOptionalStringSecret(
    process.env,
    "COINGECKO_API_KEY",
    "COINGECKO_API_KEY_FILE",
  );
  const coingeckoApiPlan = (process.env.COINGECKO_API_PLAN ?? "auto") as CoingeckoApiPlan;
  const alchemyApiKey = loadOptionalStringSecret(
    process.env,
    "ALCHEMY_API_KEY",
    "ALCHEMY_API_KEY_FILE",
  ) ||
    (rpcProvider === "alchemy" ? rpcApiKey : undefined);

  if (!["auto", "demo", "pro"].includes(coingeckoApiPlan)) {
    throw new Error("COINGECKO_API_PLAN must be one of: auto, demo, pro");
  }

  if (requiresCoingeckoPricing(priceProvider) && !coingeckoApiKey) {
    throw new Error(
      "COINGECKO_API_KEY or COINGECKO_API_KEY_FILE is required for the selected pricing provider",
    );
  }

  if (requiresAlchemyPricing(priceProvider) && !alchemyApiKey) {
    throw new Error(
      "ALCHEMY_API_KEY or ALCHEMY_API_KEY_FILE is required for the selected pricing provider unless RPC_PROVIDER=alchemy with RPC_API_KEY or RPC_API_KEY_FILE set",
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

  // Resolve top-level strategy config FIRST so per-chain overrides can merge
  // onto fully-defaulted values.
  const fundedGlobal = parsed.funded
    ? {
        targetExitPriceUsd: parsed.funded.targetExitPriceUsd,
        maxTakeAmount: parsed.funded.maxTakeAmount
          ? BigInt(parsed.funded.maxTakeAmount)
          : undefined,
        autoApprove: parsed.funded.autoApprove,
      }
    : { targetExitPriceUsd: 0.1, maxTakeAmount: undefined, autoApprove: false };
  const flashArbGlobal = {
    onChainSlippageFloorPercent: parsed.flashArb?.onChainSlippageFloorPercent ?? 1,
    minLiquidityUsd: parsed.flashArb?.minLiquidityUsd ?? 100,
    minProfitUsd: parsed.flashArb?.minProfitUsd ?? 0,
  };

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
    // 2. Auto-constructed from RPC_PROVIDER + RPC_API_KEY / RPC_API_KEY_FILE (one key, all chains)
    // 3. Chain's default public RPC (free, rate-limited)
    const rpcUrl: string =
      chainFileConfig.rpcUrl ||
      (secrets.rpcProvider && secrets.rpcApiKey
        ? buildRpcUrl(resolvedChainConfig, secrets.rpcProvider, secrets.rpcApiKey)
        : null) ||
      resolvedChainConfig.defaultRpcUrl;

    const privateRpcUrl = chainFileConfig.privateRpcUrl;

    const strategy = chainFileConfig.strategy ?? parsed.strategy;
    const chainFlashArb = {
      onChainSlippageFloorPercent:
        chainFileConfig.flashArb?.onChainSlippageFloorPercent
          ?? flashArbGlobal.onChainSlippageFloorPercent,
      minLiquidityUsd:
        chainFileConfig.flashArb?.minLiquidityUsd ?? flashArbGlobal.minLiquidityUsd,
      minProfitUsd:
        chainFileConfig.flashArb?.minProfitUsd ?? flashArbGlobal.minProfitUsd,
    };
    const chainFunded = {
      targetExitPriceUsd:
        chainFileConfig.funded?.targetExitPriceUsd ?? fundedGlobal.targetExitPriceUsd,
      maxTakeAmount: chainFileConfig.funded?.maxTakeAmount
        ? BigInt(chainFileConfig.funded.maxTakeAmount)
        : fundedGlobal.maxTakeAmount,
      autoApprove: chainFileConfig.funded?.autoApprove ?? fundedGlobal.autoApprove,
    };

    // Dead-config warning: override block exists for a strategy this chain
    // isn't using. Likely a forgotten stale config after a strategy flip; warn
    // instead of rejecting so operators can flip back without editing both.
    if (strategy === "funded" && chainFileConfig.flashArb) {
      logger.warn(
        `chains.${name}.flashArb overrides present but strategy is "funded" — the overrides will be ignored.`,
      );
    }
    if (strategy === "flash-arb" && chainFileConfig.funded) {
      logger.warn(
        `chains.${name}.funded overrides present but strategy is "flash-arb" — the overrides will be ignored.`,
      );
    }

    chains.push({
      chainConfig: resolvedChainConfig,
      rpcUrl,
      privateRpcUrl,
      privateRpcTrusted: chainFileConfig.privateRpcTrusted ?? false,
      pools: (chainFileConfig.pools || []) as Address[],
      strategy,
      flashArb: chainFlashArb,
      funded: chainFunded,
    });
  }

  if (chains.length === 0) {
    throw new Error("No chains enabled in config. Enable at least one chain.");
  }

  const polling = parsed.polling || {
    idleIntervalMs: 60_000,
    activeIntervalMs: 10_000,
    profitabilityThreshold: 0.2,
  };
  const flashArbRoutes = normalizeFlashArbRouteMaps({
    mainnet: parsed.flashArb?.routes?.mainnet,
    base: parsed.flashArb?.routes?.base,
    arbitrum: parsed.flashArb?.routes?.arbitrum,
    optimism: parsed.flashArb?.routes?.optimism,
    polygon: parsed.flashArb?.routes?.polygon,
  }, parsed.flashArb?.executorAddress as Address | undefined);
  // Validate routes only for chains whose resolved strategy is flash-arb. A
  // chain running funded can leave its flashArb route empty.
  const flashArbChains = chains.filter((c) => c.strategy === "flash-arb");
  if (flashArbChains.length > 0) {
    validateEnabledFlashArbRoutes(flashArbChains, flashArbRoutes);
  }

  // Dead-config warning for stale top-level routes: if `flashArb.routes.<chain>`
  // exists for a chain that resolved to `funded`, the route is never read. Most
  // common cause is flipping a chain from flash-arb to funded without cleaning
  // up the route block. Warn instead of rejecting so operators can flip back
  // without also having to re-paste the route.
  for (const chain of chains) {
    if (chain.strategy !== "funded") continue;
    const chainName = chain.chainConfig.name as ChainName;
    if (flashArbRoutes[chainName]) {
      logger.warn(
        `flashArb.routes.${chainName} is configured but chains.${chainName}.strategy resolves to "funded" — the route will be ignored by the selected strategy.`,
      );
    }
  }

  return {
    chains,
    strategy: parsed.strategy,
    pricing,
    flashArb: {
      executorAddress: parsed.flashArb?.executorAddress as Address | undefined,
      routes: flashArbRoutes,
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
