import { ConnectButton } from "@rainbow-me/rainbowkit";

const STEPS = [
  {
    n: "01",
    title: "Kirim ke Escrow",
    desc: "Dana ditahan kontrak cerdas, bukan langsung sampai ke penerima.",
  },
  {
    n: "02",
    title: "Sidang AI",
    desc: "Investigator, Advocate, dan Judge berdebat berdasarkan bukti on-chain.",
  },
  {
    n: "03",
    title: "Veto Manusia",
    desc: "Confidence di zona abu-abu ditahan sampai ada satu suara manusia.",
  },
];

const PIPELINE = [
  "Escrow",
  "Bukti",
  "Aturan",
  "Investigator",
  "Tool Calling",
  "Advocate",
  "Judge",
  "Putusan",
  "Manusia",
];

export default function Hero() {
  return (
    <section className="grid items-start gap-10 py-4 lg:grid-cols-12 lg:gap-14 lg:py-10">
      <div className="lg:col-span-7" data-reveal>
        <p className="eyebrow">AI Oracle · BSC Testnet</p>
        <h1 className="font-display mt-4 text-4xl leading-[1.05] tracking-tight sm:text-5xl lg:text-[3.4rem]">
          Perisai bagi
          <br />
          <span className="text-gradient">transaksimu.</span>
        </h1>
        <p className="text-muted mt-5 max-w-md text-[15px] leading-relaxed">
          Setiap transfer dijaga oleh AI Oracle sebelum dana sampai ke penerima —
          escrow, sidang multi-agen, dan veto manusia dalam satu alur.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-4">
          <ConnectButton />
          <span className="text-muted text-xs">Sambungkan wallet untuk mulai bertransaksi.</span>
        </div>

        <ol className="mt-10 grid gap-3 sm:grid-cols-3">
          {STEPS.map((s) => (
            <li key={s.n} className="tile">
              <p className="step-num">{s.n}</p>
              <p className="font-display mt-2 text-[15px] text-ink">{s.title}</p>
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
              <p className="eyebrow">Alur kerja</p>
              <p className="font-display mt-1 text-lg text-ink">Pipeline Penjagaan</p>
            </div>
            <span className="badge">{PIPELINE.length} tahap</span>
          </div>

          <ul className="card-pad grid grid-cols-2 gap-2.5">
            {PIPELINE.map((phase, i) => (
              <li key={phase} className="tile flex items-center gap-2.5">
                <span className="step-num">{String(i + 1).padStart(2, "0")}</span>
                <span className="text-xs text-ink">{phase}</span>
              </li>
            ))}
          </ul>

          <div className="card-foot text-muted text-[11px] leading-relaxed">
            Berjalan otomatis setiap escrow masuk — tayangan langsungnya ada di bawah.
          </div>
        </div>
      </div>
    </section>
  );
}
