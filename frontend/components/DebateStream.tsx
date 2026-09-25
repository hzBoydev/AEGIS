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
}

const DebateContext = createContext<DebateContextValue | null>(null);

export function DebateStreamProvider({ children }: { children: ReactNode }) {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [sseError, setSseError] = useState<string | null>(null);

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
    // Sesi aktif = semua event ber-escrowId sama dengan event terakhir.
    const last = events[events.length - 1];
    const currentId = last?.escrowId ?? null;
    const sessionEvents = currentId
      ? events.filter((e) => e.escrowId === currentId || !e.escrowId)
      : events;
    const finished = sessionEvents.some((e) => e.phase === "final" && e.status === "done");
    const finalEv = [...sessionEvents]
      .reverse()
      .find((e) => e.phase === "final" && e.status === "done");

    return {
      events,
      connected,
      sseError,
      sessionEvents,
      currentId,
      finished,
      finalEv,
      last,
    };
  }, [events, connected, sseError]);

  return <DebateContext.Provider value={value}>{children}</DebateContext.Provider>;
}

export function useDebateStream(): DebateContextValue {
  const ctx = useContext(DebateContext);
  if (!ctx) {
    throw new Error("useDebateStream harus dipakai di dalam <DebateStreamProvider>");
  }
  return ctx;
}
