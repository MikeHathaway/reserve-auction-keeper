import "dotenv/config";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";

const FACTORY_ABI = [
  {
    inputs: [],
    name: "getNumberOfDeployedPools",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "index_", type: "uint256" }],
    name: "deployedPoolsList",
    outputs: [{ type: "address" }],
    stateMutability: "view",
    type: "function",
  },
];

const POOL_ABI = [
  {
    inputs: [],
    name: "quoteTokenAddress",
    outputs: [{ type: "address" }],
    stateMutability: "view",
    type: "function",
  },
];

const MAINNET_POOL_FACTORY = "0x6146DD43C5622bB6D12A5240ab9CF4de14eDC625";
const MAINNET_POOL_INFO_UTILS = "0x30c5eF2997d6a882DE52c4ec01B6D0a5e5B4fAAE";
const DEFAULT_MAINNET_RPC_URL = "https://eth.llamarpc.com";
const WHITELISTED_QUOTES = {
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
};

const POOL_INFO_UTILS_ABI = [
  {
    inputs: [{ name: "ajnaPool_", type: "address" }],
    name: "poolReservesInfo",
    outputs: [
      { name: "reserves_", type: "uint256" },
      { name: "claimableReserves_", type: "uint256" },
      { name: "claimableReservesRemaining_", type: "uint256" },
      { name: "auctionPrice_", type: "uint256" },
      { name: "timeRemaining_", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
];

function resolveMainnetRpcUrl() {
  if (process.env.MAINNET_RPC_URL) return process.env.MAINNET_RPC_URL;

  const provider = process.env.RPC_PROVIDER;
  const apiKey = process.env.RPC_API_KEY;
  if (provider === "alchemy" && apiKey) {
    return `https://eth-mainnet.g.alchemy.com/v2/${apiKey}`;
  }
  if (provider === "infura" && apiKey) {
    return `https://mainnet.infura.io/v3/${apiKey}`;
  }
  return DEFAULT_MAINNET_RPC_URL;
}

function getThreshold(symbol) {
  return symbol === "USDC" ? 1_000_000_000_000n : 1n;
}

async function discoverWhitelistedPools(client) {
  const poolCount = await client.readContract({
    address: MAINNET_POOL_FACTORY,
    abi: FACTORY_ABI,
    functionName: "getNumberOfDeployedPools",
  });

  const poolCalls = [];
  for (let i = 0n; i < poolCount; i += 1n) {
    poolCalls.push({
      address: MAINNET_POOL_FACTORY,
      abi: FACTORY_ABI,
      functionName: "deployedPoolsList",
      args: [i],
    });
  }

  const poolResults = await client.multicall({
    contracts: poolCalls,
    allowFailure: true,
  });

  const pools = poolResults
    .filter((result) => result.status === "success")
    .map((result) => result.result);

  const quoteResults = await client.multicall({
    contracts: pools.map((pool) => ({
      address: pool,
      abi: POOL_ABI,
      functionName: "quoteTokenAddress",
    })),
    allowFailure: true,
  });

  const symbolByAddress = Object.fromEntries(
    Object.entries(WHITELISTED_QUOTES).map(([symbol, address]) => [address.toLowerCase(), symbol]),
  );

  const filteredPools = [];
  for (let i = 0; i < pools.length; i += 1) {
    const quoteResult = quoteResults[i];
    if (quoteResult.status !== "success") continue;
    const quoteToken = quoteResult.result;
    const symbol = symbolByAddress[quoteToken.toLowerCase()];
    if (!symbol) continue;
    filteredPools.push({ pool: pools[i], quoteToken, quoteTokenSymbol: symbol });
  }

  return filteredPools;
}

async function scanBlock(client, pools, blockNumber) {
  const results = await client.multicall({
    contracts: pools.map(({ pool }) => ({
      address: MAINNET_POOL_INFO_UTILS,
      abi: POOL_INFO_UTILS_ABI,
      functionName: "poolReservesInfo",
      args: [pool],
    })),
    allowFailure: true,
    blockNumber,
  });

  const candidates = [];

  for (let i = 0; i < pools.length; i += 1) {
    const result = results[i];
    if (result.status !== "success") continue;

    const [, claimableReserves, claimableReservesRemaining, auctionPrice, timeRemaining] =
      result.result;
    const { pool, quoteToken, quoteTokenSymbol } = pools[i];
    const threshold = getThreshold(quoteTokenSymbol);

    if (claimableReservesRemaining >= threshold && timeRemaining > 0n) {
      candidates.push({
        kind: "active",
        pool,
        quoteToken,
        quoteTokenSymbol,
        claimableReserves: claimableReserves.toString(),
        claimableReservesRemaining: claimableReservesRemaining.toString(),
        auctionPrice: auctionPrice.toString(),
        timeRemaining: timeRemaining.toString(),
      });
      continue;
    }

    if (claimableReserves >= threshold && claimableReservesRemaining === 0n && timeRemaining === 0n) {
      candidates.push({
        kind: "kickable",
        pool,
        quoteToken,
        quoteTokenSymbol,
        claimableReserves: claimableReserves.toString(),
        claimableReservesRemaining: claimableReservesRemaining.toString(),
        auctionPrice: auctionPrice.toString(),
        timeRemaining: timeRemaining.toString(),
      });
    }
  }

  candidates.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "active" ? -1 : 1;
    const leftClaimable = left.kind === "active"
      ? BigInt(left.claimableReservesRemaining)
      : BigInt(left.claimableReserves);
    const rightClaimable = right.kind === "active"
      ? BigInt(right.claimableReservesRemaining)
      : BigInt(right.claimableReserves);
    if (leftClaimable === rightClaimable) return 0;
    return leftClaimable > rightClaimable ? -1 : 1;
  });

  return candidates;
}

async function main() {
  const client = createPublicClient({
    chain: mainnet,
    transport: http(resolveMainnetRpcUrl()),
  });

  const latestBlock = await client.getBlockNumber();
  const startBlock = process.env.START_BLOCK ? BigInt(process.env.START_BLOCK) : latestBlock;
  const lookbackBlocks = process.env.LOOKBACK_BLOCKS ? BigInt(process.env.LOOKBACK_BLOCKS) : 100_000n;
  const stepBlocks = process.env.STEP_BLOCKS ? BigInt(process.env.STEP_BLOCKS) : 500n;
  const endBlock = process.env.END_BLOCK
    ? BigInt(process.env.END_BLOCK)
    : (startBlock > lookbackBlocks ? startBlock - lookbackBlocks : 0n);

  const pools = await discoverWhitelistedPools(client);

  for (let blockNumber = startBlock; blockNumber >= endBlock; blockNumber -= stepBlocks) {
    const candidates = await scanBlock(client, pools, blockNumber);
    if (candidates.length > 0) {
      console.log(JSON.stringify({
        blockNumber: blockNumber.toString(),
        candidateCount: candidates.length,
        candidates: candidates.slice(0, 10),
      }, null, 2));
      return;
    }

    if ((startBlock - blockNumber) % (stepBlocks * 10n) === 0n) {
      console.error(`scanned block ${blockNumber.toString()} with no reserve-auction fixture yet`);
    }
  }

  console.error(
    `No reserve-auction fixture found from block ${startBlock.toString()} down to ${endBlock.toString()}.`,
  );
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
