"use client";

import { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import { formatTimestamp, truncateAddress } from "@/lib/utils";
import { fetchJson, shortApiMessage } from "@/lib/api";

interface Decision {
  id: number;
  recipient: string;
  amount: string;
  eligible: number;
  confidence: number;
  reasoning: string;
  status?: string;
  created_at: string;
}

const PAGE_SIZE = 5;

interface HistoryPayload {
  addr: string;
  rows: Decision[];
  total: number;
  error?: string;
}

interface EscrowApiEnvelope {
  success: boolean;
  data: Decision[];
  total?: number;
  error?: string;
}

function useEscrowHistory(limit: number, address: string | undefined) {
  const [payload, setPayload] = useState<HistoryPayload | null>(null);

  useEffect(() => {
    if (!address) return;
    const addr = address;
    let alive = true;

    async function fetchData() {
      try {
        const json = await fetchJson<EscrowApiEnvelope>(
          `/api/escrows?limit=${limit}&address=${encodeURIComponent(addr)}`
        );
        if (!alive) return;
        setPayload(
          json.success
            ? {
                addr,
                rows: json.data ?? [],
                total:
                  typeof json.total === "number"
                    ? json.total
                    : (json.data ?? []).length,
              }
            : { addr, rows: [], total: 0, error: json.error ?? "The backend rejected the request." }
        );
      } catch (err) {
        if (!alive) return;
        setPayload({ addr, rows: [], total: 0, error: shortApiMessage(err) });
      }
    }
    void fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [limit, address]);

  const fresh = payload && address && payload.addr === address ? payload : null;
  return {
    decisions: fresh?.rows ?? [],
    total: fresh?.total ?? 0,
    error: fresh?.error ?? null,
    loading: Boolean(address) && fresh === null,
  };
}

export default function EscrowHistory({ address: addressOverride }: { address?: string }) {
  const { address: walletAddress } = useAccount();
  const address = addressOverride ?? walletAddress;
  const isFiltered = Boolean(addressOverride && addressOverride !== walletAddress);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const { decisions, total, loading, error } = useEscrowHistory(visibleCount, address);
  const hasMore = total > decisions.length;

  return (
    <section className="card overflow-hidden">
      <div className="card-head">
        <div>
          <p className="eyebrow">On-Chain Records</p>
          <p className="font-display mt-1 text-xl text-ink">Transaction &amp; Escrow History</p>
          <p className="text-muted mt-1 text-xs">
            {isFiltered
              ? `Every transfer involving address ${truncateAddress(address ?? "")}.`
              : "Every transfer involving the connected wallet."}
          </p>
        </div>
        {!loading && !error && total > 0 && (
          <span className="badge">{total} Transactions</span>
        )}
      </div>

      <div className="card-pad">
        {error && (
          <div className="alert alert-danger mb-4" role="alert">
            <span aria-hidden>✕</span>
            <span>{error}</span>
          </div>
        )}

        {!address ? (
          <div className="empty-note">
            Connect your wallet — or search for any address above — to see the transfer history.
          </div>
        ) : loading ? (
          <div className="text-muted flex items-center gap-2 text-sm py-2">
            <span className="pulse-bronze h-2 w-2 rounded-full bg-[var(--bronze)]" />
            Loading transaction history…
          </div>
        ) : decisions.length === 0 ? (
          <div className="empty-note">
            No transactions recorded for this address yet. Send a token to test Aegis protection.
          </div>
        ) : (
          <>
            <ol className="timeline">
              {decisions.map((d) => {
                const pending = d.status === "pending_human";
                const tone = pending
                  ? "var(--bronze)"
                  : d.eligible
                  ? "var(--safe)"
                  : "var(--danger)";
                const label = pending
                  ? "Awaiting Manual Review"
                  : d.eligible
                  ? "Successfully Forwarded"
                  : "Cancelled &amp; Refunded";
                const expanded = expandedId === d.id;
                const longReason = d.reasoning.length > 90;

                return (
                  <li
                    key={d.id}
                    className="timeline-item"
                    style={{ "--dot-color": tone } as React.CSSProperties}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <p className="font-display text-lg font-bold text-ink">
                        {d.amount} BNB{" "}
                        <span className="font-sans text-xs font-semibold px-2 py-0.5 rounded-full ml-1" style={{ color: tone, background: `color-mix(in srgb, ${tone} 12%, transparent)` }}>
                          {label}
                        </span>
                      </p>
                      <span className="text-muted text-xs whitespace-nowrap">
                        Confidence: {Math.round(d.confidence * 100)}%
                      </span>
                    </div>
                    <p className="text-muted mt-1 text-xs">
                      To: <span className="font-mono text-ink">{truncateAddress(d.recipient)}</span>
                      {d.created_at && <> · {formatTimestamp(d.created_at)}</>}
                    </p>
                    <button
                      type="button"
                      className="mt-2.5 block w-full cursor-pointer text-left rounded-lg bg-[var(--surface)] p-2.5 border border-[var(--border)] transition-all hover:border-[var(--bronze)]"
                      onClick={() => setExpandedId(expanded ? null : d.id)}
                      aria-expanded={expanded}
                    >
                      <span
                        className={`text-ink text-xs leading-relaxed whitespace-pre-line ${
                          expanded || !longReason ? "" : "line-clamp-2"
                        }`}
                      >
                        {d.reasoning}
                      </span>
                      {!expanded && longReason && (
                        <span className="text-bronze mt-1 block text-[11px] font-semibold">
                          See more ▾
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ol>

            {hasMore && (
              <div className="mt-6 flex flex-col items-center gap-2 border-t border-[var(--border)] pt-4">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                >
                  Load More
                </button>
                <p className="text-muted text-[11px]">
                  Showing {decisions.length} of {total} transactions
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
