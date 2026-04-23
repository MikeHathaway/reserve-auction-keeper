import { formatEther, type Hex, type PublicClient } from "viem";
import { toRawQuoteTokenAmount } from "../auction/math.js";
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
  // Percent gap between the oracle-implied fair output and the DEX quote for
  // the exact `amountInWad` used. Not a price-impact metric and not a function
  // of auction price — it reflects divergence between the USD oracle and the
  // pools on this route. Use for diagnostics, not profitability gating.
  oracleDivergencePercent: number;
}

export interface DexQuoter {
  quoteQuoteToAjna(
    quoteTokenSymbol: string,
    amountInWad: bigint,
    quoteTokenScale: bigint,
    prices: PriceData,
  ): Promise<DexQuote | null>;
}

export interface UniswapV3QuoterConfig {
  quoterAddress: `0x${string}`;
  quoteToAjnaPaths: Record<string, Hex>;
  label: string;
}

export async function quoteUniswapV3Path(
  publicClient: PublicClient,
  quoterAddress: `0x${string}`,
  path: Hex,
  amountInWad: bigint,
  quoteTokenScale: bigint,
  prices: PriceData,
  label: string,
): Promise<DexQuote | null> {
  const amountInRaw = toRawQuoteTokenAmount(amountInWad, quoteTokenScale);
  if (amountInRaw === 0n) {
    logger.debug("Quote amount rounds down to zero raw tokens", {
      label,
      amountInWad: amountInWad.toString(),
      quoteTokenScale: quoteTokenScale.toString(),
    });
    return null;
  }

  try {
    const result = await retryAsync(
      () =>
        publicClient.readContract({
          address: quoterAddress,
          abi: UNISWAP_V3_QUOTER_ABI,
          functionName: "quoteExactInput",
          args: [path, amountInRaw],
        }),
      {
        label,
      },
    );

    const [amountOut, , , gasEstimate] = result as [
      bigint,
      unknown,
      unknown,
      bigint,
    ];

    const quoteAmount = Number(formatEther(amountInWad));
    const idealAmountOut =
      quoteAmount * (prices.quoteTokenPriceUsd / prices.ajnaPriceUsd);
    const actualAmountOut = Number(formatEther(amountOut));
    const oracleDivergencePercent = idealAmountOut > 0
      ? Math.max(0, ((idealAmountOut - actualAmountOut) / idealAmountOut) * 100)
      : 0;

    return {
      amountOut,
      gasEstimate,
      idealAmountOut,
      actualAmountOut,
      oracleDivergencePercent,
    };
  } catch (error) {
    logger.warn("Uniswap V3 quote failed", {
      label,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function createUniswapV3DexQuoter(
  publicClient: PublicClient,
  config: UniswapV3QuoterConfig,
): DexQuoter {
  return {
    async quoteQuoteToAjna(quoteTokenSymbol, amountInWad, quoteTokenScale, prices) {
      const path = config.quoteToAjnaPaths[quoteTokenSymbol];
      if (!path) {
        logger.debug("No Uniswap V3 path configured for quote token", {
          label: config.label,
          quoteTokenSymbol,
        });
        return null;
      }

      return quoteUniswapV3Path(
        publicClient,
        config.quoterAddress,
        path,
        amountInWad,
        quoteTokenScale,
        prices,
        `${config.label}.quoteExactInput.${quoteTokenSymbol}`,
      );
    },
  };
}
