"use client";

import { useEffect } from "react";
import LiveDebate, { LiveStatusBadge } from "@/components/LiveDebate";
import { useDebateStream } from "@/components/DebateStream";
import { HumanVoteCard, useHeldItem, useHumanQueue } from "@/components/HumanQueue";

interface DebateModalProps {
  open: boolean;
  onClose: () => void;
}

export default function DebateModal({ open, onClose }: DebateModalProps) {
  const { currentId } = useDebateStream();
  const { votingId, vote, error } = useHumanQueue();
  const heldItem = useHeldItem();

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
      <div className="modal-panel bg-white border border-black/15 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="card-head bg-black/[0.02] border-b border-black/10 px-6 py-4">
          <div>
            <p className="eyebrow">Real-Time Inspection</p>
            <p className="font-display mt-1 text-xl font-bold text-ink">Live Verification Monitor</p>
            {currentId ? (
              <p className="text-muted mt-1 font-mono text-[11px]">
                Escrow ID: {currentId.slice(0, 20)}...
              </p>
            ) : (
              <p className="text-muted mt-1 text-xs">
                Waiting for the system to process your escrow transaction...
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            <LiveStatusBadge />
            <button
              type="button"
              className="icon-btn font-bold text-sm"
              onClick={onClose}
              aria-label="Close popup"
            >
              ✕
            </button>
          </div>
        </div>

        {heldItem && (
          <div className="card-pad border-b border-black/10 bg-amber-500/[0.05]">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="eyebrow text-amber-900">Your Decision Is Required</p>
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

        <div className="modal-scroll p-2">
          <LiveDebate bare />
        </div>
      </div>
    </div>
  );
}