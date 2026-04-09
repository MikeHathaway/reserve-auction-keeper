import {
  getAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

const ADDRESS_HEX_LENGTH = 40;
const FEE_HEX_LENGTH = 6;
const MIN_PATH_HEX_LENGTH = ADDRESS_HEX_LENGTH * 2 + FEE_HEX_LENGTH;
const NEXT_HOP_HEX_LENGTH = ADDRESS_HEX_LENGTH + FEE_HEX_LENGTH;

export const UNISWAP_V3_POOL_IDENTITY_ABI = [
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
    name: "fee",
    outputs: [{ name: "", type: "uint24" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export interface UniswapV3PoolIdentity {
  address: Address;
  token0: Address;
  token1: Address;
  fee: bigint;
}

export interface UniswapV3PathHop {
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
}

function parsePathAddress(pathHex: string, offset: number): Address {
  const segment = pathHex.slice(offset, offset + ADDRESS_HEX_LENGTH);
  if (segment.length !== ADDRESS_HEX_LENGTH) {
    throw new Error("Path ended mid-address");
  }
  return getAddress(`0x${segment}`);
}

function normalizePoolKey(
  tokenA: Address,
  tokenB: Address,
  fee: bigint | number,
): string {
  const normalizedA = getAddress(tokenA).toLowerCase();
  const normalizedB = getAddress(tokenB).toLowerCase();
  const [token0, token1] = normalizedA < normalizedB
    ? [normalizedA, normalizedB]
    : [normalizedB, normalizedA];
  return `${token0}:${token1}:${fee.toString()}`;
}

export function decodeUniswapV3Path(path: Hex): UniswapV3PathHop[] {
  const pathHex = path.slice(2);
  if (
    pathHex.length < MIN_PATH_HEX_LENGTH ||
    (pathHex.length - ADDRESS_HEX_LENGTH) % NEXT_HOP_HEX_LENGTH !== 0
  ) {
    throw new Error("Path must encode at least one complete Uniswap V3 hop");
  }

  let offset = 0;
  let tokenIn = parsePathAddress(pathHex, offset);
  offset += ADDRESS_HEX_LENGTH;

  const hops: UniswapV3PathHop[] = [];
  while (offset < pathHex.length) {
    const feeHex = pathHex.slice(offset, offset + FEE_HEX_LENGTH);
    const tokenOut = parsePathAddress(pathHex, offset + FEE_HEX_LENGTH);
    const fee = Number.parseInt(feeHex, 16);
    if (!Number.isFinite(fee)) {
      throw new Error("Path contains an invalid Uniswap V3 fee tier");
    }

    hops.push({ tokenIn, tokenOut, fee });
    tokenIn = tokenOut;
    offset += NEXT_HOP_HEX_LENGTH;
  }

  return hops;
}

export function validateUniswapV3PathEndpoints(
  path: Hex,
  expectedTokenIn: Address,
  expectedTokenOut: Address,
): string | null {
  try {
    const hops = decodeUniswapV3Path(path);
    const firstHop = hops[0];
    const lastHop = hops[hops.length - 1];

    if (firstHop.tokenIn.toLowerCase() !== expectedTokenIn.toLowerCase()) {
      return `path must start with ${expectedTokenIn}, found ${firstHop.tokenIn}`;
    }

    if (lastHop.tokenOut.toLowerCase() !== expectedTokenOut.toLowerCase()) {
      return `path must end with ${expectedTokenOut}, found ${lastHop.tokenOut}`;
    }

    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function pathReusesUniswapV3Pool(
  path: Hex,
  poolIdentity: Pick<UniswapV3PoolIdentity, "token0" | "token1" | "fee">,
): boolean {
  const flashPoolKey = normalizePoolKey(
    poolIdentity.token0,
    poolIdentity.token1,
    poolIdentity.fee,
  );

  return decodeUniswapV3Path(path).some((hop) =>
    normalizePoolKey(hop.tokenIn, hop.tokenOut, hop.fee) === flashPoolKey
  );
}

export async function readUniswapV3PoolIdentity(
  publicClient: PublicClient,
  poolAddress: Address,
): Promise<UniswapV3PoolIdentity> {
  const [token0, token1, fee] = await Promise.all([
    publicClient.readContract({
      address: poolAddress,
      abi: UNISWAP_V3_POOL_IDENTITY_ABI,
      functionName: "token0",
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: UNISWAP_V3_POOL_IDENTITY_ABI,
      functionName: "token1",
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: UNISWAP_V3_POOL_IDENTITY_ABI,
      functionName: "fee",
    }),
  ]);

  return {
    address: poolAddress,
    token0: token0 as Address,
    token1: token1 as Address,
    fee: typeof fee === "bigint" ? fee : BigInt(fee),
  };
}
