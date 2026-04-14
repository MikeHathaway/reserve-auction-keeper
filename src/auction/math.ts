import { parseEther } from "viem";

const WAD = parseEther("1");
const RESERVE_AUCTION_INITIAL_PRICE_MULTIPLIER = 1_000_000_000n * WAD;
const RESERVE_AUCTION_DECAY_HOURS = 72n;

export function ceilWadMul(left: bigint, right: bigint): bigint {
  if (left === 0n || right === 0n) return 0n;
  return (left * right + WAD - 1n) / WAD;
}

export function wadDiv(left: bigint, right: bigint): bigint {
  if (left === 0n || right === 0n) return 0n;
  return left * WAD / right;
}

export function roundDownToTokenScale(amount: bigint, scale: bigint): bigint {
  if (amount <= 0n || scale <= 1n) return amount;
  return amount - (amount % scale);
}

export function normalizeReserveTakeAmount(
  amount: bigint,
  quoteTokenScale: bigint,
): bigint {
  return roundDownToTokenScale(amount, quoteTokenScale);
}

export function toRawQuoteTokenAmount(
  wadAmount: bigint,
  quoteTokenScale: bigint,
): bigint {
  if (wadAmount <= 0n) return 0n;
  if (quoteTokenScale <= 1n) return wadAmount;
  return wadAmount / quoteTokenScale;
}

export function toNormalizedQuoteTokenAmount(
  rawAmount: bigint,
  quoteTokenScale: bigint,
): bigint {
  if (rawAmount === 0n) return 0n;
  if (quoteTokenScale <= 1n) return rawAmount;
  return rawAmount * quoteTokenScale;
}

export function calculateReserveTakeAjnaCost(
  quoteAmount: bigint,
  auctionPrice: bigint,
): bigint {
  return ceilWadMul(quoteAmount, auctionPrice);
}

export function calculateReserveAuctionInitialPrice(
  claimableReserves: bigint,
): bigint {
  if (claimableReserves <= 0n) return 0n;
  return wadDiv(RESERVE_AUCTION_INITIAL_PRICE_MULTIPLIER, claimableReserves);
}

export function calculateReserveAuctionFinalPrice(
  claimableReserves: bigint,
): bigint {
  if (claimableReserves <= 0n) return 0n;
  return calculateReserveAuctionInitialPrice(claimableReserves) /
    (1n << RESERVE_AUCTION_DECAY_HOURS);
}
