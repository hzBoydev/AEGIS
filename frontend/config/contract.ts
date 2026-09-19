export const CONTRACT_ADDRESS = "0x7C2416CB90b1AF3838Bf1D3bFe9C0eEa0e283C46" as const;

export const AEGIS_VAULT_ABI = [
  {
    inputs: [{ internalType: "address", name: "recipient", type: "address" }],
    name: "submitTransfer",
    outputs: [{ internalType: "bytes32", name: "escrowId", type: "bytes32" }],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [],
    name: "getPendingEscrows",
    outputs: [{ internalType: "bytes32[]", name: "", type: "bytes32[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "escrowId", type: "bytes32" }],
    name: "getEscrowStatus",
    outputs: [
      { internalType: "uint8", name: "status", type: "uint8" },
      { internalType: "string", name: "reason", type: "string" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "bytes32", name: "escrowId", type: "bytes32" },
      { indexed: true, internalType: "address", name: "sender", type: "address" },
      { indexed: true, internalType: "address", name: "recipient", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "EscrowCreated",
    type: "event",
  },
] as const;
