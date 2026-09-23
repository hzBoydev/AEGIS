"use client";

import { useEffect, useRef, useState } from "react";

interface StreamEvent {
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
    | "human"
    | "redteam";
  status: "start" | "ok" | "fail" | "skip" | "done";
  label: string;
  detail?: string;
  data?: Record<string, unknown>;
}

const PHASE_META: Record<StreamEvent["phase"], { title: string; tint: string }> = {
  escrow: { title: "Escrow", tint: "var(--bronze)" },
  evidence: { title: "Bukti", tint: "var(--bronze)" },
  rules: { title: "Aturan", tint: "var(--bronze)" },
  investigator: { title: "Investigator", tint: "var(--text-primary)" },
  tools: { title: "Tool Calling", tint: "var(--text-primary)" },
  advocate: { title: "Advocate", tint: "var(--danger)" },
  judge: { title: "Judge", tint: "var(--safe)" },
  final: { title: "Putusan", tint: "var(--text-primary)" },
  human: { title: "Manusia", tint: "var(--bronze)" },
  redteam: { title: "Red-Team", tint: "var(--danger)" },
};

function statusColor(status: StreamEvent["status"]): string {
  if (status === "fail") return "var(--danger)";
  if (status === "done") return "var(--safe)";
  if (status === "start") return "var(--bronze)";
  return "var(--text-secondary)";
}

