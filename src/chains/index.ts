import { type Chain, mainnet, base } from "viem/chains";
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
}

export const MAINNET_CONFIG: ChainConfig = {
  chain: mainnet,
  name: "mainnet",
  ajnaToken: "0x9a96ec9B57Fb64FbC60B423d1f4da7691Bd35079",
  poolFactory: "0x6146dD43c5622BB5a5F51bF4d0f7A3E590A1e3e4",
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
};

export const BASE_CONFIG: ChainConfig = {
  chain: base,
  name: "base",
  // bwAJNA (bridged-wrapped AJNA) on Base
  ajnaToken: "0xf0f326af3b1Ed943ab95C29470730CC8Cf66ae47",
  poolFactory: "0x214f62B5836D83f3D6c4f71F174209097B1A779C",
  poolInfoUtils: "0x97fA9b0909C238DAc430B4A8b563d07a4a120181",
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
};

export const CHAIN_CONFIGS: Record<string, ChainConfig> = {
  mainnet: MAINNET_CONFIG,
  base: BASE_CONFIG,
};
