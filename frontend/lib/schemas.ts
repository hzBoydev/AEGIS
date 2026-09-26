import { z } from "zod";

/**
 * Skema runtime untuk respons backend.
 * TypeScript sudah menangkap salah ketik di sisi kita; skema ini menangkap
 * respons backend yang berubah/rusak (bukan JSON, field hilang, tipe salah)
 * supaya UI gagal dengan pesan jelas, bukan crash di tengah render.
 *
 * Semua object memakai looseObject → field tambahan dari backend tidak membuat
 * validasi gagal.
 */

export const streamEventSchema = z.looseObject({
  ts: z.number(),
  escrowId: z.string().optional(),
  // String longgar: backend bisa mengirim fase tambahan (mis. redteam) yang
  // difilter di lapisan komponen.
  phase: z.string(),
  status: z.string(),
  label: z.string(),
  detail: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

/** Baris tabel `decisions` (dipakai /api/escrows dan /api/human/pending). */
export const decisionRowSchema = z.looseObject({
  id: z.number(),
  escrow_id: z.string(),
  sender: z.string(),
  recipient: z.string(),
  amount: z.string(),
  eligible: z.number(),
  confidence: z.number(),
  reasoning: z.string(),
  risk_level: z.string().nullable().optional(),
  decided_by: z.string().nullable().optional(),
  risk_flags: z.string().nullable().optional(),
  tx_hash: z.string().nullable().optional(),
  tools_used: z.string().nullable().optional(),
  debate: z.string().nullable().optional(),
  status: z.string().optional(),
  human_vote: z.number().nullable().optional(),
  human_reason: z.string().nullable().optional(),
  created_at: z.string(),
});

export const debateSessionSchema = z.looseObject({
  escrowId: z.string(),
  startedAt: z.number(),
  updatedAt: z.number(),
  events: z.array(streamEventSchema),
});

/** Amplop standar backend: { success, data?, total?, error? }. */
function envelope<T extends z.ZodType>(data: T) {
  return z.looseObject({
    success: z.boolean(),
    data: data.nullish(),
    total: z.number().optional(),
    error: z.string().optional(),
  });
}

export const escrowsEnvelopeSchema = envelope(z.array(decisionRowSchema));
export const pendingHumanEnvelopeSchema = envelope(z.array(decisionRowSchema));
export const debateEnvelopeSchema = envelope(z.array(debateSessionSchema));
