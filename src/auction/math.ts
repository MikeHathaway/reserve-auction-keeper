import { parseEther } from "viem";

const WAD = parseEther("1");

export function ceilWadMul(left: bigint, right: bigint): bigint {
  if (left === 0n || right === 0n) return 0n;
  return (left * right + WAD - 1n) / WAD;
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

export function calculateReserveTakeAjnaCost(
  quoteAmount: bigint,
  auctionPrice: bigint,
): bigint {
  return ceilWadMul(quoteAmount, auctionPrice);
}
