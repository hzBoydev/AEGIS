import { verifyMessage, isAddress, type Address } from "viem";
import { bscTestnet } from "viem/chains";
import { config } from "./config.js";

// ── Auth untuk POST /api/human/vote ──────────────────────────────────────────
// Endpoint ini menandatangani tx on-chain dari wallet oracle, jadi wajib punya
// bukti: voter menandatangani pesan kanonik (EIP-191 personal_sign) yang
// mengikat {escrowId, action, timestamp, chainId}. Replay dicegah oleh jendela
// timestamp; allowlist REVIEWER_ADDRESSES membatasi siapa yang sah.

export const VOTE_MESSAGE_VERSION = "AEGIS Human Review Vote v1";

/** Pesan persis yang ditandatangani voter di frontend. Jangan diubah sembarangan. */
export function buildVoteMessage(input: {
  voter: string;
  escrowId: string;
  approve: boolean;
  timestamp: number;
  chainId?: number;
}): string {
  const chainId = input.chainId ?? bscTestnet.id;
  return [
    VOTE_MESSAGE_VERSION,
    `Chain-Id: ${chainId}`,
    `Escrow-Id: ${input.escrowId}`,
    `Action: ${input.approve ? "APPROVE" : "REJECT"}`,
    `Voter: ${input.voter.toLowerCase()}`,
    `Timestamp: ${input.timestamp}`,
  ].join("\n");
}

export type VoteAuthFailure =
  | "bad_payload"
  | "expired_timestamp"
  | "bad_signature"
  | "not_reviewer";

export interface VoteAuthResult {
  ok: boolean;
  voter?: Address;
  failure?: VoteAuthFailure;
}

export async function verifyVote(input: {
  voter: string;
  escrowId: string;
  approve: boolean;
  /** Hex 0x… — sudah divalidasi format oleh caller (zod). */
  signature: string;
  timestamp: number;
}): Promise<VoteAuthResult> {
  if (!isAddress(input.voter) || !Number.isFinite(input.timestamp)) {
    return { ok: false, failure: "bad_payload" };
  }

  const maxAge = config.VOTE_MAX_AGE_MS;
  if (Math.abs(Date.now() - input.timestamp) > maxAge) {
    return { ok: false, failure: "expired_timestamp" };
  }

  const message = buildVoteMessage({
    voter: input.voter,
    escrowId: input.escrowId,
    approve: input.approve,
    timestamp: input.timestamp,
  });

  let valid = false;
  try {
    valid = await verifyMessage({
      address: input.voter as Address,
      message,
      signature: input.signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, failure: "bad_signature" };

  const allowlist = config.REVIEWER_ADDRESSES;
  if (allowlist.length > 0 && !allowlist.includes(input.voter.toLowerCase())) {
    return { ok: false, failure: "not_reviewer" };
  }

  return { ok: true, voter: input.voter as Address };
}
