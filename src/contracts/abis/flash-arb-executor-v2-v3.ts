export const FLASH_ARB_EXECUTOR_V2_V3_ABI = [
  {
    inputs: [
      {
        components: [
          { name: "flashPair", type: "address" },
          { name: "ajnaPool", type: "address" },
          { name: "borrowAmount", type: "uint256" },
          { name: "quoteAmount", type: "uint256" },
          { name: "swapPath", type: "bytes" },
          { name: "minAjnaOut", type: "uint256" },
          { name: "profitRecipient", type: "address" },
        ],
        name: "params",
        type: "tuple",
      },
    ],
    name: "executeFlashArb",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "token", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "recoverToken",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;
