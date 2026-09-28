"use client";

import { useEffect, useRef, useState } from "react";
import {
  PHASE_META,
  PHASE_ORDER,
  statusColor,
  useDebateStream,
  type StreamEvent,
} from "@/components/DebateStream";
import { API_BASE_URL } from "@/lib/api";
import { formatDuration } from "@/lib/utils";

export function LiveStatusBadge() {
  const { connected, finished, awaitingSession } = useDebateStream();
  if (!connected) return <span className="badge badge-danger">Disconnected</span>;
  if (awaitingSession) return <span className="badge badge-bronze">Awaiting Analysis</span>;
  return finished ? (
    <span className="badge badge-safe">Verification Complete</span>
  ) : (
    <span className="badge badge-bronze">Analyzing</span>
  );
}

export function DebateEventRow({
  ev,
  isLast,
  active = false,
  clampDetail = false,
}: {
  ev: StreamEvent;
  isLast: boolean;
  active?: boolean;
  clampDetail?: boolean;
}) {
  const meta = PHASE_META[ev.phase] || { title: ev.phase, tint: "var(--text-primary)" };
  return (
    <div
      className={`py-3 ${isLast ? "" : "border-b border-dashed border-[var(--border)]"}`}
    >
      <div className="flex gap-3 items-start">
        <div className="flex w-24 shrink-0 flex-col pt-0.5">
          <span
            className="w-full text-left text-[11px] font-semibold tracking-wide"
            style={{ color: meta.tint }}
          >
            {meta.title}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2.5">
            <span
              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${active ? "pulse-bronze" : ""}`}
              style={{ background: statusColor(ev.status) }}
            />
            <div className="min-w-0">
              <p className="text-ink text-sm font-medium leading-snug">{ev.label}</p>
              {ev.detail && (
                <p
                  className={`text-muted mt-1 text-xs leading-relaxed break-words whitespace-pre-line ${
                    clampDetail ? "line-clamp-2" : ""
                  }`}
                >
                  {ev.detail}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface LiveDebateProps {
  bare?: boolean;
  onOpenPopup?: () => void;
}

export default function LiveDebate({ bare = false, onOpenPopup }: LiveDebateProps) {
  const {
    connected,
    sseError,
    sessionEvents,
    currentId,
    finished,
    finalEv,
    last,
    events,
    awaitingSession,
  } = useDebateStream();
  const listRef = useRef<HTMLDivElement>(null);

  const running = !finished && last?.status === "start";
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  const phaseStartedTs = running && last ? last.ts : null;
  const sessionStartedTs = sessionEvents[0]?.ts ?? null;
  const phaseElapsedSec = phaseStartedTs
    ? Math.max(0, Math.floor((now - phaseStartedTs) / 1000))
    : 0;
  const sessionElapsedSec = sessionStartedTs
    ? Math.max(0, Math.floor((now - sessionStartedTs) / 1000))
    : 0;
  const slowPhase = running && phaseElapsedSec >= 20;

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [sessionEvents.length]);

  const isEligible = finalEv?.data?.eligible === true;
  const finalNotice = finalEv ? (
    <div
      className={`notice ${isEligible ? "notice-safe" : "notice-danger"} justify-between flex-wrap gap-2`}
    >
      <div>
        <p className="font-semibold text-sm">
          {isEligible ? "✓ Transaction Declared Safe" : "⚠️ Transaction Requires Attention"}
        </p>
        <p className="text-xs opacity-90 mt-0.5">{finalEv.label}</p>
        {finalEv.detail && (
          <p className="mt-1 text-xs leading-relaxed opacity-85 whitespace-pre-line">{finalEv.detail}</p>
        )}
      </div>
      {typeof finalEv.data?.confidence === "number" && (
        <span className="badge badge-safe self-center">
          Confidence: {Math.round((finalEv.data.confidence as number) * 100)}%
        </span>
      )}
    </div>
  ) : null;

  const body =
    events.length === 0 ? (
      <div className="card-pad">
        <p className="text-muted text-sm leading-relaxed">
          {connected
            ? awaitingSession
              ? "New transaction detected — the system is loading data and starting the stage-by-stage analysis. Progress will appear here automatically."
              : "Connected to the Aegis system. Every new transaction will be analysed here layer by layer automatically."
            : sseError ?? `Connecting to the verification service (${API_BASE_URL})…`}
        </p>
        {sseError && !connected && (
          <p className="text-danger mt-2 text-xs">
            The backend service is not running: start it with <code className="code-chip">cd backend && npm run dev</code>
          </p>
        )}
      </div>
    ) : (
      <div
        ref={listRef}
        className="scroll-thin flex max-h-80 flex-col overflow-y-auto px-5 py-2"
      >
        {sessionEvents.map((ev, i) => (
          <DebateEventRow
            key={`${ev.ts}-${i}`}
            ev={ev}
            isLast={i === sessionEvents.length - 1}
            active={ev.status === "start" && i === sessionEvents.length - 1}
          />
        ))}
        {!finished && sessionEvents.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 pl-28 text-[11px] border-t border-dashed border-[var(--border)] mt-2">
            <span className="text-muted">
              Elapsed: {formatDuration(sessionElapsedSec)}
            </span>
            {running && last && (
              <>
                <span className="text-bronze font-medium">
                  {PHASE_META[last.phase]?.title ?? last.phase} in progress · {phaseElapsedSec}s
                </span>
                {slowPhase && (
                  <span className="text-muted">
                    (Validating on-chain parameters…)
                  </span>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );

  const chips = (
    <div className="card-foot flex flex-wrap gap-2 items-center">
      <span className="text-muted text-[11px] font-semibold uppercase tracking-wider mr-1">Stage:</span>
      {PHASE_ORDER.map((phase) => {
        const seen = sessionEvents.filter((e) => e.phase === phase);
        const hasFail = seen.some((e) => e.status === "fail");
        const hasOk = seen.some((e) => e.status === "ok" || e.status === "done");
        const isRunning = seen.some((e) => e.status === "start");
        const color = hasFail
          ? "var(--danger)"
          : isRunning
          ? "var(--bronze)"
          : hasOk
          ? "var(--safe)"
          : "var(--text-secondary)";
        const border = hasOk || isRunning || hasFail ? color : "var(--border)";
        return (
          <span
            key={phase}
            className={`chip ${isRunning ? "pulse-bronze" : ""}`}
            style={{ borderColor: border, color }}
          >
            {PHASE_META[phase]?.title ?? phase}
          </span>
        );
      })}
    </div>
  );

  const content = (
    <>
      {finalNotice}
      {body}
      {chips}
    </>
  );

  if (bare) return <>{content}</>;

  return (
    <section className="card overflow-hidden">
      <div className="card-head">
        <div>
          <p className="eyebrow">Step 02</p>
          <p className="font-display mt-1 text-xl text-ink">Live Verification Monitor</p>
          {currentId ? (
            <p className="text-muted mt-1 font-mono text-[11px]">
              Escrow ID: {currentId.slice(0, 16)}…
            </p>
          ) : (
            <p className="text-muted mt-1 text-xs">Waiting for an incoming escrow transaction…</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onOpenPopup && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenPopup}>
              Open Full Screen
            </button>
          )}
          {!finished && <span className="pulse-bronze h-2 w-2 rounded-full bg-[var(--bronze)]" />}
          <LiveStatusBadge />
        </div>
      </div>
      {content}
    </section>
  );
}
