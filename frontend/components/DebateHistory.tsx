"use client";

import { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import { DebateEventRow } from "@/components/LiveDebate";
import type { StreamEvent } from "@/components/DebateStream";
import { fetchJson, shortApiMessage } from "@/lib/api";
import { truncateAddress } from "@/lib/utils";

interface DebateSession {
  escrowId: string;
  startedAt: number;
  updatedAt: number;
  events: StreamEvent[];
}

const PAGE_SIZE = 5;

function formatMs(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("id-ID", {
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
      ? "Menunggu Tinjauan Manual"
      : "Sedang Berlangsung"
    : finalEv.data?.eligible === true
    ? "Verifikasi Aman"
    : "Dibatalkan / Berisiko";
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
            error: json.error ?? "Permintaan ditolak backend.",
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
          <p className="eyebrow">Catatan Lengkap</p>
          <p className="font-display mt-1 text-xl text-ink">Arsip Verifikasi Transaksi</p>
          <p className="text-muted mt-1 text-xs">
            {isFiltered
              ? `Rekaman tahapan verifikasi untuk alamat ${truncateAddress(address ?? "")}.`
              : "Rekaman tahapan verifikasi untuk transaksi dari dompet Anda."}
          </p>
        </div>
        {!loading && !error && total > 0 && <span className="badge">{total} Sesi</span>}
      </div>

      <div className="card-pad flex flex-col gap-3">
        {error && (
          <div className="alert alert-danger" role="alert">
            <span aria-hidden>✕</span>
            <span>{error}</span>
          </div>
        )}

        {!address ? (
          <div className="empty-note">
            Sambungkan dompet Anda — atau cari alamat tertentu di atas — untuk melihat arsip verifikasi.
          </div>
        ) : loading && sessions.length === 0 ? (
          <div className="text-muted flex items-center gap-2 text-sm py-2">
            <span className="pulse-bronze h-2 w-2 rounded-full bg-[var(--bronze)]" />
            Memuat arsip verifikasi…
          </div>
        ) : sessions.length === 0 && !error ? (
          <div className="empty-note">
            Belum ada arsip verifikasi untuk alamat ini. Kirim token pertama Anda untuk memulai.
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
                      {formatMs(s.updatedAt)} · Escrow {s.escrowId.slice(0, 16)}…
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {info.confidence !== null && (
                      <span className="text-muted text-xs font-medium">
                        {Math.round(info.confidence * 100)}% Yakin
                      </span>
                    )}
                    <span
                      className="badge"
                      style={{
                        borderColor: toneColor,
                        color: toneColor,
                        background: `color-mix(in srgb, ${toneColor} 12%, var(--surface-glass))`,
                      }}
                    >
                      {info.phaseCount} Tahap · {info.stepCount} Langkah
                    </span>
                    <span className="text-muted text-xs font-bold" aria-hidden>
                      {expanded ? "▴" : "▾"}
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
              className="btn btn-ghost btn-sm"
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
            >
              Muat Lebih Banyak
            </button>
            <p className="text-muted text-[11px]">
              Menampilkan {sessions.length} dari {total} sesi
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
