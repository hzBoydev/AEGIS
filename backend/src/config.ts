import "dotenv/config";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

const RPC_URL = process.env.RPC_URL!;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS! as `0x${string}`;
const ORACLE_PRIVATE_KEY = process.env.ORACLE_PRIVATE_KEY! as `0x${string}`;
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const POLLING_INTERVAL_MS = Number(process.env.POLLING_INTERVAL_MS || 8000);

if (!RPC_URL || !CONTRACT_ADDRESS || !ORACLE_PRIVATE_KEY) {
  throw new Error("Environment variable belum lengkap. Cek file .env");
}

export const account = privateKeyToAccount(ORACLE_PRIVATE_KEY);

export const publicClient = createPublicClient({
  chain: bscTestnet,
  transport: http(RPC_URL),
});

export const walletClient = createWalletClient({
  account,
  chain: bscTestnet,
  transport: http(RPC_URL),
});

export const config = {
  CONTRACT_ADDRESS,
  OLLAMA_URL,
  POLLING_INTERVAL_MS,
};
