const STEPS = [
  {
    n: "01",
    title: "1. Kirim ke Brankas Escrow",
    desc: "Ketika Anda mengirim token, dana tidak langsung masuk ke dompet penerima. Kontrak pintar mengamankannya di dalam escrow penampung.",
  },
  {
    n: "02",
    title: "2. Verifikasi Berlapis Otomatis",
    desc: "Sistem AI langsung memindai alamat penerima, memeriksa riwayat on-chain, pola transfer, dan aturan keamanan dalam hitungan detik.",
  },
  {
    n: "03",
    title: "3. Pelepasan / Pembatalan Aman",
    desc: "Jika transaksi diverifikasi aman, dana otomatis diteruskan. Jika ada indikasi bahaya atau keraguan, Anda dapat membatalkannya kapan saja.",
  },
];

export default function HowItWorks() {
  return (
    <section className="card overflow-hidden">
      <div className="card-head">
        <div>
          <p className="eyebrow">Panduan Mudah</p>
          <p className="font-display mt-1 text-xl text-ink">Cara Kerja Perlindungan Aegis</p>
          <p className="text-muted mt-1 text-xs">
            Tiga langkah sederhana bagaimana transfer Anda dijaga dari risiko penipuan
          </p>
        </div>
        <span className="badge badge-bronze">3 Langkah Utama</span>
      </div>
      <div className="card-pad grid gap-4 sm:grid-cols-3">
        {STEPS.map((s) => (
          <div key={s.n} className="tile flex flex-col justify-between">
            <div>
              <span className="step-num text-2xl font-bold">{s.n}</span>
              <p className="font-display mt-2 text-base font-semibold text-ink">{s.title}</p>
              <p className="text-muted mt-2 text-xs leading-relaxed">{s.desc}</p>
            </div>
            <div className="mt-4 pt-3 border-t border-[var(--border)] text-[11px] text-bronze font-medium">
              Proteksi Otomatis
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
