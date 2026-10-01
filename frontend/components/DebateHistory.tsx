"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { DebateEventRow } from "@/components/LiveDebate";
import { StreamEvent } from "@/components/DebateStream";
import { fetchJson, shortApiMessage } from "@/lib/api";
import { truncateAddress } from "@/lib/utils";

const PAGE_SIZE = 10;

interface DebateSession {
  escrowId: string;
  sender: string;
  recipient: string;
  amount: string;
  updatedAt: number;
  events: StreamEvent[];
}

function formatMs(ms: number): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function summarize(s: DebateSession) {
  const finalEv = [...s.events]
    .reverse()
    .find((e) => e.phase === "final" && e.status === "done");
  const hasVote = s.events.some((e) => e.phase === "human");
  const confidence =
    finalEv && typeof finalEv.data?.confidence === "number"
      ? (finalEv.data.confidence as number)
      : null;
  const tone = !finalEv ? "bronze" : finalEv.data?.eligible === true ? "safe" : "danger";
  const label = !finalEv
    ? hasVote
      ? "Awaiting Manual Review"
      : "In Progress"
    : finalEv.data?.eligible === true
    ? "Verification Safe"
    : "Cancelled / Risky";
  const phases = new Set(s.events.map((e) => e.phase));
  return { finalEv, confidence, tone, label, stepCount: s.events.length, phaseCount: phases.size };
}

interface DebatePayload {
  addr: string;
  rows: DebateSession[];
  total: number;
  error?: string;
}

interface DebateApiEnvelope {
  success: boolean;
  data: DebateSession[];
  total?: number;
  error?: string;
}

export default function DebateHistory({ address: addressOverride }: { address?: string }) {
  const { address: walletAddress } = useAccount();
  const address = addressOverride ?? walletAddress;
  const isFiltered = Boolean(addressOverride && addressOverride !== walletAddress);
  const [payload, setPayload] = useState<DebatePayload | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const fresh = payload && address && payload.addr === address ? payload : null;
  const sessions = fresh?.rows ?? [];
  const total = fresh?.total ?? 0;
  const error = fresh?.error ?? null;
  const loading = Boolean(address) && fresh === null;
  const hasMore = total > sessions.length;

  useEffect(() => {
    if (!address) return;
    const addr = address;
    let alive = true;

    async function load() {
      try {
        const json = await fetchJson<DebateApiEnvelope>(
          `/api/debates?limit=${visibleCount}&address=${encodeURIComponent(addr)}`
        );
        if (!alive) return;
        if (json.success) {
          const rows: DebateSession[] = (json.data ?? []).filter(
            (s: DebateSession) => !s.escrowId.startsWith("redteam-")
          );
          setPayload({
            addr,
            rows,
            total: typeof json.total === "number" ? json.total : rows.length,
          });
        } else {
          setPayload({
            addr,
            rows: [],
            total: 0,
            error: json.error ?? "The backend rejected the request.",
          });
        }
      } catch (err) {
        if (!alive) return;
        setPayload({ addr, rows: [], total: 0, error: shortApiMessage(err) });
      }
    }

    void load();
    const t = setInterval(() => {
      void load();
    }, 6000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [visibleCount, address]);

  return (
    <section className="card overflow-hidden">
      <div className="card-head">
        <div>
          <p className="eyebrow">Full Records</p>
          <p className="font-display mt-1 text-xl font-bold text-ink">Transaction Verification Archive</p>
          <p className="text-muted mt-1 text-xs">
            {isFiltered
              ? `Stage-by-stage verification records for address ${truncateAddress(address ?? "")}.`
              : "Stage-by-stage verification records for transactions from your wallet."}
          </p>
        </div>
        {!loading && !error && total > 0 && <span className="badge font-mono">{total} Sessions</span>}
      </div>

      <div className="card-pad flex flex-col gap-3">
        {error && (
          <div className="alert alert-danger" role="alert">
            <span aria-hidden className="font-bold text-rose-700">✕</span>
            <span>{error}</span>
          </div>
        )}

        {!address ? (
          <div className="empty-note">
            Connect your wallet — or search for a specific address above — to see the verification archive.
          </div>
        ) : loading && sessions.length === 0 ? (
          <div className="text-muted flex items-center gap-2 text-sm py-2">
            <span className="h-2 w-2 rounded-full bg-black animate-ping" />
            Loading the verification archive...
          </div>
        ) : sessions.length === 0 && !error ? (
          <div className="empty-note">
            No verification records for this address yet. Send your first token to get started.
          </div>
        ) : (
          sessions.map((s) => {
            const info = summarize(s);
            const expanded = openId === s.escrowId;
            const toneColor =
              info.tone === "safe"
                ? "var(--safe)"
                : info.tone === "danger"
                ? "var(--danger)"
                : "var(--bronze)";

            return (
              <article key={s.escrowId} className="archive-item">
                <button
                  type="button"
                  className="archive-trigger"
                  onClick={() => setOpenId(expanded ? null : s.escrowId)}
                  aria-expanded={expanded}
                >
                  <div className="min-w-0">
                    <p className="text-ink truncate text-sm font-semibold flex items-center gap-2">
                      <span
                        className="h-2 w-2 rounded-full shrink-0"
                        style={{ background: toneColor }}
                      />
                      {info.label}
                    </p>
                    <p className="text-muted mt-1 truncate font-mono text-[11px]">
                      {formatMs(s.updatedAt)} · Escrow {s.escrowId.slice(0, 18)}...
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {info.confidence !== null && (
                      <span className="text-muted text-xs font-mono font-medium">
                        {Math.round(info.confidence * 100)}% confidence
                      </span>
                    )}
                    <span
                      className="badge font-mono text-[10px]"
                      style={{
                        borderColor: toneColor,
                        color: toneColor,
                      }}
                    >
                      {info.phaseCount} Stages · {info.stepCount} Steps
                    </span>
                    <span className="text-muted text-xs font-bold" aria-hidden>
                      {expanded ? "▲" : "▼"}
                    </span>
                  </div>
                </button>

                {expanded && (
                  <div className="archive-panel scroll-thin max-h-72 overflow-y-auto">
                    {s.events.map((ev, i) => (
                      <DebateEventRow
                        key={`${ev.ts}-${i}`}
                        ev={ev}
                        isLast={i === s.events.length - 1}
                        clampDetail
                      />
                    ))}
                  </div>
                )}
              </article>
            );
          })
        )}

        {!loading && hasMore && (
          <div className="mt-2 flex flex-col items-center gap-2 border-t border-[var(--border)] pt-4">
            <button
              type="button"
              className="btn btn-secondary btn-sm font-semibold"
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
            >
              Load More
            </button>
            <p className="text-muted text-[11px] font-mono">
              Showing {sessions.length} of {total} sessions
            </p>
          </div>
        )}
      </div>
    </section>
  );
}