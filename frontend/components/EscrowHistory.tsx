"use client";

import { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import { formatTimestamp, truncateAddress } from "@/lib/utils";

interface Decision {
  id: number;
  escrow_id: string;
  sender: string;
  recipient: string;
  amount: string;
  eligible: number;
  confidence: number;
  reasoning: string;
  tx_hash: string | null;
  status?: string;
  human_vote?: number | null;
  created_at: string;
}

const PAGE_SIZE = 5;

interface HistoryPayload {
  addr: string;
  rows: Decision[];
  total: number;
}

function useEscrowHistory(limit: number, address: string | undefined) {
  // Data selalu "diikat" ke address pengambilannya — saat wallet berganti,
  // payload lama dianggap basi sehingga tampilan kosong tanpa reset state.
  const [payload, setPayload] = useState<HistoryPayload | null>(null);

  useEffect(() => {
    if (!address) return;
    const addr = address;
    let alive = true;

    async function fetchData() {
      try {
        const res = await fetch(
          `http://localhost:3001/api/escrows?limit=${limit}&address=${encodeURIComponent(addr)}`
        );
        const json = await res.json();
        if (!alive) return;
        setPayload(
          json.success
            ? {
                addr,
                rows: json.data,
                total: typeof json.total === "number" ? json.total : json.data.length,
              }
            : { addr, rows: [], total: 0 }
        );
      } catch (err) {
        console.error("Gagal fetch riwayat:", err);
        if (alive) setPayload({ addr, rows: [], total: 0 });
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
    loading: Boolean(address) && fresh === null,
  };
}

export default function EscrowHistory() {
  const { address } = useAccount();
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const { decisions, total, loading } = useEscrowHistory(visibleCount, address);
  const hasMore = total > decisions.length;

  return (
    <section className="card overflow-hidden">
      <div className="card-head">
        <div>
          <p className="eyebrow">Catatan on-chain</p>
          <p className="font-display mt-1 text-xl text-ink">Riwayat</p>
          <p className="text-muted mt-1 text-xs">
            Transfer yang melibatkan dompet terhubung.
          </p>
        </div>
        {!loading && total > 0 && <span className="badge">{total} transaksi</span>}
      </div>

      <div className="card-pad">
        {!address ? (
          <div className="empty-note">
            Sambungkan wallet untuk melihat riwayat transfer dari dompetmu.
          </div>
        ) : loading ? (
          <div className="text-muted flex items-center gap-2 text-sm">
            <span className="pulse h-1.5 w-1.5 rounded-full bg-[var(--bronze)]" />
            Memuat riwayat
          </div>
        ) : decisions.length === 0 ? (
          <div className="empty-note">
            Dompet ini belum punya transaksi yang diperiksa. Kirim token untuk
            melihat Aegis bekerja.
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
                  ? "menunggu veto manusia"
                  : d.eligible
                  ? "diteruskan"
                  : "dikembalikan";
                const expanded = expandedId === d.id;
                const longReason = d.reasoning.length > 90;

                return (
                  <li
                    key={d.id}
                    className="timeline-item"
                    style={{ "--dot-color": tone } as React.CSSProperties}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <p className="font-display text-lg text-ink">
                        {d.amount} BNB{" "}
                        <span className="font-sans text-sm" style={{ color: tone }}>
                          {label}
                        </span>
                      </p>
                      <span className="text-muted text-xs whitespace-nowrap">
                        {Math.round(d.confidence * 100)}% yakin
                      </span>
                    </div>
                    <p className="text-muted mt-1 text-xs">
                      ke {truncateAddress(d.recipient)}
                      {d.created_at && <> · {formatTimestamp(d.created_at)}</>}
                    </p>
                    <button
                      type="button"
                      className="mt-2 block w-full cursor-pointer text-left"
                      onClick={() => setExpandedId(expanded ? null : d.id)}
                      aria-expanded={expanded}
                    >
                      <span
                        className={`text-ink text-sm leading-relaxed ${
                          expanded || !longReason ? "" : "line-clamp-2"
                        }`}
                      >
                        {d.reasoning}
                      </span>
                      {!expanded && longReason && (
                        <span className="text-muted mt-1 block text-[11px]">
                          klik untuk selengkapnya
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
                  Muat lebih banyak
                </button>
                <p className="text-muted text-[11px]">
                  Menampilkan {decisions.length} dari {total}
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
