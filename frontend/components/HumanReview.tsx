"use client";

import { useEffect, useState } from "react";

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

function truncateAddress(addr: string) {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
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

  if (loading && items.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)] mt-8">
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--bronze)] pulse" />
        Memuat antrean review manusia
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="mt-10 py-6 border-t text-center" style={{ borderColor: "var(--border)" }}>
        <p className="text-xs text-[var(--text-secondary)]">
          Tidak ada escrow yang menunggu veto manusia. Hold muncul saat confidence AI
          di zona abu-abu atau sidang berbalik lean.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-12">
      <p className="font-display text-lg mb-1" style={{ color: "var(--text-primary)" }}>
        Veto Manusia
      </p>
      <p className="text-xs text-[var(--text-secondary)] mb-5">
        AI menahan dana — 1 suara manusia menentukan final on-chain.
      </p>

      {okMsg && (
        <p className="text-xs mb-3" style={{ color: "var(--safe)" }}>
          {okMsg}
        </p>
      )}
      {error && (
        <p className="text-xs mb-3" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}

      <div className="flex flex-col gap-4">
        {items.map((p) => {
          const aiRec = p.eligible === 1;
          const busy = votingId === p.id;
          return (
            <div
              key={p.id}
              className="rounded-md border p-4"
              style={{ borderColor: "var(--bronze)", background: "var(--surface)" }}
            >
              <div className="flex items-baseline justify-between gap-3">
                <p className="font-display text-base" style={{ color: "var(--text-primary)" }}>
                  {p.amount} BNB
                </p>
                <span className="text-xs" style={{ color: "var(--bronze)" }}>
                  {Math.round(p.confidence * 100)}% conf ·{" "}
                  {p.risk_level ?? "—"}
                </span>
              </div>
              <p className="text-xs text-[var(--text-secondary)] mt-1">
                ke {truncateAddress(p.recipient)} · escrow{" "}
                <code className="text-[10px]">{p.escrow_id.slice(0, 14)}…</code>
              </p>

              <div
                className="mt-3 text-xs px-2 py-1.5 rounded border"
                style={{
                  borderColor: aiRec ? "var(--safe)" : "var(--danger)",
                  color: aiRec ? "var(--safe)" : "var(--danger)",
                }}
              >
                Rekomendasi AI: <strong>{aiRec ? "RELEASE" : "REJECT"}</strong>
                {p.human_reason && (
                  <span className="block text-[var(--text-secondary)] mt-1 normal-case">
                    {p.human_reason}
                  </span>
                )}
              </div>

              <p className="text-sm mt-3 leading-relaxed" style={{ color: "var(--text-primary)" }}>
                {p.reasoning}
              </p>

              <div className="flex gap-2 mt-4">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => vote(p.escrow_id, true)}
                  className="flex-1 rounded-md px-3 py-2 text-sm font-medium disabled:opacity-40"
                  style={{ background: "var(--safe)", color: "var(--surface)" }}
                >
                  {busy ? "Memproses…" : "Setujui (release)"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => vote(p.escrow_id, false)}
                  className="flex-1 rounded-md px-3 py-2 text-sm font-medium disabled:opacity-40"
                  style={{ background: "var(--danger)", color: "var(--surface)" }}
                >
                  {busy ? "Memproses…" : "Tolak (revert)"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
