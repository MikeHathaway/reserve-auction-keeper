export const POOL_FACTORY_ABI = [
  {
    inputs: [
      { name: "collateralAddress_", type: "address" },
      { name: "quoteAddress_", type: "address" },
    ],
    name: "deployedPools",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getNumberOfDeployedPools",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "index_", type: "uint256" }],
    name: "deployedPoolsList",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;
