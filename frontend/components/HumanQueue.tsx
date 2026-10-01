"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { fetchJson, shortApiMessage } from "@/lib/api";
import { truncateAddress } from "@/lib/utils";
import { useDebateStream } from "@/components/DebateStream";

export interface PendingHuman {
  id: number;
  escrow_id: string;
  sender: string;
  recipient: string;
  amount: string;
  eligible: number;
  confidence: number;
  risk_level: string;
  reasoning: string;
  human_reason?: string;
  decision?: string;
  created_at?: number;
}

interface HumanQueueEnvelope {
  success: boolean;
  data: PendingHuman[];
  error?: string;
}

interface VoteEnvelope {
  success: boolean;
  data?: {
    escrowId: string;
    decision: string;
    txHash: string;
  };
  error?: string;
}

interface HumanQueueValue {
  items: PendingHuman[];
  total: number;
  loading: boolean;
  error: string | null;
  okMsg: string | null;
  votingId: number | null;
  vote: (escrowId: string, approve: boolean) => Promise<void>;
}

const HumanQueueContext = createContext<HumanQueueValue | null>(null);

const POLL_MS = 3000;

function dedupeByEscrow(arr: PendingHuman[]): PendingHuman[] {
  const seen = new Set<string>();
  const out: PendingHuman[] = [];
  for (const item of arr) {
    if (!item.escrow_id || seen.has(item.escrow_id)) continue;
    seen.add(item.escrow_id);
    out.push(item);
  }
  return out;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function HumanQueueProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<PendingHuman[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [votingId, setVotingId] = useState<number | null>(null);

  const aliveRef = useRef(true);
  const okTimer = useRef<NodeJS.Timeout | null>(null);

  const clearOk = useCallback(() => {
    if (okTimer.current) clearTimeout(okTimer.current);
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      clearOk();
    };
  }, [clearOk]);

  const load = useCallback(async () => {
    try {
      const json = await fetchJson<HumanQueueEnvelope>("/api/human/pending");
      if (!aliveRef.current) return;
      if (!json.success) {
        setError(json.error ?? "Failed to load the manual review queue.");
        return;
      }
      setItems(dedupeByEscrow(json.data ?? []));
      setError(null);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(shortApiMessage(err));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    async function initial() {
      await load();
    }

    void initial();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const vote = useCallback(
    async (escrowId: string, approve: boolean) => {
      setVotingId(items.find((i) => i.escrow_id === escrowId)?.id ?? null);
      setError(null);
      clearOk();
      setOkMsg(null);
      try {
        const json = await fetchJson<VoteEnvelope>("/api/human/vote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ escrowId, approve }),
        });
        if (!json.success || !json.data) {
          setError(json.error ?? "Failed to send the decision to the backend.");
          return;
        }
        setOkMsg(
          `${approve ? "Transfer approved & forwarded" : "Transfer cancelled & funds refunded"} — tx ${String(json.data.txHash).slice(0, 18)}...`
        );
        okTimer.current = setTimeout(() => setOkMsg(null), 6000);
        await load();
      } catch (err) {
        setError(shortApiMessage(err));
      } finally {
        setVotingId(null);
      }
    },
    [items, load, clearOk]
  );

  const value = useMemo<HumanQueueValue>(
    () => ({ items, total: items.length, loading, error, okMsg, votingId, vote }),
    [items, loading, error, okMsg, votingId, vote]
  );

  return <HumanQueueContext.Provider value={value}>{children}</HumanQueueContext.Provider>;
}

export function useHumanQueue(): HumanQueueValue {
  const ctx = useContext(HumanQueueContext);
  if (!ctx) {
    throw new Error("useHumanQueue must be used inside <HumanQueueProvider>");
  }
  return ctx;
}

export function useHeldItem(): PendingHuman | null {
  const { items } = useHumanQueue();
  const { sessionEvents } = useDebateStream();

  return useMemo(() => {
    const hold = [...sessionEvents]
      .reverse()
      .find((e) => e.phase === "human" && e.status !== "done");
    if (hold?.escrowId) {
      const match = items.find((i) => i.escrow_id === hold.escrowId);
      if (match) return match;
    }
    return items[0] ?? null;
  }, [items, sessionEvents]);
}

/** Shared decision card */
export function HumanVoteCard({
  item,
  busy,
  onVote,
  showActions = true,
}: {
  item: PendingHuman;
  busy: boolean;
  onVote: (escrowId: string, approve: boolean) => void;
  showActions?: boolean;
}) {
  const aiRec = item.eligible === 1;

  return (
    <article className="pending-card">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="font-display text-lg font-bold text-ink">{item.amount} BNB</p>
        <span className="badge badge-bronze text-[11px] font-mono">
          Confidence: {Math.round(item.confidence * 100)}%
        </span>
      </div>

      <p className="text-muted mt-1.5 text-xs">
        To: <span className="font-mono text-ink font-semibold">{truncateAddress(item.recipient)}</span>
        {item.created_at && <> · {formatTimestamp(item.created_at)}</>}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className={aiRec ? "tag tag-safe" : "tag tag-danger"}>
          AI Recommendation: {aiRec ? "PROCEED ADVISED" : "CANCEL ADVISED"}
        </span>
        {item.risk_level && <span className="tag">Risk Level: {item.risk_level}</span>}
      </div>

      {item.human_reason && (
        <p className="text-ink mt-2.5 text-xs leading-relaxed bg-amber-500/[0.08] p-3 rounded-xl border border-amber-500/20">
          {item.human_reason}
        </p>
      )}

      <p className="text-ink mt-3 text-xs leading-relaxed whitespace-pre-line font-mono bg-black/[0.02] p-2.5 rounded-lg border border-black/5">
        {item.reasoning}
      </p>

      {showActions && (
        <div className="mt-4 flex gap-2.5 pt-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => onVote(item.escrow_id, true)}
            className="btn btn-safe flex-1 font-bold"
          >
            {busy ? "Processing..." : "✓ Approve (Release Funds)"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onVote(item.escrow_id, false)}
            className="btn btn-danger flex-1 font-bold"
          >
            {busy ? "Processing..." : "✕ Reject (Refund Sender)"}
          </button>
        </div>
      )}
    </article>
  );
}

function HumanDecisionModal({
  item,
  total,
  busy,
  error,
  onVote,
}: {
  item: PendingHuman;
  total: number;
  busy: boolean;
  error: string | null;
  onVote: (escrowId: string, approve: boolean) => void;
}) {
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  return (
    <div
      className="decision-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="decision-modal-title"
    >
      <div className="decision-modal bg-white border border-black/20 shadow-2xl">
        <div className="card-head bg-black/[0.02] border-b border-black/10 px-6 py-4">
          <div>
            <p className="eyebrow text-amber-800">Transaction On Hold</p>
            <p id="decision-modal-title" className="font-display mt-1 text-xl font-bold text-ink">
              Your Decision Is Required
            </p>
          </div>
          {total > 1 && <span className="badge badge-bronze">1 of {total}</span>}
        </div>

        <div className="card-pad p-6">
          <p className="text-muted mb-4 text-xs leading-relaxed">
            The transaction is paused at the manual review stage and cannot proceed until you
            decide. Approve to release funds to the recipient, or reject to cancel the
            escrow and refund immediately.
          </p>

          {error && (
            <div className="alert alert-danger mb-4" role="alert">
              <span aria-hidden className="font-bold text-rose-700">✕</span>
              <span>{error}</span>
            </div>
          )}

          <HumanVoteCard item={item} busy={busy} onVote={onVote} />

          <p className="text-muted mt-4 border-t border-[var(--border)] pt-3 text-[11px] leading-relaxed">
            This decision is cryptographically signed and executed on the blockchain.
          </p>
        </div>
      </div>
    </div>
  );
}

export function HumanDecisionLayer() {
  const { total, votingId, vote, error, okMsg } = useHumanQueue();
  const target = useHeldItem();

  if (target) {
    return (
      <HumanDecisionModal
        key={target.escrow_id}
        item={target}
        total={total}
        busy={votingId === target.id}
        error={error}
        onVote={vote}
      />
    );
  }

  if (!okMsg) return null;

  return (
    <div className="decision-dock" role="status">
      <div className="decision-dock-inner">
        <p className="text-ink text-xs font-semibold leading-relaxed flex items-center gap-2">
          <span className="text-emerald-700 font-bold">✓</span>
          {okMsg}
        </p>
      </div>
    </div>
  );
}