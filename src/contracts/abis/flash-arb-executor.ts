export const FLASH_ARB_EXECUTOR_ABI = [
  {
    inputs: [
      {
        components: [
          { name: "flashPool", type: "address" },
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
] as const;
