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
import { useDebateStream } from "@/components/DebateStream";
import { formatTimestamp, truncateAddress } from "@/lib/utils";
import { fetchJson, shortApiMessage } from "@/lib/api";

export interface PendingHuman {
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

const POLL_MS = 4000;

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

interface HumanQueueValue {
  items: PendingHuman[];
  total: number;
  loading: boolean;
  error: string | null;
  okMsg: string | null;
  votingId: number | null;
  vote: (escrowId: string, approve: boolean) => Promise<void>;
  refresh: () => Promise<void>;
}

const HumanQueueContext = createContext<HumanQueueValue | null>(null);

/**
 * Single source of truth for the human-in-the-loop queue.
 * One poller is shared by the dashboard card, the floating dock and the
 * live-debate modal, so a HOLD anywhere immediately shows an actionable UI.
 */
export function HumanQueueProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<PendingHuman[]>([]);
  const [loading, setLoading] = useState(true);
  const [votingId, setVotingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const okTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearOk = useCallback(() => {
    if (okTimer.current) {
      clearTimeout(okTimer.current);
      okTimer.current = null;
    }
  }, []);

  useEffect(() => clearOk, [clearOk]);

  const load = useCallback(async () => {
    try {
      const json = await fetchJson<PendingEnvelope>("/api/human/pending");
      if (!json.success) throw new Error(json.error ?? "The review queue could not be loaded.");
      setItems(dedupeByEscrow(json.data ?? []));
      setError(null);
    } catch (err) {
      setError(shortApiMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;

    async function initial() {
      try {
        const json = await fetchJson<PendingEnvelope>("/api/human/pending");
        if (!alive) return;
        if (!json.success) throw new Error(json.error ?? "The review queue could not be loaded.");
        setItems(dedupeByEscrow(json.data ?? []));
        setError(null);
      } catch (err) {
        if (!alive) return;
        setError(shortApiMessage(err));
      } finally {
        if (alive) setLoading(false);
      }
    }

    void initial();
    const t = setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
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
          `${approve ? "Transfer approved & forwarded" : "Transfer cancelled & funds refunded"} — tx ${String(json.data.txHash).slice(0, 18)}…`
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
    () => ({ items, total: items.length, loading, error, okMsg, votingId, vote, refresh: load }),
    [items, loading, error, okMsg, votingId, vote, load]
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

/** Shared decision card — used by the dashboard, the dock and the modal. */
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
        <span className="badge badge-bronze text-[11px]">
          Confidence: {Math.round(item.confidence * 100)}%
        </span>
      </div>

      <p className="text-muted mt-1.5 text-xs">
        To: <span className="font-mono text-ink font-medium">{truncateAddress(item.recipient)}</span>
        {item.created_at && <> · {formatTimestamp(item.created_at)}</>}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className={aiRec ? "tag tag-safe" : "tag tag-danger"}>
          System Recommendation: {aiRec ? "PROCEED ADVISED" : "CANCEL ADVISED"}
        </span>
        {item.risk_level && <span className="tag">Risk Level: {item.risk_level}</span>}
      </div>

      {item.human_reason && (
        <p className="text-muted mt-2 text-xs leading-relaxed bg-[var(--surface)] p-2.5 rounded-lg border border-[var(--border-soft)]">
          {item.human_reason}
        </p>
      )}

      <p className="text-ink mt-3 text-sm leading-relaxed whitespace-pre-line">{item.reasoning}</p>

      {showActions && (
        <div className="mt-4 flex gap-2.5 pt-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => onVote(item.escrow_id, true)}
            className="btn btn-safe flex-1"
          >
            {busy ? "Processing…" : "✓ Approve (Continue)"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onVote(item.escrow_id, false)}
            className="btn btn-danger flex-1"
          >
            {busy ? "Processing…" : "✕ Reject (Refund Funds)"}
          </button>
        </div>
      )}
    </article>
  );
}

/**
 * Focused decision dialog. It opens by itself the moment a transaction hits
 * the human HOLD and cannot be dismissed: the pipeline is blocked until the
 * user approves or rejects.
 */
export function HumanDecisionModal({
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
      <div className="decision-modal">
        <div className="card-head">
          <div>
            <p className="eyebrow">Transaction On Hold</p>
            <p id="decision-modal-title" className="font-display mt-1 text-xl text-ink">
              Your Decision Is Required
            </p>
          </div>
          {total > 1 && <span className="badge badge-bronze">1 of {total}</span>}
        </div>

        <div className="card-pad">
          <p className="text-muted mb-4 text-xs leading-relaxed">
            The pipeline is paused at the manual review stage and cannot continue until you
            decide. Approve to release the funds to the recipient, or reject to cancel the
            escrow and refund the sender.
          </p>

          {error && (
            <div className="alert alert-danger mb-4" role="alert">
              <span aria-hidden className="font-bold">✕</span>
              <span>{error}</span>
            </div>
          )}

          <HumanVoteCard item={item} busy={busy} onVote={onVote} />

          <p className="text-muted mt-4 border-t border-[var(--border)] pt-3 text-[11px] leading-relaxed">
            This decision is final — it is signed by the oracle and submitted on-chain.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Single owner of the human-decision UI: the focused dialog while a HOLD is
 * unresolved, and a short confirmation bar once the decision has been sent.
 */
export function HumanDecisionLayer() {
  const { items, total, votingId, vote, error, okMsg } = useHumanQueue();
  const { sessionEvents } = useDebateStream();

  const target = useMemo(() => {
    const hold = [...sessionEvents]
      .reverse()
      .find((e) => e.phase === "human" && e.status !== "done");
    if (hold?.escrowId) {
      const match = items.find((i) => i.escrow_id === hold.escrowId);
      if (match) return match;
    }
    return items[0] ?? null;
  }, [items, sessionEvents]);

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
        <p className="text-ink text-sm leading-relaxed">
          <span className="text-safe font-semibold">✓ </span>
          {okMsg}
        </p>
      </div>
    </div>
  );
}
