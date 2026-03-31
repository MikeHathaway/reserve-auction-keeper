import {
  type Address,
  type Hex,
  type PublicClient,
  formatEther,
} from "viem";
import type { PriceData } from "../pricing/oracle.js";
import { toNormalizedQuoteTokenAmount } from "../auction/math.js";

const ERC20_BALANCE_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

interface BalanceSnapshot {
  native: bigint;
  ajna: bigint;
  quoteTokenRaw: bigint;
}

export interface RealizedExecutionSettlement {
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  gasFeeNative: bigint;
  nativeDelta: bigint;
  ajnaDelta: bigint;
  quoteTokenDeltaRaw: bigint;
  quoteTokenDelta: bigint;
  profitUsd: number;
}

interface SettlementContext {
  publicClient: PublicClient;
  txHash: Hex;
  walletAddress: Address;
  ajnaToken: Address;
  quoteToken: Address;
  quoteTokenScale: bigint;
  prices: PriceData;
  nativeTokenPriceUsd: number;
}

function toSignedEtherNumber(value: bigint): number {
  if (value === 0n) return 0;
  const isNegative = value < 0n;
  const absolute = isNegative ? -value : value;
  const numeric = Number(formatEther(absolute));
  return isNegative ? -numeric : numeric;
}

async function readBalanceSnapshot(
  publicClient: PublicClient,
  walletAddress: Address,
  ajnaToken: Address,
  quoteToken: Address,
): Promise<BalanceSnapshot> {
  const [native, ajna, quoteTokenRaw] = await Promise.all([
    publicClient.getBalance({ address: walletAddress }),
    publicClient.readContract({
      address: ajnaToken,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [walletAddress],
    }),
    publicClient.readContract({
      address: quoteToken,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [walletAddress],
    }),
  ]);

  return { native, ajna, quoteTokenRaw };
}

export async function captureExecutionSnapshot(
  publicClient: PublicClient,
  walletAddress: Address,
  ajnaToken: Address,
  quoteToken: Address,
): Promise<BalanceSnapshot> {
  return readBalanceSnapshot(publicClient, walletAddress, ajnaToken, quoteToken);
}

export async function finalizeExecutionSettlement(
  before: BalanceSnapshot,
  context: SettlementContext,
): Promise<RealizedExecutionSettlement> {
  const receipt = await context.publicClient.waitForTransactionReceipt({
    hash: context.txHash,
  });

  if (receipt.status !== "success") {
    throw new Error(`Transaction ${context.txHash} reverted on-chain.`);
  }

  const after = await readBalanceSnapshot(
    context.publicClient,
    context.walletAddress,
    context.ajnaToken,
    context.quoteToken,
  );

  const gasUsed = receipt.gasUsed;
  const effectiveGasPrice = receipt.effectiveGasPrice ?? 0n;
  const gasFeeNative = gasUsed * effectiveGasPrice;
  const nativeDelta = after.native - before.native;
  const ajnaDelta = after.ajna - before.ajna;
  const quoteTokenDeltaRaw = after.quoteTokenRaw - before.quoteTokenRaw;
  const quoteTokenDelta = toNormalizedQuoteTokenAmount(
    quoteTokenDeltaRaw,
    context.quoteTokenScale,
  );

  const profitUsd =
    toSignedEtherNumber(quoteTokenDelta) * context.prices.quoteTokenPriceUsd +
    toSignedEtherNumber(ajnaDelta) * context.prices.ajnaPriceUsd +
    toSignedEtherNumber(nativeDelta) * context.nativeTokenPriceUsd;

  return {
    blockNumber: receipt.blockNumber,
    gasUsed,
    effectiveGasPrice,
    gasFeeNative,
    nativeDelta,
    ajnaDelta,
    quoteTokenDeltaRaw,
    quoteTokenDelta,
    profitUsd,
  };
}
