import React from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";

const STEPS = [
  {
    n: "01",
    title: "Safety Vault",
    desc: "Funds are held in a smart contract escrow and are never sent straight to the destination until proven safe.",
  },
  {
    n: "02",
    title: "Automatic Analysis",
    desc: "The system checks address reputation, transaction history, and security parameters in real time.",
  },
  {
    n: "03",
    title: "Full Control",
    desc: "If any risk is detected, the transfer is held and you can cancel it at any time.",
  },
];

const PIPELINE = [
  { name: "Escrow", sub: "Funds Secured" },
  { name: "Evidence", sub: "On-Chain History" },
  { name: "Rules", sub: "Security Standards" },
  { name: "Investigator", sub: "Transaction Patterns" },
  { name: "Tool Calling", sub: "Advanced Validation" },
  { name: "Advocate", sub: "Context Evaluation" },
  { name: "Judge", sub: "Security Score" },
  { name: "Verdict", sub: "Verification Result" },
  { name: "Human", sub: "Manual Approval" },
];

export default function Hero() {
  return (
    <section className="grid items-start gap-10 py-4 lg:grid-cols-12 lg:gap-14 lg:py-8">
      <div className="lg:col-span-7" data-reveal>
        <div className="flex items-center gap-2">
          <span className="badge badge-bronze">Protection Active</span>
          <span className="text-muted text-xs">BSC Testnet</span>
        </div>

        <h1 className="font-display mt-4 text-4xl leading-[1.08] tracking-tight sm:text-5xl lg:text-[3.2rem]">
          A smart shield for
          <br />
          <span className="text-gradient">your crypto transfers.</span>
        </h1>

        <p className="text-muted mt-5 max-w-lg text-[15px] leading-relaxed">
          Send tokens without a second thought. Every transfer is secured in a smart escrow vault
          and verified automatically before the funds reach the recipient.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-4">
          <ConnectButton label="Connect Wallet" />
          <span className="text-muted text-xs">Connect your Web3 wallet to get started.</span>
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
              <p className="eyebrow">Protection Flow</p>
              <p className="font-display mt-1 text-lg text-ink">Automatic Workflow Steps</p>
            </div>
            <span className="badge badge-safe">9 Stages</span>
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
            <span>Runs automatically as transfers come in</span>
            <span className="text-bronze font-medium">Transparent &amp; Real-time</span>
          </div>
        </div>
      </div>
    </section>
  );
}
