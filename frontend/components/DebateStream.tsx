"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { apiUrl } from "@/lib/api";

export interface StreamEvent {
  ts: number;
  escrowId?: string;
  phase:
    | "escrow"
    | "evidence"
    | "rules"
    | "investigator"
    | "tools"
    | "advocate"
    | "judge"
    | "final"
    | "human";
  status: "start" | "ok" | "fail" | "skip" | "done";
  label: string;
  detail?: string;
  data?: Record<string, unknown>;
}

export const PHASE_META: Record<StreamEvent["phase"], { title: string; tint: string }> = {
  escrow: { title: "Escrow", tint: "var(--bronze)" },
  evidence: { title: "Bukti", tint: "var(--bronze)" },
  rules: { title: "Aturan", tint: "var(--bronze)" },
  investigator: { title: "Investigator", tint: "var(--text-primary)" },
  tools: { title: "Tool Calling", tint: "var(--text-primary)" },
  advocate: { title: "Advocate", tint: "var(--danger)" },
  judge: { title: "Judge", tint: "var(--safe)" },
  final: { title: "Putusan", tint: "var(--text-primary)" },
  human: { title: "Manusia", tint: "var(--bronze)" },
};

export const PHASE_ORDER = [
  "escrow",
  "evidence",
  "rules",
  "investigator",
  "tools",
  "advocate",
  "judge",
  "final",
  "human",
] as const;

export function statusColor(status: StreamEvent["status"]): string {
  if (status === "fail") return "var(--danger)";
  if (status === "done") return "var(--safe)";
  if (status === "start") return "var(--bronze)";
  return "var(--text-secondary)";
}

interface DebateContextValue {
  events: StreamEvent[];
  connected: boolean;
  sseError: string | null;
  sessionEvents: StreamEvent[];
  currentId: string | null;
  finished: boolean;
  finalEv: StreamEvent | undefined;
  last: StreamEvent | undefined;
  /** true = sesi baru sudah dimulai tapi belum ada satu pun event masuk. */
  awaitingSession: boolean;
}

/**
 * Penanda sesi baru, dibuat di event handler transaksi (bukan saat render).
 * - key : penanda perubahan; naik tiap transaksi baru.
 * - at  : waktu kirim (ms) — batas bawah ts event yang boleh tampil.
 */
export interface NewSession {
  key: number;
  at: number;
}

/**
 * Batas sesi. Dipasang saat transaksi baru dikirim supaya riwayat sidang lama
 * tidak sempat tampil (sekalipun sepersekian detik) di popup / kartu live.
 * - sinceTs : event backend dengan ts <= ini dianggap milik sesi sebelumnya.
 * - staleId : escrow yang sedang aktif saat reset — event barunya yang datang
 *             belakangan tetap dibuang (escrow lama bisa masih berjalan).
 */
interface SessionEpoch {
  sinceTs: number;
  staleId: string | null;
}

const DebateContext = createContext<DebateContextValue | null>(null);

export function DebateStreamProvider({
  children,
  newSession,
}: {
  children: ReactNode;
  /** Dinaikkan tiap transaksi baru dikirim → sesi sidang di-reset. */
  newSession?: NewSession;
}) {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [sseError, setSseError] = useState<string | null>(null);
  const [epoch, setEpoch] = useState<SessionEpoch | null>(null);
  const [seenSessionKey, setSeenSessionKey] = useState(newSession?.key ?? 0);

  // Reset di fase render: React langsung me-render ulang sebelum commit, jadi
  // tidak ada satu frame pun yang sempat menampilkan riwayat sesi lama.
  // Pakai ts event backend bila ada (jam backend → bebas selisih jam frontend);
  // "at" hanya dipakai saat buffer masih kosong.
  if (newSession && newSession.key !== seenSessionKey) {
    const lastEv = events[events.length - 1];
    setSeenSessionKey(newSession.key);
    setEpoch({
      sinceTs: lastEv ? lastEv.ts : newSession.at,
      staleId: lastEv?.escrowId ?? null,
    });
  }

  useEffect(() => {
    // EventSource hanya di browser (komponen ini "use client").
    const source = new EventSource(apiUrl("/api/stream"));

    source.onopen = () => {
      setConnected(true);
      setSseError(null);
    };
    source.onerror = () => {
      setConnected(false);
      setSseError("Stream terputus — mencoba ulang otomatis…");
    };

    source.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data) as StreamEvent;
        // Sembunyikan event red-team dari UI (suite tetap jalan di backend).
        if ((ev.phase as string) === "redteam") return;
        setEvents((prev) => {
          const next = [...prev, ev];
          return next.length > 60 ? next.slice(next.length - 60) : next;
        });
      } catch {
        // ignore malformed
      }
    };

    return () => {
      source.close();
    };
  }, []);

  const value = useMemo<DebateContextValue>(() => {
    // Sesi aktif = event sesudah batas reset (bila ada) dan bukan escrow lama.
    const active = epoch
      ? events.filter((e) => e.ts > epoch.sinceTs && e.escrowId !== epoch.staleId)
      : events;
    // Sesi = semua event ber-escrowId sama dengan event terakhir.
    const last = active[active.length - 1];
    const currentId = last?.escrowId ?? null;
    const sessionEvents = currentId
      ? active.filter((e) => e.escrowId === currentId || !e.escrowId)
      : active;
    const finished = sessionEvents.some((e) => e.phase === "final" && e.status === "done");
    const finalEv = [...sessionEvents]
      .reverse()
      .find((e) => e.phase === "final" && e.status === "done");

    return {
      events: active,
      connected,
      sseError,
      sessionEvents,
      currentId,
      finished,
      finalEv,
      last,
      awaitingSession: epoch !== null && active.length === 0,
    };
  }, [events, connected, sseError, epoch]);

  return <DebateContext.Provider value={value}>{children}</DebateContext.Provider>;
}

export function useDebateStream(): DebateContextValue {
  const ctx = useContext(DebateContext);
  if (!ctx) {
    throw new Error("useDebateStream harus dipakai di dalam <DebateStreamProvider>");
  }
  return ctx;
}
