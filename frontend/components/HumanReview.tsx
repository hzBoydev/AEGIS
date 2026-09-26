"use client";

import { useEffect, useState } from "react";
import { formatTimestamp, truncateAddress } from "@/lib/utils";
import { fetchJson, shortApiMessage } from "@/lib/api";

interface PendingHuman {
  id: number;
  escrow_id: string;
  sender: string;
  recipient: string;
  amount: string;
  eligible: number;
  confidence: number;
  reasoning: string;
  risk_level: string | null;
  human_reason: string | null;
  created_at: string;
}

interface PendingEnvelope {
  success: boolean;
  data: PendingHuman[];
  error?: string;
}

interface VoteEnvelope {
  success: boolean;
  data?: { txHash: string };
  error?: string;
}

async function fetchPending(): Promise<PendingHuman[]> {
  const json = await fetchJson<PendingEnvelope>("/api/human/pending");
  if (!json.success) {
    throw new Error(json.error ?? "Antrean tinjauan tidak dapat dimuat.");
  }
  return dedupeByEscrow(json.data ?? []);
}

function dedupeByEscrow(rows: PendingHuman[]): PendingHuman[] {
  const seen = new Set<string>();
  const out: PendingHuman[] = [];
  for (const r of rows) {
    if (seen.has(r.escrow_id)) continue;
    seen.add(r.escrow_id);
    out.push(r);
  }
  return out;
}

export default function HumanReview() {
  const [items, setItems] = useState<PendingHuman[]>([]);
  const [loading, setLoading] = useState(true);
  const [votingId, setVotingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    async function load() {
      try {
        const rows = await fetchPending();
        if (!alive) return;
        setItems(rows);
        setError(null);
      } catch (err) {
        if (!alive) return;
        setError(shortApiMessage(err));
      } finally {
        if (alive) setLoading(false);
      }
    }

    void load();
    const t = setInterval(() => {
      void load();
    }, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  async function refresh() {
    try {
      setItems(await fetchPending());
      setError(null);
    } catch (err) {
      setError(shortApiMessage(err));
    }
  }

  async function vote(escrowId: string, approve: boolean) {
    setVotingId(items.find((i) => i.escrow_id === escrowId)?.id ?? null);
    setError(null);
    setOkMsg(null);
    try {
      const json = await fetchJson<VoteEnvelope>("/api/human/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ escrowId, approve }),
      });
      if (!json.success || !json.data) {
        setError(json.error ?? "Keputusan gagal dikirim ke backend.");
        return;
      }
      setOkMsg(
        `${approve ? "Transfer disetujui & diteruskan" : "Transfer dibatalkan & dana dikembalikan"} — tx ${String(json.data.txHash).slice(0, 18)}…`
      );
      await refresh();
    } catch (err) {
      setError(shortApiMessage(err));
    } finally {
      setVotingId(null);
    }
  }

  return (
    <section className="card overflow-hidden">
      <div className="card-head">
        <div>
          <p className="eyebrow">Kendali Pengguna</p>
          <p className="font-display mt-1 text-xl text-ink">Tinjauan Manual (Veto)</p>
          <p className="text-muted mt-1 text-xs leading-relaxed">
            Transaksi yang membutuhkan persetujuan Anda sebelum dieksekusi on-chain
          </p>
        </div>
        {!loading && items.length > 0 && (
          <span className="badge badge-bronze">{items.length} Menunggu Keputusan</span>
        )}
      </div>

      <div className="card-pad">
        {okMsg && (
          <div className="alert alert-safe mb-4" role="status">
            <span aria-hidden className="font-bold">✓</span>
            <span>{okMsg}</span>
          </div>
        )}
        {error && (
          <div className="alert alert-danger mb-4" role="alert">
            <span aria-hidden className="font-bold">✕</span>
            <span>{error}</span>
          </div>
        )}

        {loading && items.length === 0 ? (
          <div className="text-muted flex items-center gap-2 text-sm py-2">
            <span className="pulse-bronze h-2 w-2 rounded-full bg-[var(--bronze)]" />
            Memuat antrean tinjauan manual…
          </div>
        ) : items.length === 0 ? (
          <div className="empty-note">
            <p className="font-semibold text-ink mb-1">Semua Bersih & Aman</p>
            Tidak ada transaksi yang tertahan. Jika sistem mendeteksi ketidakwajaran atau tingkat keyakinan berada di zona abu-abu, transaksi akan muncul di sini untuk Anda konfirmasi.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {items.map((p) => {
              const aiRec = p.eligible === 1;
              const busy = votingId === p.id;

              return (
                <article key={p.id} className="pending-card">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <p className="font-display text-lg font-bold text-ink">{p.amount} BNB</p>
                    <span className="badge badge-bronze text-[11px]">
                      Tingkat Keyakinan: {Math.round(p.confidence * 100)}%
                    </span>
                  </div>

                  <p className="text-muted mt-1.5 text-xs">
                    Tujuan: <span className="font-mono text-ink font-medium">{truncateAddress(p.recipient)}</span>
                    {p.created_at && <> · {formatTimestamp(p.created_at)}</>}
                  </p>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className={aiRec ? "tag tag-safe" : "tag tag-danger"}>
                      Rekomendasi Sistem: {aiRec ? "DISARANKAN LANJUT" : "DISARANKAN BATAL"}
                    </span>
                    {p.risk_level && (
                      <span className="tag">Level Risiko: {p.risk_level}</span>
                    )}
                  </div>

                  {p.human_reason && (
                    <p className="text-muted mt-2 text-xs leading-relaxed bg-[var(--surface)] p-2 rounded-md border border-[var(--border)]">
                      ℹ️ {p.human_reason}
                    </p>
                  )}

                  <p className="text-ink mt-3 text-sm leading-relaxed">{p.reasoning}</p>

                  <div className="mt-4 flex gap-2.5 pt-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => vote(p.escrow_id, true)}
                      className="btn btn-safe flex-1"
                    >
                      {busy ? "Memproses…" : "✓ Setujui (Lanjutkan)"}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => vote(p.escrow_id, false)}
                      className="btn btn-danger flex-1"
                    >
                      {busy ? "Memproses…" : "✕ Tolak (Kembalikan Dana)"}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
