"use client";

/**
 * Error boundary untuk segmen ini (Next.js `error.tsx`).
 * Props Next 16: `error` + `retry` (bukan `reset`).
 */
export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <section className="card overflow-hidden" role="alert">
      <div className="card-head">
        <div>
          <p className="eyebrow">Gangguan</p>
          <p className="font-display mt-1 text-xl text-ink">Bagian Ini Gagal Dimuat</p>
        </div>
        <span className="badge badge-danger">Error</span>
      </div>
      <div className="card-pad flex flex-col gap-4">
        <p className="text-muted text-sm leading-relaxed">
          Terjadi kesalahan saat merender halaman. Coba muat ulang bagian ini — bila masih
          gagal, muat ulang seluruh halaman.
        </p>
        <p className="text-ink font-mono text-xs break-words bg-[var(--surface)] p-2 rounded-md border border-[var(--border)]">
          {error.message || "Pesan error tidak tersedia."}
          {error.digest ? <> · digest {error.digest}</> : null}
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-bronze" onClick={() => retry()}>
            Coba Lagi
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => window.location.reload()}
          >
            Muat Ulang Halaman
          </button>
        </div>
      </div>
    </section>
  );
}
