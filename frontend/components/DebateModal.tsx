"use client";

import { useEffect, useMemo } from "react";
import LiveDebate, { LiveStatusBadge } from "@/components/LiveDebate";
import { useDebateStream } from "@/components/DebateStream";
import { HumanVoteCard, useHumanQueue } from "@/components/HumanQueue";

interface DebateModalProps {
  open: boolean;
  onClose: () => void;
}

export default function DebateModal({ open, onClose }: DebateModalProps) {
  const { currentId, sessionEvents } = useDebateStream();
  const { items, votingId, vote, error } = useHumanQueue();

  // The pipeline HOLDs at the "human" phase, so the decision belongs right here
  // instead of behind the dashboard card.
  const heldItem = useMemo(() => {
    const hold = [...sessionEvents]
      .reverse()
      .find((e) => e.phase === "human" && e.status !== "done");
    if (hold?.escrowId) {
      const match = items.find((i) => i.escrow_id === hold.escrowId);
      if (match) return match;
    }
    return items[0] ?? null;
  }, [sessionEvents, items]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Live Verification Monitor"
    >
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <div>
            <p className="eyebrow">In Progress</p>
            <p className="font-display mt-1 text-xl text-ink">Live Verification Monitor</p>
            {currentId ? (
              <p className="text-muted mt-1 font-mono text-[11px]">
                Escrow ID: {currentId.slice(0, 16)}…
              </p>
            ) : (
              <p className="text-muted mt-1 text-xs">
                Waiting for the system to process your escrow transaction…
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <LiveStatusBadge />
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close popup">
              ✕
            </button>
          </div>
        </div>

        {heldItem && (
          <div className="card-pad hold-panel">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="eyebrow">Your Decision Is Required</p>
              <p className="text-muted text-[11px]">
                The pipeline is paused until you decide
              </p>
            </div>
            {error && (
              <p className="text-danger mb-3 text-xs font-semibold" role="alert">
                {error}
              </p>
            )}
            <HumanVoteCard
              item={heldItem}
              busy={votingId === heldItem.id}
              onVote={vote}
            />
          </div>
        )}

        <div className="modal-scroll">
          <LiveDebate bare />
        </div>
      </div>
    </div>
  );
}
