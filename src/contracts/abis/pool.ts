export const POOL_ABI = [
  {
    inputs: [],
    name: "reservesInfo",
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
  {
    inputs: [{ name: "amount_", type: "uint256" }],
    name: "takeReserves",
    outputs: [{ name: "amount_", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "kickReserveAuction",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "collateralAddress",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "quoteTokenAddress",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;
