import { formatEther, type Address, type PublicClient } from "viem";
import { toRawQuoteTokenAmount } from "../auction/math.js";
import { logger } from "../utils/logger.js";
import {
  calculateUniswapV2AmountOut,
  getUniswapV2PairAddress,
  getUniswapV2PairReserveForToken,
  readUniswapV2PairState,
} from "../utils/uniswap-v2.js";
import type { PriceData } from "./oracle.js";
import type { DexQuote } from "./uniswap-v3.js";

export interface UniswapV2QuoterConfig {
  factoryAddress: Address;
  label: string;
}

export async function quoteUniswapV2Path(
  publicClient: PublicClient,
  config: UniswapV2QuoterConfig,
  path: readonly Address[],
  amountInWad: bigint,
  quoteTokenScale: bigint,
  prices: PriceData,
): Promise<DexQuote | null> {
  const amountInRaw = toRawQuoteTokenAmount(amountInWad, quoteTokenScale);
  if (amountInRaw === 0n) {
    logger.debug("Quote amount rounds down to zero raw tokens", {
      label: config.label,
      path,
      amountInWad: amountInWad.toString(),
      quoteTokenScale: quoteTokenScale.toString(),
    });
    return null;
  }

  let amountOut = amountInRaw;
  for (let i = 0; i < path.length - 1; i += 1) {
    const tokenIn = path[i];
    const tokenOut = path[i + 1];
    const pairAddress = await getUniswapV2PairAddress(
      publicClient,
      config.factoryAddress,
      tokenIn,
      tokenOut,
    );
    if (!pairAddress) {
      logger.debug("No Uniswap V2 pair configured for route hop", {
        label: config.label,
        tokenIn,
        tokenOut,
      });
      return null;
    }

    const pairState = await readUniswapV2PairState(publicClient, pairAddress);
    const reserveIn = getUniswapV2PairReserveForToken(pairState, tokenIn);
    const reserveOut = getUniswapV2PairReserveForToken(pairState, tokenOut);
    amountOut = calculateUniswapV2AmountOut(amountOut, reserveIn, reserveOut);
    if (amountOut === 0n) {
      logger.debug("Uniswap V2 hop cannot satisfy the requested quote amount", {
        label: config.label,
        pair: pairAddress,
        tokenIn,
        tokenOut,
      });
      return null;
    }
  }

  const quoteAmount = Number(formatEther(amountInWad));
  const idealAmountOut =
    quoteAmount * (prices.quoteTokenPriceUsd / prices.ajnaPriceUsd);
  const actualAmountOut = Number(formatEther(amountOut));
  const oracleDivergencePercent = idealAmountOut > 0
    ? Math.max(0, ((idealAmountOut - actualAmountOut) / idealAmountOut) * 100)
    : 0;

  return {
    amountOut,
    gasEstimate: 100_000n + BigInt(Math.max(0, path.length - 2)) * 50_000n,
    idealAmountOut,
    actualAmountOut,
    oracleDivergencePercent,
  };
}
