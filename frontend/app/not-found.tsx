import Link from "next/link";

export default function NotFound() {
  return (
    <main className="shell flex flex-1 flex-col justify-center py-20">
      <section className="card overflow-hidden max-w-xl">
        <div className="card-head">
          <div>
            <p className="eyebrow">404</p>
            <p className="font-display mt-1 text-xl text-ink">Halaman Tidak Ditemukan</p>
          </div>
          <span className="badge">Not Found</span>
        </div>
        <div className="card-pad flex flex-col gap-4">
          <p className="text-muted text-sm leading-relaxed">
            Alamat yang Anda buka tidak tersedia. Kembali ke halaman utama untuk melanjutkan
            ke ruang kendali transaksi.
          </p>
          <div>
            <Link href="/" className="btn btn-bronze inline-flex">
              Kembali ke Beranda
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
