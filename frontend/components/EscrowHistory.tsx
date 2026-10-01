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
          <p className="font-display mt-1 text-xl font-bold text-ink">Transaction & Escrow History</p>
          <p className="text-muted mt-1 text-xs">
            {isFiltered
              ? `Every transfer involving address ${truncateAddress(address ?? "")}.`
              : "Every transfer involving the connected wallet."}
          </p>
        </div>
        {!loading && !error && total > 0 && (
          <span className="badge font-mono">{total} Transactions</span>
        )}
      </div>

      <div className="card-pad">
        {error && (
          <div className="alert alert-danger mb-4" role="alert">
            <span aria-hidden className="font-bold text-rose-700">✕</span>
            <span>{error}</span>
          </div>
        )}

        {!address ? (
          <div className="empty-note">
            Connect your wallet — or search for any address above — to see the transfer history.
          </div>
        ) : loading ? (
          <div className="text-muted flex items-center gap-2 text-sm py-2">
            <span className="h-2 w-2 rounded-full bg-black animate-ping" />
            Loading transaction history...
          </div>
        ) : decisions.length === 0 ? (
          <div className="empty-note">
            No transactions recorded for this address yet. Send a token to test Aegis protection.
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-3">
              {decisions.map((d) => {
                const pending = d.status === "pending_human";
                const isSafe = d.eligible === 1;
                const label = pending
                  ? "Awaiting Manual Review"
                  : isSafe
                  ? "Successfully Forwarded"
                  : "Cancelled & Refunded";
                const expanded = expandedId === d.id;
                const longReason = d.reasoning.length > 90;

                return (
                  <div
                    key={d.id}
                    className="tile flex flex-col gap-2 p-4"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-display text-lg font-bold text-ink">
                          {d.amount} BNB
                        </span>
                        <span
                          className={`tag font-mono text-[10px] ${
                            pending
                              ? "bg-amber-500/10 text-amber-900 border-amber-500/30"
                              : isSafe
                              ? "tag-safe"
                              : "tag-danger"
                          }`}
                        >
                          {label}
                        </span>
                      </div>
                      <span className="text-muted text-xs font-mono">
                        Confidence: {Math.round(d.confidence * 100)}%
                      </span>
                    </div>
                    <p className="text-muted text-xs">
                      To: <span className="font-mono text-ink font-semibold">{truncateAddress(d.recipient)}</span>
                      {d.created_at && <> · {formatTimestamp(d.created_at)}</>}
                    </p>
                    <button
                      type="button"
                      className="mt-1 block w-full cursor-pointer text-left rounded-lg bg-black/[0.02] p-3 border border-black/5 transition-all hover:border-black/20"
                      onClick={() => setExpandedId(expanded ? null : d.id)}
                      aria-expanded={expanded}
                    >
                      <span
                        className={`text-ink text-xs leading-relaxed whitespace-pre-line font-mono ${
                          expanded || !longReason ? "" : "line-clamp-2"
                        }`}
                      >
                        {d.reasoning}
                      </span>
                      {!expanded && longReason && (
                        <span className="text-black font-semibold mt-1.5 block text-[11px]">
                          See more ▼
                        </span>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>

            {hasMore && (
              <div className="mt-6 flex flex-col items-center gap-2 border-t border-[var(--border)] pt-4">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm font-semibold"
                  onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                >
                  Load More
                </button>
                <p className="text-muted text-[11px] font-mono">
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