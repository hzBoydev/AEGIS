import { bscTestnet } from "viem/chains";

/**
 * Pesan kanonik yang ditandatangani reviewer sebelum vote dikirim ke backend.
 *
 * WAJIB identik dengan `backend/src/voteAuth.ts#buildVoteMessage` — kalau salah
 * selisih satu karakter, verifikasi EIP-191 di backend gagal dengan 401.
 */
export const VOTE_MESSAGE_VERSION = "AEGIS Human Review Vote v1";

export interface VoteMessageInput {
  voter: string;
  escrowId: string;
  approve: boolean;
  timestamp: number;
  chainId?: number;
}

export function buildVoteMessage(input: VoteMessageInput): string {
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
