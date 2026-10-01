"use client";

import { useEffect, useRef, useState } from "react";
import {
  PHASE_META,
  PHASE_ORDER,
  StreamEvent,
  statusColor,
  useDebateStream,
} from "@/components/DebateStream";
import { API_BASE_URL } from "@/lib/api";

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

// ── Humanise technical labels from the backend ────────────────────────────────
const LABEL_MAP: Record<string, string> = {
  "Investigator: supports RELEASE": "🔍 Investigator — Recommends Release",
  "Investigator: supports REJECT": "🔍 Investigator — Recommends Reject",
  "Investigator (update): supports RELEASE": "🔍 Investigator (updated) — Recommends Release",
  "Investigator (update): supports REJECT": "🔍 Investigator (updated) — Recommends Reject",
  "Judge: RULING RELEASE": "⚖️ Judge — Rules: Release Funds",
  "Judge: RULING REJECT": "⚖️ Judge — Rules: Return Funds",
  "REJECTED (hard rule)": "🚫 Blocked by Security Rule",
  "REJECTED (fail-safe)": "🛡️ Blocked — AI Uncertainty",
  "REJECTED (low confidence)": "🛡️ Blocked — Low Confidence",
  "HOLD — not a final ruling": "⏸️ Held for Human Review",
  "Waiting for human veto": "👤 Awaiting Human Decision",
  "RELEASED": "✅ Funds Released",
  "RETURNED": "↩️ Funds Returned to Sender",
  "Collecting GoPlus + BscScan evidence": "🌐 Gathering On-Chain Intelligence",
  "Investigator assessing the case": "🤖 AI Investigator Starting Analysis",
  "Investigator second round (additional evidence)": "🔄 Re-analysing with Extra Evidence",
  "Judge weighing the evidence + both opinions": "⚖️ Judge Reviewing All Arguments",
  "Explaining the hard rule rejection": "📝 Generating Human-Readable Explanation",
  "All tools failed": "⚠️ External Data Sources Unavailable",
};

function humaniseLabel(raw: string): string {
  if (LABEL_MAP[raw]) return LABEL_MAP[raw];
  if (raw.startsWith("Advocate arguing for position"))
    return "🗣️ Advocate Building Counter-Argument";
  if (raw.startsWith("Advocate:"))
    return `🗣️ Advocate — ${raw.replace("Advocate:", "").trim()}`;
  if (raw.startsWith("GoPlus"))
    return `🔒 GoPlus Check — ${raw.replace("GoPlus", "").trim()}`;
  if (raw.startsWith("Tool calling:"))
    return "🛠️ Fetching Additional Evidence";
  if (raw.startsWith("REJECTED (GoPlus"))
    return "🚫 Blocked — GoPlus Threat Detected";
  if (raw.startsWith("Second round failed"))
    return "⚠️ Second Round Unavailable — Using Initial Assessment";
  return raw;
}

// ── Parse AI prose into bullet sentences ─────────────────────────────────────
function parseReasonBullets(text: string): string[] {
  if (!text) return [];
  const cleaned = text.replace(/\r?\n/g, " ").trim();
  const sentences = cleaned
    .split(/\.\s+/)
    .map((s) => s.trim().replace(/\.$/, ""))
    .filter((s) => s.length > 12);
  return sentences;
}

// ── Structured reason renderer ────────────────────────────────────────────────
function ReasonDisplay({ text, clamp = false }: { text: string; clamp?: boolean }) {
  const bullets = parseReasonBullets(text);
  if (bullets.length <= 1) {
    return (
      <p className={`text-muted mt-1 text-xs leading-relaxed break-words ${clamp ? "line-clamp-2" : ""}`}>
        {text}
      </p>
    );
  }
  const visible = clamp ? bullets.slice(0, 2) : bullets;
  return (
    <ul className="mt-1.5 space-y-1">
      {visible.map((point, i) => (
        <li key={i} className="flex items-start gap-1.5">
          <span className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-black/25" />
          <span className="text-muted text-xs leading-relaxed">{point}.</span>
        </li>
      ))}
      {clamp && bullets.length > 2 && (
        <li className="text-muted text-[10px] pl-2.5 italic">
          +{bullets.length - 2} more points…
        </li>
      )}
    </ul>
  );
}

