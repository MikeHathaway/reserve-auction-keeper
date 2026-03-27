import { type Chain, mainnet, base, arbitrum, optimism, polygon } from "viem/chains";
import type { Address } from "viem";

export interface ChainConfig {
  chain: Chain;
  name: string;
  ajnaToken: Address;
  poolFactory: Address;
  poolInfoUtils: Address;
  /** Supported quote tokens: symbol → address */
  quoteTokens: Record<string, Address>;
  /** Coingecko IDs for price lookups */
  coingeckoIds: {
    ajna: string;
    quoteTokens: Record<string, string>;
  };
  /** MEV submission method */
  mevMethod: "flashbots" | "private-rpc";
  /** Average gas cost in USD for profitability estimates */
  estimatedGasCostUsd: number;
  /** Default public RPC (used if no provider key or explicit URL given) */
  defaultRpcUrl: string;
  /** Alchemy network slug for auto-constructing RPC URLs */
  alchemySlug?: string;
  /** Infura network slug for auto-constructing RPC URLs */
  infuraSlug?: string;
}

export type RpcProvider = "alchemy" | "infura";

/**
 * Build an RPC URL from a provider API key and chain config.
 */
export function buildRpcUrl(
  chainConfig: ChainConfig,
  provider: RpcProvider,
  apiKey: string,
): string | null {
  if (provider === "alchemy" && chainConfig.alchemySlug) {
    return `https://${chainConfig.alchemySlug}.g.alchemy.com/v2/${apiKey}`;
  }
  if (provider === "infura" && chainConfig.infuraSlug) {
    return `https://${chainConfig.infuraSlug}.infura.io/v3/${apiKey}`;
  }
  return null;
}

export const MAINNET_CONFIG: ChainConfig = {
  chain: mainnet,
  name: "mainnet",
  ajnaToken: "0x9a96ec9B57Fb64FbC60B423d1f4da7691Bd35079",
  poolFactory: "0x6146DD43C5622bB6D12A5240ab9CF4de14eDC625",
  poolInfoUtils: "0x30c5eF2997d6a882DE52c4ec01B6D0a5e5B4fAAE",
  quoteTokens: {
    WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  },
  coingeckoIds: {
    ajna: "ajna-protocol",
    quoteTokens: {
      WETH: "weth",
      USDC: "usd-coin",
      DAI: "dai",
    },
  },
  mevMethod: "flashbots",
  estimatedGasCostUsd: 5.0,
  defaultRpcUrl: "https://eth.llamarpc.com",
  alchemySlug: "eth-mainnet",
  infuraSlug: "mainnet",
};

export const BASE_CONFIG: ChainConfig = {
  chain: base,
  name: "base",
  // bwAJNA (bridged-wrapped AJNA) on Base
  ajnaToken: "0xf0f326af3b1Ed943ab95C29470730CC8Cf66ae47",
  poolFactory: "0x214f62B5836D83f3D6c4f71F174209097B1A779C",
  poolInfoUtils: "0x97fa9b0909C238D170C1ab3B5c728A3a45BBEcBa",
  quoteTokens: {
    WETH: "0x4200000000000000000000000000000000000006",
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
  },
  coingeckoIds: {
    ajna: "ajna-protocol",
    quoteTokens: {
      WETH: "weth",
      USDC: "usd-coin",
      DAI: "dai",
    },
  },
  mevMethod: "private-rpc",
  estimatedGasCostUsd: 0.02,
  defaultRpcUrl: "https://base.llamarpc.com",
  alchemySlug: "base-mainnet",
  infuraSlug: undefined,
};

export const ARBITRUM_CONFIG: ChainConfig = {
  chain: arbitrum,
  name: "arbitrum",
  // bwAJNA on Arbitrum
  ajnaToken: "0xA98c94d67D9dF259Bee2E7b519dF75aB00E3E2A8",
  poolFactory: "0xA3A1e968Bd6C578205E11256c8e6929f21742aAF",
  poolInfoUtils: "0x8a7F5aFb7E3c3fD1f3Cc9D874b454b6De11EBbC9",
  quoteTokens: {
    WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    DAI: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
  },
  coingeckoIds: {
    ajna: "ajna-protocol",
    quoteTokens: {
      WETH: "weth",
      USDC: "usd-coin",
      DAI: "dai",
    },
  },
  mevMethod: "private-rpc",
  estimatedGasCostUsd: 0.02,
  defaultRpcUrl: "https://arb1.arbitrum.io/rpc",
  alchemySlug: "arb-mainnet",
  infuraSlug: "arbitrum-mainnet",
};

export const OPTIMISM_CONFIG: ChainConfig = {
  chain: optimism,
  name: "optimism",
  // bwAJNA on Optimism
  ajnaToken: "0x6c518f9D1a163379235816c543E62922a79863Fa",
  poolFactory: "0x609C4e8804fafC07c96bE81A8a98d0AdCf2b7Dfa",
  poolInfoUtils: "0xdE6C8171b5b971F71C405631f4e0568ed8491aaC",
  quoteTokens: {
    WETH: "0x4200000000000000000000000000000000000006",
    USDC: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    DAI: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
  },
  coingeckoIds: {
    ajna: "ajna-protocol",
    quoteTokens: {
      WETH: "weth",
      USDC: "usd-coin",
      DAI: "dai",
    },
  },
  mevMethod: "private-rpc",
  estimatedGasCostUsd: 0.01,
  defaultRpcUrl: "https://mainnet.optimism.io",
  alchemySlug: "opt-mainnet",
  infuraSlug: "optimism-mainnet",
};

export const POLYGON_CONFIG: ChainConfig = {
  chain: polygon,
  name: "polygon",
  // bwAJNA on Polygon
  ajnaToken: "0xA63b19647787Da652D0826424460D1BBf43Bf9c6",
  poolFactory: "0x1f172F881eBa06Aa7a991651780527C173783Cf6",
  poolInfoUtils: "0x519021054846cd3D9883359B593B5ED3058Fbe9f",
  quoteTokens: {
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    USDC: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  },
  coingeckoIds: {
    ajna: "ajna-protocol",
    quoteTokens: {
      WMATIC: "wmatic",
      USDC: "usd-coin",
      DAI: "dai",
    },
  },
  mevMethod: "private-rpc",
  estimatedGasCostUsd: 0.01,
  defaultRpcUrl: "https://polygon-rpc.com",
  alchemySlug: "polygon-mainnet",
  infuraSlug: "polygon-mainnet",
};

export const CHAIN_CONFIGS: Record<string, ChainConfig> = {
  mainnet: MAINNET_CONFIG,
  base: BASE_CONFIG,
  arbitrum: ARBITRUM_CONFIG,
  optimism: OPTIMISM_CONFIG,
  polygon: POLYGON_CONFIG,
};
