/**
 * Alamat AegisVault di BNB Chain Testnet.
 * Di-override lewat NEXT_PUBLIC_CONTRACT_ADDRESS (lihat .env.example).
 * Fallback = deployment terbaru (escrow timeout 2 jam, oracle two-step,
 * pause + emergency withdrawal, batas reason 1024 B).
 */
export const CONTRACT_ADDRESS = (process.env.NEXT_PUBLIC_CONTRACT_ADDRESS ||
  "0xaCFCd2005578Aa407aFC3be7553Cad81baf58f10") as `0x${string}`;

/** Only `submitTransfer` is called from the browser; the oracle reads the rest
 *  on-chain from the backend, so the ABI is trimmed to what the UI needs. */
export const AEGIS_VAULT_ABI = [
  {
    inputs: [{ internalType: "address", name: "recipient", type: "address" }],
    name: "submitTransfer",
    outputs: [{ internalType: "bytes32", name: "escrowId", type: "bytes32" }],
    stateMutability: "payable",
    type: "function",
  },
] as const;
