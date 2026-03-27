export const POOL_INFO_UTILS_ABI = [
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
] as const;
