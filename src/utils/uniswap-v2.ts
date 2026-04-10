import {
  getAddress,
  type Address,
  type PublicClient,
} from "viem";

const UNISWAP_V2_FACTORY_ABI = [
  {
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
    ],
    name: "getPair",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const UNISWAP_V2_PAIR_ABI = [
  {
    inputs: [],
    name: "token0",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "token1",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getReserves",
    outputs: [
      { name: "reserve0", type: "uint112" },
      { name: "reserve1", type: "uint112" },
      { name: "blockTimestampLast", type: "uint32" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

const UNISWAP_V2_SWAP_FEE_NUMERATOR = 997n;
const UNISWAP_V2_SWAP_FEE_DENOMINATOR = 1000n;

export interface UniswapV2PairState {
  address: Address;
  token0: Address;
  token1: Address;
  reserve0: bigint;
  reserve1: bigint;
}

function normalizeToken(token: Address): string {
  return getAddress(token).toLowerCase();
}

export function validateUniswapV2PathEndpoints(
  path: readonly Address[],
  expectedTokenIn: Address,
  expectedTokenOut: Address,
): string | null {
  if (path.length < 2) {
    return "path must contain at least two token addresses";
  }

  if (normalizeToken(path[0]) !== normalizeToken(expectedTokenIn)) {
    return `path must start with ${expectedTokenIn}, found ${path[0]}`;
  }

  if (normalizeToken(path[path.length - 1]) !== normalizeToken(expectedTokenOut)) {
    return `path must end with ${expectedTokenOut}, found ${path[path.length - 1]}`;
  }

  return null;
}

export async function getUniswapV2PairAddress(
  publicClient: PublicClient,
  factoryAddress: Address,
  tokenA: Address,
  tokenB: Address,
): Promise<Address | null> {
  const pairAddress = await publicClient.readContract({
    address: factoryAddress,
    abi: UNISWAP_V2_FACTORY_ABI,
    functionName: "getPair",
    args: [tokenA, tokenB],
  });

  const normalizedPair = getAddress(pairAddress as Address);
  return normalizedPair === "0x0000000000000000000000000000000000000000"
    ? null
    : normalizedPair;
}

export async function readUniswapV2PairState(
  publicClient: PublicClient,
  pairAddress: Address,
): Promise<UniswapV2PairState> {
  const [token0, token1, reserves] = await Promise.all([
    publicClient.readContract({
      address: pairAddress,
      abi: UNISWAP_V2_PAIR_ABI,
      functionName: "token0",
    }),
    publicClient.readContract({
      address: pairAddress,
      abi: UNISWAP_V2_PAIR_ABI,
      functionName: "token1",
    }),
    publicClient.readContract({
      address: pairAddress,
      abi: UNISWAP_V2_PAIR_ABI,
      functionName: "getReserves",
    }),
  ]);

  const [reserve0, reserve1] = reserves as readonly [bigint, bigint, number];

  return {
    address: pairAddress,
    token0: token0 as Address,
    token1: token1 as Address,
    reserve0,
    reserve1,
  };
}

export function getUniswapV2PairReserveForToken(
  pairState: Pick<UniswapV2PairState, "token0" | "token1" | "reserve0" | "reserve1">,
  token: Address,
): bigint {
  const normalizedToken = normalizeToken(token);
  if (normalizeToken(pairState.token0) === normalizedToken) {
    return pairState.reserve0;
  }
  if (normalizeToken(pairState.token1) === normalizedToken) {
    return pairState.reserve1;
  }
  return 0n;
}

export function calculateUniswapV2AmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) {
    return 0n;
  }

  const amountInWithFee = amountIn * UNISWAP_V2_SWAP_FEE_NUMERATOR;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * UNISWAP_V2_SWAP_FEE_DENOMINATOR + amountInWithFee;
  if (denominator === 0n) {
    return 0n;
  }
  return numerator / denominator;
}

export function calculateUniswapV2RepayAmount(borrowAmount: bigint): bigint {
  if (borrowAmount <= 0n) {
    return 0n;
  }

  return (borrowAmount * UNISWAP_V2_SWAP_FEE_DENOMINATOR +
    UNISWAP_V2_SWAP_FEE_NUMERATOR - 1n) /
    UNISWAP_V2_SWAP_FEE_NUMERATOR;
}
