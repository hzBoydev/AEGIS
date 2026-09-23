// ── Stream bus: pipeline events → SSE clients ─────────────────────────────────────
// Ring buffer + subscriber set. Server SSE hanya mem-pipe; pipeline cukup publish().

export type StreamPhase =
  | "escrow"
  | "evidence"
  | "rules"
  | "investigator"
  | "tools"
  | "advocate"
  | "judge"
  | "final"
  | "human"
  | "redteam";

export interface StreamEvent {
  /** Monotonic-ish id per event. */
  ts: number;
  /** Escrow yang sedang diproses (kosong bila belum diketahui). */
  escrowId?: string;
  phase: StreamPhase;
  status: "start" | "ok" | "fail" | "skip" | "done";
  /** Label singkat Bahasa Indonesia untuk UI. */
  label: string;
  /** Detail opsional (argumen, alasan, ringkasan bukti). */
  detail?: string;
  /** Payload terstruktur opsional (confidence, eligible, dll). */
  data?: Record<string, unknown>;
}

type Subscriber = (event: StreamEvent) => void;

const subscribers = new Set<Subscriber>();
const BUFFER_MAX = 80;
const buffer: StreamEvent[] = [];

export function publish(
  event: {
    ts?: number;
    escrowId?: string | undefined;
    phase: StreamPhase;
    status: "start" | "ok" | "fail" | "skip" | "done";
    label: string;
    detail?: string | undefined;
    data?: Record<string, unknown> | undefined;
  }
): void {
  const full: StreamEvent = {
    ts: event.ts ?? Date.now(),
    phase: event.phase,
    status: event.status,
    label: event.label,
    ...(event.escrowId !== undefined ? { escrowId: event.escrowId } : {}),
    ...(event.detail !== undefined ? { detail: event.detail } : {}),
    ...(event.data !== undefined ? { data: event.data } : {}),
  };
  buffer.push(full);
  if (buffer.length > BUFFER_MAX) buffer.shift();

  for (const fn of subscribers) {
    try {
      fn(full);
    } catch {
      // subscriber error tidak boleh merusak pipeline
    }
  }
}

/** Subscribe ke event live. Returns unsubscribe. */
export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** Replay buffer untuk client baru (SSE on-connect). */
export function getRecentEvents(): StreamEvent[] {
  return [...buffer];
}
