// ── Stream bus: pipeline events → SSE clients ─────────────────────────────────────
// Ring buffer + subscriber set. Server SSE only pipes; the pipeline just calls publish().

export type StreamPhase =
  | "escrow"
  | "evidence"
  | "rules"
  | "investigator"
  | "tools"
  | "agent_step"
  | "advocate"
  | "judge"
  | "final"
  | "human"
  | "redteam";

export interface StreamEvent {
  /** Monotonic-ish id per event. */
  ts: number;
  /** Escrow currently being processed (empty when not yet known). */
  escrowId?: string;
  phase: StreamPhase;
  status: "start" | "ok" | "fail" | "skip" | "done";
  /** Short English label for the UI. */
  label: string;
  /** Optional detail (arguments, reason, evidence summary). */
  detail?: string;
  /** Optional structured payload (confidence, eligible, etc). */
  data?: Record<string, unknown>;
}

type Subscriber = (event: StreamEvent) => void;

const subscribers = new Set<Subscriber>();
const BUFFER_MAX = 80;
const buffer: StreamEvent[] = [];

// ── Hearing session archive (per escrow) for the UI history ─────────────────────
const SESSION_MAX = 50;
const SESSION_EVENT_MAX = 160;
const sessions = new Map<string, StreamEvent[]>();

function archive(ev: StreamEvent): void {
  if (!ev.escrowId) return;
  let list = sessions.get(ev.escrowId);
  if (!list) {
    list = [];
    sessions.set(ev.escrowId, list);
  }
  list.push(ev);
  if (list.length > SESSION_EVENT_MAX) {
    list.splice(0, list.length - SESSION_EVENT_MAX);
  }
  // Map keeps insertion order — reset it so the most recently active comes first.
  sessions.delete(ev.escrowId);
  sessions.set(ev.escrowId, list);
  while (sessions.size > SESSION_MAX) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

export interface DebateSession {
  escrowId: string;
  startedAt: number;
  updatedAt: number;
  events: StreamEvent[];
}

/** Hearing session archive, newest first. */
export function getDebateSessions(): DebateSession[] {
  const out: DebateSession[] = [];
  for (const [escrowId, events] of sessions) {
    const first = events[0];
    const last = events[events.length - 1];
    if (!first || !last) continue;
    out.push({
      escrowId,
      startedAt: first.ts,
      updatedAt: last.ts,
      events: [...events],
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

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
  archive(full);

  for (const fn of subscribers) {
    try {
      fn(full);
    } catch {
      // A subscriber error must never break the pipeline
    }
  }
}

/** Subscribe to live events. Returns an unsubscribe function. */
export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** Replay buffer for a newly connected client (SSE on-connect). */
export function getRecentEvents(): StreamEvent[] {
  return [...buffer];
}
