"use client";

import { useEffect, useRef } from "react";
import LiveDebate, { LiveStatusBadge } from "@/components/LiveDebate";
import { useDebateStream } from "@/components/DebateStream";

interface DebateModalProps {
  open: boolean;
  onClose: () => void;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function DebateModal({ open, onClose }: DebateModalProps) {
  const { currentId } = useDebateStream();
  const panelRef = useRef<HTMLDivElement>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    // Ingat elemen yang aktif sebelum modal dibuka untuk dipulangkan saat tutup.
    const active = document.activeElement;
    lastFocusedRef.current = active instanceof HTMLElement ? active : null;

    const panel = panelRef.current;
    panel?.focus(); // dialog sendiri jadi titik fokus awal

    const getFocusable = (): HTMLElement[] => {
      const root = panelRef.current;
      if (!root) return [];
      return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;

      const items = getFocusable();
      if (items.length === 0) {
        e.preventDefault();
        panelRef.current?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const focused = document.activeElement;
      const inside = focused instanceof Node && panelRef.current?.contains(focused);

      if (e.shiftKey) {
        if (!inside || focused === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (!inside || focused === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = prevOverflow;
      // Pulangkan fokus ke pemicu modal (tombol "Buka Layar Penuh", dll).
      const prev = lastFocusedRef.current;
      if (prev && document.contains(prev)) prev.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Pemantauan Verifikasi Live"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="modal-panel"
        onClick={(e) => e.stopPropagation()}
      >
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
