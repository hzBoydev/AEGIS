"use client";

import { HumanVoteCard, useHumanQueue } from "@/components/HumanQueue";

export default function HumanReview() {
  const { items, loading, error, okMsg, votingId, vote } = useHumanQueue();

  return (
    <section className="card overflow-hidden">
      <div className="card-head">
        <div>
          <p className="eyebrow">User Control</p>
          <p className="font-display mt-1 text-xl font-bold text-ink">Manual Review (Veto)</p>
          <p className="text-muted mt-1 text-xs leading-relaxed">
            Transactions that need your approval before they execute on-chain
          </p>
        </div>
        {!loading && items.length > 0 && (
          <span className="badge badge-danger">{items.length} Awaiting Decision</span>
        )}
      </div>

      <div className="card-pad">
        {okMsg && (
          <div className="alert alert-safe mb-4" role="status">
            <span aria-hidden className="font-bold text-emerald-700">✓</span>
            <span className="text-xs font-medium">{okMsg}</span>
          </div>
        )}
        {error && (
          <div className="alert alert-danger mb-4" role="alert">
            <span aria-hidden className="font-bold text-rose-700">✕</span>
            <span className="text-xs font-medium">{error}</span>
          </div>
        )}

        {loading && items.length === 0 ? (
          <div className="text-muted flex items-center gap-2 text-sm py-2">
            <span className="h-2 w-2 rounded-full bg-black animate-ping" />
            Loading the manual review queue...
          </div>
        ) : items.length === 0 ? (
          <div className="empty-note">
            <p className="font-bold text-ink mb-1">All Clear & Safe</p>
            No transactions are currently held. If the AI system detects anomalous patterns or low confidence, the transfer will pause here for your manual confirmation.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {items.map((p) => (
              <HumanVoteCard
                key={p.id}
                item={p}
                busy={votingId === p.id}
                onVote={vote}
                showActions={false}
              />
            ))}
            <p className="text-muted text-xs leading-relaxed">
              Decide from the decision dock at the bottom of the screen, or from the
              decision panel inside the Live Verification Monitor.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}