// ── Phase icon map ────────────────────────────────────────────────────────────
function PhaseIcon({ phase }: { phase: StreamEvent["phase"] }) {
  const icons: Record<string, string> = {
    escrow: "📋",
    evidence: "🌐",
    rules: "📏",
    investigator: "🔍",
    tools: "🛠️",
    advocate: "🗣️",
    judge: "⚖️",
    final: "🏁",
    human: "👤",
    redteam: "🔴",
  };
  return <span className="text-[12px] leading-none">{icons[phase] ?? "•"}</span>;
}

// ── Status badge ──────────────────────────────────────────────────────────────
export function LiveStatusBadge() {
  const { connected, finished, events } = useDebateStream();
  if (!connected) return <span className="badge badge-danger">Offline</span>;
  if (events.length === 0) return <span className="badge badge-bronze">Idle</span>;
  return finished ? (
    <span className="badge badge-safe">Verification Complete</span>
  ) : (
    <span className="badge badge-bronze flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-full bg-black animate-ping" />
      Analyzing
    </span>
  );
}

// ── Individual event row ──────────────────────────────────────────────────────
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
  const friendlyLabel = humaniseLabel(ev.label);

  // Long prose from AI agents → bullet treatment
  const isAIProse =
    !!ev.detail &&
    ev.detail.length > 80 &&
    (ev.phase === "investigator" ||
      ev.phase === "judge" ||
      ev.phase === "advocate" ||
      ev.phase === "final");

  return (
    <div className={`py-3 ${isLast ? "" : "border-b border-dashed border-[var(--border)]"}`}>
      <div className="flex gap-3 items-start">
        {/* Phase column */}
        <div className="flex w-24 shrink-0 flex-col items-start pt-0.5 gap-0.5">
          <div className="flex items-center gap-1">
            <PhaseIcon phase={ev.phase} />
            <span
              className="text-[10px] font-bold tracking-wide uppercase font-mono"
              style={{ color: meta.tint }}
            >
              {meta.title}
            </span>
          </div>
        </div>

        {/* Content column */}
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2.5">
            <span
              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${active ? "animate-ping bg-black" : ""}`}
              style={{ background: statusColor(ev.status) }}
            />
            <div className="min-w-0 flex-1">
              <p className="text-ink text-sm font-semibold leading-snug">{friendlyLabel}</p>
              {ev.detail && (
                isAIProse ? (
                  <ReasonDisplay text={ev.detail} clamp={clampDetail} />
                ) : (
                  <p
                    className={`text-muted mt-1 text-xs leading-relaxed break-words whitespace-pre-line font-mono ${
                      clampDetail ? "line-clamp-2" : ""
                    }`}
                  >
                    {ev.detail}
                  </p>
                )
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main LiveDebate component ─────────────────────────────────────────────────
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

  // ── Final verdict card ──────────────────────────────────────────────────────
  const isEligible = finalEv?.data?.eligible === true;
  const confidence =
    typeof finalEv?.data?.confidence === "number"
      ? Math.round((finalEv.data.confidence as number) * 100)
      : null;
  const decidedBy = finalEv?.data?.decidedBy as string | undefined;

  const finalNotice = finalEv ? (
    <div className={`notice ${isEligible ? "notice-safe" : "notice-danger"}`}>
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="text-xl">{isEligible ? "✅" : "🚫"}</span>
          <div>
            <p className="font-bold text-sm leading-tight">
              {isEligible
                ? "Transaction Declared Safe — Funds Released"
                : "Transaction Blocked — Funds Returned to Sender"}
            </p>
            {decidedBy && (
              <p className="text-[10px] font-mono opacity-50 mt-0.5 capitalize">
                Decision by: {decidedBy.replace(/_/g, " ")}
              </p>
            )}
          </div>
        </div>
        {confidence !== null && (
          <span
            className={`badge shrink-0 self-start ${
              isEligible ? "badge-safe" : "badge-danger"
            } font-mono text-[11px]`}
          >
            {confidence}% confidence
          </span>
        )}
      </div>

      {/* AI Reasoning section */}
      {finalEv.detail && (
        <div className="mt-3 pt-3 border-t border-black/10">
          <p className="text-[10px] font-bold uppercase tracking-widest opacity-40 mb-2 font-mono">
            AI Reasoning
          </p>
          <ReasonDisplay text={finalEv.detail} />
        </div>
      )}
    </div>
  ) : null;

  // ── Stream log body ─────────────────────────────────────────────────────────
  const body =
    events.length === 0 ? (
      <div className="card-pad">
        <p className="text-muted text-sm leading-relaxed">
          {connected
            ? awaitingSession
              ? "New transaction detected — loading data and starting the stage-by-stage analysis. Progress will appear here automatically."
              : "Connected to the AEGIS system. Every new transaction will be analysed here layer by layer automatically."
            : sseError ?? `Connecting to the verification service (${API_BASE_URL})...`}
        </p>
        {sseError && !connected && (
          <p className="text-danger mt-2 text-xs">
            The backend service is not running: start it with{" "}
            <code className="font-mono bg-black/5 px-1.5 py-0.5 rounded">
              cd backend &amp;&amp; npm run dev
            </code>
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
            <span className="text-muted font-mono">
              Elapsed: {formatDuration(sessionElapsedSec)}
            </span>
            {running && last && (
              <>
                <span className="text-ink font-semibold flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-black animate-ping" />
                  {PHASE_META[last.phase]?.title ?? last.phase} in progress · {phaseElapsedSec}s
                </span>
                {slowPhase && (
                  <span className="text-muted">(Validating on-chain parameters…)</span>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );

  /* ── 9-Stage pipeline grid ── */
  const stageCards = (
    <div className="card-foot border-t border-black/10 bg-black/[0.015] p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-black/60 font-mono">
          Stage Verification Pipeline
        </p>
        <span className="text-[10px] font-mono text-black/40">9 Layer Security</span>
      </div>

      <div className="stage-card-grid">
        {PHASE_ORDER.map((phase, idx) => {
          const seen = sessionEvents.filter((e) => e.phase === phase);
          const hasFail = seen.some((e) => e.status === "fail");
          const hasOk = seen.some((e) => e.status === "ok" || e.status === "done");
          const isRunning = seen.some((e) => e.status === "start");
          const state = hasFail ? "fail" : isRunning ? "run" : hasOk ? "ok" : "idle";

          return (
            <div
              key={phase}
              className={`stage-card is-${state}`}
              aria-current={isRunning ? "step" : undefined}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="font-mono text-[9px] font-bold text-black/40">
                  {String(idx + 1).padStart(2, "0")}
                </span>
                <span className="flex h-2 w-2 items-center justify-center">
                  {state === "ok" ? (
                    <span className="text-[9px] font-bold text-emerald-700">✓</span>
                  ) : state === "fail" ? (
                    <span className="text-[9px] font-bold text-red-700">✕</span>
                  ) : state === "run" ? (
                    <span className="h-2 w-2 rounded-full bg-black animate-ping" />
                  ) : (
                    <span className="h-1.5 w-1.5 rounded-full bg-black/20" />
                  )}
                </span>
              </div>
              <div className="mt-1">
                <p className="text-[11px] font-bold text-black leading-tight truncate">
                  {PHASE_META[phase]?.title ?? phase}
                </p>
                <p className="text-[9px] font-mono capitalize mt-0.5 text-black/50 truncate">
                  {state === "run"
                    ? "Analyzing…"
                    : state === "ok"
                    ? "Verified"
                    : state === "fail"
                    ? "Flagged"
                    : "Pending"}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  const content = (
    <>
      {finalNotice}
      {body}
      {stageCards}
    </>
  );

  if (bare) return <>{content}</>;

  return (
    <section className="card overflow-hidden">
      <div className="card-head">
        <div>
          <p className="eyebrow">Step 02</p>
          <p className="font-display mt-1 text-xl font-bold text-ink">Live Verification Monitor</p>
          {currentId ? (
            <p className="text-muted mt-1 font-mono text-[11px]">
              Escrow ID: {currentId.slice(0, 20)}...
            </p>
          ) : (
            <p className="text-muted mt-1 text-xs">Waiting for an incoming escrow transaction...</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onOpenPopup && (
            <button
              type="button"
              className="btn btn-ghost btn-sm text-xs"
              onClick={onOpenPopup}
            >
              Open Full Screen
            </button>
          )}
          <LiveStatusBadge />
        </div>
      </div>
      {content}
    </section>
  );
}
