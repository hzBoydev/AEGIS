"use client";

import { useEffect, useState } from "react";
import { formatTimestamp, truncateAddress } from "@/lib/utils";

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

/** 1 escrow = 1 kartu vote (defensive — backend sudah UNIQUE). */
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
        const res = await fetch("http://localhost:3001/api/human/pending");
        const json = await res.json();
        if (alive && json.success) {
          setItems(dedupeByEscrow(json.data ?? []));
          setError(null);
        }
      } catch {
        /* backend mungkin belum jalan */
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
      const res = await fetch("http://localhost:3001/api/human/pending");
      const json = await res.json();
      if (json.success) setItems(dedupeByEscrow(json.data ?? []));
      setError(null);
    } catch {
      /* ignore */
    }
  }

  async function vote(escrowId: string, approve: boolean) {
    setVotingId(items.find((i) => i.escrow_id === escrowId)?.id ?? null);
    setError(null);
    setOkMsg(null);
    try {
      const res = await fetch("http://localhost:3001/api/human/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ escrowId, approve }),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error ?? "Vote gagal");
        return;
      }
      setOkMsg(
        `${approve ? "Diteruskan" : "Dikembalikan"} — tx ${String(json.data.txHash).slice(0, 18)}…`
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Vote gagal");
    } finally {
      setVotingId(null);
    }
  }

  return (
    <section className="card overflow-hidden">
      <div className="card-head">
        <div>
          <p className="eyebrow">Human-in-the-loop</p>
          <p className="font-display mt-1 text-xl text-ink">Veto Manusia</p>
          <p className="text-muted mt-1 text-xs leading-relaxed">
            AI menahan dana — 1 suara manusia menentukan final on-chain.
          </p>
        </div>
        {!loading && items.length > 0 && (
          <span className="badge badge-bronze">{items.length} antre</span>
        )}
      </div>

      <div className="card-pad">
        {okMsg && (
          <div className="alert alert-safe mb-4" role="status">
            <span aria-hidden>✓</span>
            <span>{okMsg}</span>
          </div>
        )}
        {error && (
          <div className="alert alert-danger mb-4" role="alert">
            <span aria-hidden>✕</span>
            <span>{error}</span>
          </div>
        )}

        {loading && items.length === 0 ? (
          <div className="text-muted flex items-center gap-2 text-sm">
            <span className="pulse h-1.5 w-1.5 rounded-full bg-[var(--bronze)]" />
            Memuat antrean review manusia
          </div>
        ) : items.length === 0 ? (
          <div className="empty-note">
            Tidak ada escrow yang menunggu veto manusia. Hold muncul saat confidence AI
            di zona abu-abu atau sidang berbalik lean.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {items.map((p) => {
              const aiRec = p.eligible === 1;
              const busy = votingId === p.id;

              return (
                <article key={p.id} className="pending-card">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <p className="font-display text-base text-ink">{p.amount} BNB</p>
                    <span className="text-bronze text-xs">
                      {Math.round(p.confidence * 100)}% conf · {p.risk_level ?? "—"}
                    </span>
                  </div>

                  <p className="text-muted mt-1 text-xs">
                    ke {truncateAddress(p.recipient)} · escrow{" "}
                    <code className="text-[10px]">{p.escrow_id.slice(0, 14)}…</code>
                    {p.created_at && <> · {formatTimestamp(p.created_at)}</>}
                  </p>

                  <div className="mt-3.5 flex flex-wrap items-center gap-2">
                    <span className={aiRec ? "tag tag-safe" : "tag tag-danger"}>
                      Rekomendasi AI · {aiRec ? "RELEASE" : "REJECT"}
                    </span>
                  </div>
                  {p.human_reason && (
                    <p className="text-muted mt-2 text-xs leading-relaxed">{p.human_reason}</p>
                  )}

                  <p className="text-ink mt-3 text-sm leading-relaxed">{p.reasoning}</p>

                  <div className="mt-4 flex gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => vote(p.escrow_id, true)}
                      className="btn btn-safe flex-1"
                    >
                      {busy ? "Memproses…" : "Setujui (release)"}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => vote(p.escrow_id, false)}
                      className="btn btn-danger flex-1"
                    >
                      {busy ? "Memproses…" : "Tolak (revert)"}
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
