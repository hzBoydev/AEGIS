"use client";

import { useCallback, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { formatTimestamp, truncateAddress } from "@/lib/utils";
import { fetchJson, shortApiMessage } from "@/lib/api";
import { useVisibleInterval } from "@/lib/hooks";
import { escrowsEnvelopeSchema } from "@/lib/schemas";

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
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (!address) return;
    if (inFlight.current) return;
    inFlight.current = true;
    const addr = address;
    try {
      const json = await fetchJson<EscrowApiEnvelope>(
        `/api/escrows?limit=${limit}&address=${encodeURIComponent(addr)}`,
        undefined,
        escrowsEnvelopeSchema
      );
      setPayload(
        json.success
          ? {
              addr,
              rows: json.data ?? [],
              total:
                typeof json.total === "number" ? json.total : (json.data ?? []).length,
            }
          : { addr, rows: [], total: 0, error: json.error ?? "Permintaan ditolak backend." }
      );
    } catch (err) {
      setPayload({ addr, rows: [], total: 0, error: shortApiMessage(err) });
    } finally {
      inFlight.current = false;
    }
  }, [limit, address]);

  // Polling berhenti otomatis saat tab tidak terlihat (lihat lib/hooks.ts).
  useVisibleInterval(() => {
    void load();
  }, 5000, Boolean(address));

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
          <p className="eyebrow">Catatan On-Chain</p>
          <p className="font-display mt-1 text-xl text-ink">Riwayat Transaksi & Escrow</p>
          <p className="text-muted mt-1 text-xs">
            {isFiltered
              ? `Semua transfer yang melibatkan alamat ${truncateAddress(address ?? "")}.`
              : "Semua transfer yang melibatkan dompet terhubung."}
          </p>
        </div>
        {!loading && !error && total > 0 && (
          <span className="badge">{total} Transaksi</span>
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
            Sambungkan dompet Anda — atau cari alamat mana pun di atas — untuk melihat riwayat transfer.
          </div>
        ) : loading ? (
          <div className="text-muted flex items-center gap-2 text-sm py-2">
            <span className="pulse-bronze h-2 w-2 rounded-full bg-[var(--bronze)]" />
            Memuat riwayat transaksi…
          </div>
        ) : decisions.length === 0 && !error ? (
          <div className="empty-note">
            Belum ada transaksi yang tercatat untuk alamat ini. Kirim token untuk menguji perlindungan Aegis.
          </div>
        ) : decisions.length === 0 ? null : (
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
                  ? "Menunggu Tinjauan Manual"
                  : d.eligible
                  ? "Berhasil Diteruskan"
                  : "Dibatalkan & Dikembalikan";
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
                        Keyakinan: {Math.round(d.confidence * 100)}%
                      </span>
                    </div>
                    <p className="text-muted mt-1 text-xs">
                      Tujuan: <span className="font-mono text-ink">{truncateAddress(d.recipient)}</span>
                      {d.created_at && <> · {formatTimestamp(d.created_at)}</>}
                    </p>
                    <button
                      type="button"
                      className="mt-2.5 block w-full cursor-pointer text-left rounded-lg bg-[var(--surface)] p-2.5 border border-[var(--border)] transition-all hover:border-[var(--bronze)]"
                      onClick={() => setExpandedId(expanded ? null : d.id)}
                      aria-expanded={expanded}
                    >
                      <span
                        className={`text-ink text-xs leading-relaxed ${
                          expanded || !longReason ? "" : "line-clamp-2"
                        }`}
                      >
                        {d.reasoning}
                      </span>
                      {!expanded && longReason && (
                        <span className="text-bronze mt-1 block text-[11px] font-semibold">
                          Lihat selengkapnya ▾
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
                  Muat Lebih Banyak
                </button>
                <p className="text-muted text-[11px]">
                  Menampilkan {decisions.length} dari {total} transaksi
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
