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
  const { connected, finished } = useDebateStream();
  if (!connected) return <span className="badge">terputus</span>;
  return finished ? (
    <span className="badge badge-safe">selesai</span>
  ) : (
    <span className="badge badge-bronze">live</span>
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
  const meta = PHASE_META[ev.phase];
  return (
    <div
      className={`py-3 ${isLast ? "" : "border-b border-dashed border-[var(--border)]"}`}
    >
      <div className="flex gap-3">
        <div className="flex w-16 shrink-0 flex-col pt-0.5">
          <span
            className="w-full text-right text-[10px] tracking-wide uppercase"
            style={{ color: meta.tint }}
          >
            {meta.title}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <span
              className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${active ? "pulse" : ""}`}
              style={{ background: statusColor(ev.status) }}
            />
            <div className="min-w-0">
              <p className="text-ink text-sm leading-snug">{ev.label}</p>
              {ev.detail && (
                <p
                  className={`text-muted mt-1 text-xs leading-relaxed break-words ${
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
  /** true = tanpa shell kartu (dipakai di dalam popup). */
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
  } = useDebateStream();
  const listRef = useRef<HTMLDivElement>(null);

  // ── Progress: durasi fase berjalan & total sidang ────────────────────────────
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

  const finalNotice = finalEv ? (
    <div
      className={`notice ${finalEv.data?.eligible === true ? "notice-safe" : "notice-danger"}`}
    >
      <strong>{finalEv.label}</strong>
      {typeof finalEv.data?.confidence === "number" && (
        <span className="ml-2 opacity-80">
          {Math.round((finalEv.data.confidence as number) * 100)}% yakin
        </span>
      )}
      {finalEv.detail && (
        <p className="mt-1 text-xs leading-relaxed opacity-80">{finalEv.detail}</p>
      )}
    </div>
  ) : null;

  const body =
    events.length === 0 ? (
      <div className="card-pad">
        <p className="text-muted text-sm leading-relaxed">
          {connected
            ? "Terhubung ke oracle. Sidang Investigator → Advocate → Judge akan muncul di sini begitu escrow diproses."
            : sseError ?? `Menyambung ke ${API_BASE_URL}/api/stream…`}
        </p>
        {sseError && !connected && (
          <p className="text-danger mt-2 text-xs">
            Pastikan backend berjalan: <code className="code-chip">cd backend && npm run dev</code>
          </p>
        )}
      </div>
    ) : (
      <div
        ref={listRef}
        className="scroll-thin flex max-h-80 flex-col overflow-y-auto px-5 py-1"
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
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 pl-16 text-[11px]">
            <span className="text-muted">
              total berjalan {formatDuration(sessionElapsedSec)}
            </span>
            {running && last && (
              <>
                <span className="pulse text-bronze">
                  {PHASE_META[last.phase].title} sedang berjalan · {phaseElapsedSec} detik
                </span>
                {slowPhase && (
                  <span className="text-muted">
                    model lokal sedang inference — sidang bisa makan 30–60 detik,
                    tunggu sebentar
                  </span>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );

  const chips = (
    <div className="card-foot flex flex-wrap gap-1.5">
      {PHASE_ORDER.map((phase) => {
        const seen = sessionEvents.filter((e) => e.phase === phase);
        const hasFail = seen.some((e) => e.status === "fail");
        const hasOk = seen.some((e) => e.status === "ok" || e.status === "done");
        const running = seen.some((e) => e.status === "start");
        const color = hasFail
          ? "var(--danger)"
          : running
          ? "var(--bronze)"
          : hasOk
          ? "var(--safe)"
          : "var(--text-secondary)";
        const border = hasOk || running || hasFail ? color : "var(--border)";
        return (
          <span
            key={phase}
            className={`chip ${running ? "pulse" : ""}`}
            style={{ borderColor: border, color }}
          >
            {PHASE_META[phase].title}
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
          <p className="eyebrow">Langkah 02</p>
          <p className="font-display mt-1 text-xl text-ink">Sidang AI Live</p>
          {currentId ? (
            <p className="text-muted mt-1 font-mono text-[11px]">
              escrow {currentId.slice(0, 12)}…
            </p>
          ) : (
            <p className="text-muted mt-1 text-xs">Menunggu escrow masuk…</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onOpenPopup && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenPopup}>
              Buka popup
            </button>
          )}
          {!finished && <span className="pulse h-1.5 w-1.5 rounded-full bg-[var(--bronze)]" />}
          <LiveStatusBadge />
        </div>
      </div>
      {content}
    </section>
  );
}
