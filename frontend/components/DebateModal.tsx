"use client";

import { useEffect } from "react";
import LiveDebate, { LiveStatusBadge } from "@/components/LiveDebate";
import { useDebateStream } from "@/components/DebateStream";

interface DebateModalProps {
  open: boolean;
  onClose: () => void;
}

export default function DebateModal({ open, onClose }: DebateModalProps) {
  const { currentId } = useDebateStream();

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
      aria-label="Pemantauan Verifikasi Live"
    >
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <div>
            <p className="eyebrow">Sedang Berjalan</p>
            <p className="font-display mt-1 text-xl text-ink">Pemantauan Verifikasi Live</p>
            {currentId ? (
              <p className="text-muted mt-1 font-mono text-[11px]">
                ID Escrow: {currentId.slice(0, 16)}…
              </p>
            ) : (
              <p className="text-muted mt-1 text-xs">
                Menunggu sistem memproses transaksi escrow Anda…
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <LiveStatusBadge />
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Tutup popup">
              ✕
            </button>
          </div>
        </div>
        <div className="modal-scroll">
          <LiveDebate bare />
        </div>
      </div>
    </div>
  );
}
