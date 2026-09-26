import React from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";

const STEPS = [
  {
    n: "01",
    title: "Brankas Pengaman",
    desc: "Dana disimpan di smart contract escrow, tidak langsung terkirim ke tujuan sebelum dipastikan aman.",
  },
  {
    n: "02",
    title: "Analisis Otomatis",
    desc: "Sistem memeriksa reputasi alamat, riwayat transaksi, dan parameter keamanan secara langsung.",
  },
  {
    n: "03",
    title: "Kendali Penuh",
    desc: "Bila terdeteksi indikasi risiko, pengiriman ditahan dan Anda bisa membatalkannya kapan saja.",
  },
];

const PIPELINE = [
  { name: "Escrow", sub: "Dana Diamankan" },
  { name: "Bukti", sub: "Riwayat On-Chain" },
  { name: "Aturan", sub: "Standar Keamanan" },
  { name: "Investigator", sub: "Pola Transaksi" },
  { name: "Tool Calling", sub: "Validasi Lanjutan" },
  { name: "Advocate", sub: "Evaluasi Konteks" },
  { name: "Judge", sub: "Skor Keamanan" },
  { name: "Putusan", sub: "Hasil Verifikasi" },
  { name: "Manusia", sub: "Persetujuan Manual" },
];

export default function Hero() {
  return (
    <section className="grid items-start gap-10 py-4 lg:grid-cols-12 lg:gap-14 lg:py-8">
      <div className="lg:col-span-7" data-reveal>
        <div className="flex items-center gap-2">
          <span className="badge badge-bronze">Proteksi Aktif</span>
          <span className="text-muted text-xs">BSC Testnet</span>
        </div>

        <h1 className="font-display mt-4 text-4xl leading-[1.08] tracking-tight sm:text-5xl lg:text-[3.2rem]">
          Perisai pintar untuk
          <br />
          <span className="text-gradient">transaksi kripto Anda.</span>
        </h1>

        <p className="text-muted mt-5 max-w-lg text-[15px] leading-relaxed">
          Kirim token tanpa rasa was-was. Setiap transfer diamankan di brankas escrow pintar
          dan diverifikasi secara otomatis sebelum dana diteruskan ke penerima.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-4">
          <ConnectButton />
          <span className="text-muted text-xs">Sambungkan dompet Web3 Anda untuk memulai.</span>
        </div>

        <ol className="mt-10 grid gap-3 sm:grid-cols-3">
          {STEPS.map((s) => (
            <li key={s.n} className="tile">
              <p className="step-num">{s.n}</p>
              <p className="font-display mt-2 text-[15px] font-semibold text-ink">{s.title}</p>
              <p className="text-muted mt-1.5 text-xs leading-relaxed">{s.desc}</p>
            </li>
          ))}
        </ol>
      </div>

      <div
        className="lg:col-span-5"
        data-reveal
        style={{ "--reveal-delay": "0.12s" } as React.CSSProperties}
      >
        <div className="card overflow-hidden">
          <div className="card-head">
            <div>
              <p className="eyebrow">Alur Perlindungan</p>
              <p className="font-display mt-1 text-lg text-ink">Langkah Kerja Otomatis</p>
            </div>
            <span className="badge badge-safe">9 Tahap</span>
          </div>

          <ul className="card-pad grid grid-cols-2 gap-2.5">
            {PIPELINE.map((p, i) => (
              <li key={p.name} className="tile flex flex-col justify-center p-3">
                <div className="flex items-center justify-between">
                  <span className="step-num text-xs">{String(i + 1).padStart(2, "0")}</span>
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--bronze)] opacity-60" />
                </div>
                <p className="mt-1 text-xs font-semibold text-ink">{p.name}</p>
                <p className="text-muted text-[10px] truncate">{p.sub}</p>
              </li>
            ))}
          </ul>

          <div className="card-foot flex items-center justify-between text-muted text-[11px] leading-relaxed">
            <span>Berjalan otomatis saat transfer masuk</span>
            <span className="text-bronze font-medium">Transparan & Real-time</span>
          </div>
        </div>
      </div>
    </section>
  );
}
