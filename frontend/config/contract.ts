/**
 * Alamat AegisVault di BNB Chain Testnet.
 * Di-override lewat NEXT_PUBLIC_CONTRACT_ADDRESS (lihat .env.example).
 * Fallback = deployment terbaru (escrow timeout 2 jam, oracle two-step,
 * pause + emergency withdrawal, batas reason 1024 B).
 */
export const CONTRACT_ADDRESS = (process.env.NEXT_PUBLIC_CONTRACT_ADDRESS ||
  "0xaCFCd2005578Aa407aFC3be7553Cad81baf58f10") as `0x${string}`;

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
