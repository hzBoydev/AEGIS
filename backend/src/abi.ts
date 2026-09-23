export const AEGIS_VAULT_ABI = [
  {
    inputs: [],
    name: "getPendingEscrows",
    outputs: [{ internalType: "bytes32[]", name: "", type: "bytes32[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "escrowId", type: "bytes32" }],
    name: "getEscrowData",
    outputs: [
      { internalType: "address", name: "sender", type: "address" },
      { internalType: "address", name: "recipient", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
      { internalType: "uint8", name: "status", type: "uint8" },
      { internalType: "uint256", name: "createdAt", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "escrowId", type: "bytes32" },
      { internalType: "bool", name: "eligible", type: "bool" },
      { internalType: "string", name: "reason", type: "string" },
    ],
    name: "fulfillVerification",
    outputs: [],
    stateMutability: "nonpayable",
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
,
  {
    type: "event",
    name: "EscrowCreated",
    inputs: [
      { indexed: true,  name: "escrowId",  type: "bytes32" },
      { indexed: true,  name: "sender",    type: "address" },
      { indexed: true,  name: "recipient", type: "address" },
      { indexed: false, name: "amount",    type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "EscrowReleased",
    inputs: [
      { indexed: true, name: "escrowId", type: "bytes32" },
    ],
  },
  {
    type: "event",
    name: "EscrowReverted",
    inputs: [
      { indexed: true,  name: "escrowId", type: "bytes32" },
      { indexed: false, name: "reason",   type: "string"  },
    ],
  },
] as const;