export default function LiveDebate() {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [sseError, setSseError] = useState<string | null>(null);
  const [redteam, setRedteam] = useState<{
    passed: number;
    failed: number;
    total: number;
    mode: string;
  } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // EventSource hanya di browser (komponen ini "use client").
    const source = new EventSource("http://localhost:3001/api/stream");

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
        setEvents((prev) => {
          const next = [...prev, ev];
          return next.length > 60 ? next.slice(next.length - 60) : next;
        });
        if (ev.phase === "redteam" && ev.status === "done" && ev.data) {
          setRedteam({
            passed: Number(ev.data.passed ?? 0),
            failed: Number(ev.data.failed ?? 0),
            total: Number(ev.data.total ?? 0),
            mode: String(ev.data.mode ?? "fast"),
          });
        }
      } catch {
        // ignore malformed
      }
    };

    // Ambil skor red-team terakhir (kalau pernah dijalankan di proses server ini)
    fetch("http://localhost:3001/api/redteam")
      .then((r) => r.json())
      .then((j) => {
        if (j?.data?.total != null) {
          setRedteam({
            passed: j.data.passed,
            failed: j.data.failed,
            total: j.data.total,
            mode: j.data.mode,
          });
        }
      })
      .catch(() => {
        /* backend mungkin belum jalan */
      });

    return () => {
      source.close();
    };
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [events.length]);

  // Sesi aktif = event terakhir sampai phase final done untuk escrow itu,
  // atau semua event ber-escrowId yang sama dengan event terakhir.
  const last = events[events.length - 1];
  const currentId = last?.escrowId ?? null;
  const sessionEvents = currentId
    ? events.filter((e) => e.escrowId === currentId || !e.escrowId)
    : events;
  const finished = sessionEvents.some(
    (e) => e.phase === "final" && e.status === "done"
  );
  const finalEv = [...sessionEvents]
    .reverse()
    .find((e) => e.phase === "final" && e.status === "done");

  const redteamBanner =
    redteam && redteam.total > 0 ? (
      <div
        className="px-5 py-2 border-b text-xs flex items-center justify-between gap-2"
        style={{
          borderColor: "var(--border)",
          color: redteam.failed === 0 ? "var(--safe)" : "var(--danger)",
        }}
      >
        <span>
          Red-team self-test ({redteam.mode}):{" "}
          <strong>
            {redteam.passed}/{redteam.total}
          </strong>{" "}
          lolos
          {redteam.failed > 0 && (
            <span style={{ color: "var(--danger)" }}> · {redteam.failed} gagal</span>
          )}
        </span>
      </div>
    ) : null;

  if (events.length === 0) {
    return (
      <div
        className="mt-14 rounded-md border p-5"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      >
        <div className="flex items-center justify-between mb-3">
          <p className="font-display text-lg" style={{ color: "var(--text-primary)" }}>
            Sidang AI Live
          </p>
          <span
            className="text-xs px-2 py-0.5 rounded-full border"
            style={{
              borderColor: connected ? "var(--safe)" : "var(--border)",
              color: connected ? "var(--safe)" : "var(--text-secondary)",
            }}
          >
            {connected ? "terhubung" : "menyambung…"}
          </span>
        </div>
        <p className="text-sm text-[var(--text-secondary)]">
          {connected
            ? "Terhubung ke oracle. Sidang Investigator → Advocate → Judge akan muncul di sini begitu escrow diproses."
            : sseError ?? "Menyambung ke http://localhost:3001/api/stream…"}
        </p>
        {sseError && !connected && (
          <p className="text-xs mt-2" style={{ color: "var(--danger)" }}>
            Pastikan backend berjalan: <code>cd backend && npm run dev</code>
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      className="mt-14 rounded-md border"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
    >
      <div
        className="flex items-center justify-between px-5 py-4 border-b"
        style={{ borderColor: "var(--border)" }}
      >
        <div>
          <p className="font-display text-lg" style={{ color: "var(--text-primary)" }}>
            Sidang AI Live
          </p>
          {currentId && (
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">
              escrow {currentId.slice(0, 12)}…
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!finished && (
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--bronze)] pulse" />
          )}
          <span
            className="text-xs px-2 py-0.5 rounded-full border"
            style={{
              borderColor: connected ? "var(--safe)" : "var(--border)",
              color: connected ? "var(--safe)" : "var(--text-secondary)",
            }}
          >
            {connected ? (finished ? "selesai" : "live") : "terputus"}
          </span>
        </div>
      </div>

      {redteamBanner}

      {finalEv && (
        <div
          className="px-5 py-3 border-b text-sm"
          style={{
            borderColor: "var(--border)",
            color:
              finalEv.data?.eligible === true ? "var(--safe)" : "var(--danger)",
          }}
        >
          <strong>{finalEv.label}</strong>
          {typeof finalEv.data?.confidence === "number" && (
            <span className="text-[var(--text-secondary)] ml-2">
              {Math.round((finalEv.data.confidence as number) * 100)}% yakin
            </span>
          )}
          {finalEv.detail && (
            <p className="text-[var(--text-secondary)] mt-1 text-xs leading-relaxed">
              {finalEv.detail}
            </p>
          )}
        </div>
      )}

      <div ref={listRef} className="max-h-80 overflow-y-auto px-5 py-4 flex flex-col gap-3">
        {sessionEvents.map((ev, i) => {
          const meta = PHASE_META[ev.phase];
          const isActive = ev.status === "start" && i === sessionEvents.length - 1;
          return (
            <div key={`${ev.ts}-${i}`} className="flex gap-3">
              <div className="flex flex-col items-center pt-1.5 w-16 shrink-0">
                <span
                  className="text-[10px] uppercase tracking-wide text-right w-full"
                  style={{ color: meta.tint }}
                >
                  {meta.title}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start gap-2">
                  <span
                    className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? "pulse" : ""}`}
                    style={{ background: statusColor(ev.status) }}
                  />
                  <div className="min-w-0">
                    <p
                      className="text-sm leading-snug"
                      style={{ color: "var(--text-primary)" }}
                    >
                      {ev.label}
                    </p>
                    {ev.detail && (
                      <p className="text-xs text-[var(--text-secondary)] mt-1 leading-relaxed break-words">
                        {ev.detail}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        {!finished && last?.status === "start" && (
          <p className="text-xs text-[var(--text-secondary)] pl-16 pulse">
            memproses…
          </p>
        )}
      </div>

      {/* Pipeline stage chips */}
      <div
        className="px-5 py-3 border-t flex flex-wrap gap-1.5"
        style={{ borderColor: "var(--border)" }}
      >
        {(
          [
            "escrow",
            "evidence",
            "rules",
            "investigator",
            "tools",
            "advocate",
            "judge",
            "final",
            "human",
            "redteam",
          ] as const
        ).map((phase) => {
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
              className={`text-[10px] px-2 py-0.5 rounded-full border ${running ? "pulse" : ""}`}
              style={{ borderColor: border, color }}
            >
              {PHASE_META[phase].title}
            </span>
          );
        })}
      </div>
    </div>
  );
}
