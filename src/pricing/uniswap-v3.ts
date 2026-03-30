import { formatEther, type Hex, type PublicClient } from "viem";
import { logger } from "../utils/logger.js";
import { retryAsync } from "../utils/retry.js";
import type { PriceData } from "./oracle.js";

const UNISWAP_V3_QUOTER_ABI = [
  {
    inputs: [
      { name: "path", type: "bytes" },
      { name: "amountIn", type: "uint256" },
    ],
    name: "quoteExactInput",
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96AfterList", type: "uint160[]" },
      { name: "initializedTicksCrossedList", type: "uint32[]" },
      { name: "gasEstimate", type: "uint256" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

export interface DexQuote {
  amountOut: bigint;
  gasEstimate: bigint;
  idealAmountOut: number;
  actualAmountOut: number;
  slippagePercent: number;
}

export interface DexQuoter {
  quoteQuoteToAjna(
    quoteTokenSymbol: string,
    amountIn: bigint,
    prices: PriceData,
  ): Promise<DexQuote | null>;
}

export interface UniswapV3QuoterConfig {
  quoterAddress: `0x${string}`;
  quoteToAjnaPaths: Record<string, Hex>;
  label: string;
}

export function createUniswapV3DexQuoter(
  publicClient: PublicClient,
  config: UniswapV3QuoterConfig,
): DexQuoter {
  return {
    async quoteQuoteToAjna(quoteTokenSymbol, amountIn, prices) {
      const path = config.quoteToAjnaPaths[quoteTokenSymbol];
      if (!path) {
        logger.debug("No Uniswap V3 path configured for quote token", {
          label: config.label,
          quoteTokenSymbol,
        });
        return null;
      }

      try {
        const result = await retryAsync(
          () =>
            publicClient.readContract({
              address: config.quoterAddress,
              abi: UNISWAP_V3_QUOTER_ABI,
              functionName: "quoteExactInput",
              args: [path, amountIn],
            }),
          {
            label: `${config.label}.quoteExactInput.${quoteTokenSymbol}`,
          },
        );

        const [amountOut, , , gasEstimate] = result as [
          bigint,
          unknown,
          unknown,
          bigint,
        ];

        const quoteAmount = Number(formatEther(amountIn));
        const idealAmountOut =
          quoteAmount * (prices.quoteTokenPriceUsd / prices.ajnaPriceUsd);
        const actualAmountOut = Number(formatEther(amountOut));
        const slippagePercent = idealAmountOut > 0
          ? Math.max(0, ((idealAmountOut - actualAmountOut) / idealAmountOut) * 100)
          : 0;

        return {
          amountOut,
          gasEstimate,
          idealAmountOut,
          actualAmountOut,
          slippagePercent,
        };
      } catch (error) {
        logger.warn("Uniswap V3 quote failed", {
          label: config.label,
          quoteTokenSymbol,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
  };
}
