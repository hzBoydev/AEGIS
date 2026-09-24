const STEPS = [
  {
    n: "01",
    title: "Kirim",
    desc: "Token masuk ke kontrak escrow, bukan ke dompet penerima.",
  },
  {
    n: "02",
    title: "Periksa",
    desc: "Oracle menjalankan bukti, aturan, dan debat agen AI.",
  },
  {
    n: "03",
    title: "Putuskan",
    desc: "Aman → diteruskan. Meragukan → ditahan untuk veto manusia.",
  },
];

export default function HowItWorks() {
  return (
    <section className="card overflow-hidden">
      <div className="card-head">
        <div>
          <p className="eyebrow">Panduan</p>
          <p className="font-display mt-1 text-lg text-ink">Tata Cara</p>
        </div>
        <span className="badge badge-bronze">3 langkah</span>
      </div>
      <ol className="card-pad flex flex-col gap-4">
        {STEPS.map((s, i) => (
          <li key={s.n} className="flex gap-3.5">
            <span className="step-num w-6 shrink-0 pt-0.5">{s.n}</span>
            <div className={i < STEPS.length - 1 ? "border-b border-dashed border-[var(--border)] pb-4 flex-1" : "flex-1"}>
              <p className="font-display text-[15px] text-ink">{s.title}</p>
              <p className="text-muted mt-1 text-xs leading-relaxed">{s.desc}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
