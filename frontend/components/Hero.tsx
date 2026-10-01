"use client";

import React, { useState } from "react";
import Image from "next/image";
import { ConnectButton } from "@rainbow-me/rainbowkit";

const STEPS = [
  {
    n: "01",
    title: "Safety Vault Escrow",
    desc: "Funds are locked in a non-custodial smart contract escrow and never released directly until proven secure.",
  },
  {
    n: "02",
    title: "Autonomous AI Analysis",
    desc: "Multi-agent investigator, advocate, and judge debate address risk and inspect code patterns in real-time.",
  },
  {
    n: "03",
    title: "Full Human Control",
    desc: "If any risk is flagged, the transaction is held in quarantine and you can cancel anytime with full refund.",
  },
];

const PIPELINE = [
  { name: "Escrow Vault", sub: "Funds Secured" },
  { name: "Evidence Scan", sub: "On-Chain History" },
  { name: "Security Rules", sub: "Threat Detection" },
  { name: "Investigator AI", sub: "Pattern Analysis" },
  { name: "Tool Calling", sub: "Contract Probing" },
  { name: "Advocate AI", sub: "Context Evaluation" },
  { name: "Judge AI", sub: "Consensus Score" },
  { name: "Verdict Engine", sub: "Risk Classification" },
  { name: "Human Review", sub: "User Sovereignty" },
];

const TRUST_LOGOS = [
  { name: "BNB Chain", tag: "Ecosystem" },
  { name: "RainbowKit", tag: "Wallet Connect" },
  { name: "Wagmi / Viem", tag: "Core Web3" },
  { name: "Solidity", tag: "Smart Escrow" },
  { name: "Multi-Agent AI", tag: "Debate Engine" },
  { name: "BSC Testnet", tag: "Live Network" },
];

export default function Hero() {
  const [sparkActive, setSparkActive] = useState(false);

  const scrollToTransfer = () => {
    const el = document.getElementById("kirim-token");
    if (el) {
      el.scrollIntoView({ behavior: "smooth" });
    }
  };

  return (
    <section className="relative w-full py-4 sm:py-8">
      {/* ── Main Hero Editorial Banner ─────────────────────── */}
      <div className="relative mx-auto max-w-5xl text-center" data-reveal>
        {/* Subtle pill tag */}
        <div className="inline-flex items-center gap-2 rounded-full border border-black/10 bg-black/5 px-4 py-1.5 text-xs font-medium text-black backdrop-blur-sm transition-all hover:bg-black/10">
          <span className="h-2 w-2 rounded-full bg-emerald-600 animate-pulse" />
          <span className="font-semibold">AEGIS Autonomous Security</span>
          <span className="text-black/30">/</span>
          <span className="text-black/60 font-mono text-[11px]">BSC Testnet</span>
        </div>

        {/* Hero Title with Refined Headline */}
        <h1 className="mt-6 font-display text-4xl font-bold tracking-tight text-[#111111] sm:text-6xl lg:text-[4.2rem] lg:leading-[1.06]">
          Autonomous Escrow That
          <br />
          <span className="relative inline-block text-black">
            Guards Every Transfer.
            <span className="absolute -bottom-1 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-black/20 to-transparent" />
          </span>
        </h1>

        {/* Subtitle */}
        <p className="mx-auto mt-6 max-w-2xl text-[15px] leading-relaxed text-[#55524d] sm:text-base">
          We protect your Web3 transfers with autonomous multi-agent AI verification
          and non-custodial smart escrow before funds ever leave your hands.
        </p>

        {/* Hero CTA Button (Solid Black Pill with Glow & Arrow) */}
        <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
          <button
            onClick={scrollToTransfer}
            className="group relative inline-flex items-center gap-2.5 rounded-full bg-[#111111] px-8 py-4 text-sm font-semibold text-white shadow-xl shadow-black/20 transition-all duration-300 hover:scale-[1.03] hover:bg-black hover:shadow-2xl hover:shadow-black/30 active:scale-[0.98]"
          >
            <span>Get Protected</span>
            <span className="transition-transform duration-300 group-hover:translate-x-1 group-hover:-translate-y-1">
              ↗
            </span>
            <span className="absolute inset-0 rounded-full border border-white/20 pointer-events-none" />
          </button>

          <div className="scale-95 sm:scale-100">
            <ConnectButton label="Connect Wallet" />
          </div>
        </div>
      </div>

      {/* ── Halftone Michelangelo Hands Visual ──────────────── */}
      <div
        className="animate-float relative mx-auto mt-10 max-w-5xl overflow-hidden rounded-2xl border border-black/10 bg-[#faf9f5] shadow-2xl shadow-black/5"
        data-reveal
        style={{ "--reveal-delay": "0.15s" } as React.CSSProperties}
        onMouseEnter={() => setSparkActive(true)}
        onMouseLeave={() => setSparkActive(false)}
      >
        {/* Halftone texture overlay pattern */}
        <div className="halftone-overlay pointer-events-none absolute inset-0 z-10 opacity-40 mix-blend-multiply" />

        {/* Image wrapper */}
        <div className="relative aspect-[16/9] w-full max-h-[520px] overflow-hidden bg-[#ebe7dc]/30">
          <Image
            src="/hero_hands.jpg"
            alt="AI Robot Hand and Human Hand meeting in halftone dither style"
            fill
            priority
            className="object-cover object-center transition-transform duration-700 ease-out hover:scale-[1.01]"
          />

          {/* Interactive Electric Energy Spark at Fingertip Connection (Center) */}
          <div className="pointer-events-none absolute left-[50.2%] top-[49.5%] -translate-x-1/2 -translate-y-1/2 z-20">
            <div className={`spark-core ${sparkActive ? "spark-hover" : ""}`} />
            <div className="spark-ring" />
            <div className="spark-rays" />
          </div>

          {/* Left Floating Badge: AI Investigation */}
          <div className="absolute left-4 top-4 z-20 hidden sm:block">
            <div className="flex items-center gap-2.5 rounded-full border border-black/10 bg-white/95 px-4 py-1.5 shadow-md backdrop-blur-md transition-all hover:bg-white hover:scale-105">
              <span className="flex h-2 w-2 rounded-full bg-black animate-ping" />
              <span className="text-[11px] font-semibold tracking-wide uppercase text-black font-mono">
                AI Multi-Agent Consensus
              </span>
            </div>
          </div>

          {/* Right Floating Badge: Human Sovereignty */}
          <div className="absolute right-4 top-4 z-20 hidden sm:block">
            <div className="flex items-center gap-2.5 rounded-full border border-black/10 bg-white/95 px-4 py-1.5 shadow-md backdrop-blur-md transition-all hover:bg-white hover:scale-105">
              <span className="h-2 w-2 rounded-full bg-emerald-600" />
              <span className="text-[11px] font-semibold tracking-wide uppercase text-black font-mono">
                Human Override & Refund
              </span>
            </div>
          </div>

          {/* Bottom banner inside image */}
          <div className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-between border-t border-black/10 bg-white/85 px-6 py-2.5 backdrop-blur-md">
            <span className="text-[11px] font-medium tracking-wider uppercase text-black/70 font-mono">
              The Creation of Smart Escrow
            </span>
            <span className="text-[11px] font-mono text-black/60">
              Autonomous Verification × User Control
            </span>
          </div>
        </div>
      </div>

      {/* ── Social Proof / Ecosystem Strip ───────────────────── */}
      <div className="mx-auto mt-8 max-w-5xl text-center" data-reveal style={{ "--reveal-delay": "0.2s" } as React.CSSProperties}>
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-black/50 font-mono">
          Trusted by teams of every scale
        </p>

        <div className="mt-4 flex flex-wrap items-center justify-center gap-3 sm:gap-6">
          {TRUST_LOGOS.map((logo) => (
            <div
              key={logo.name}
              className="flex items-center gap-2 rounded-xl border border-black/10 bg-white/80 px-4 py-2 backdrop-blur-sm transition-all duration-200 hover:-translate-y-1 hover:border-black/30 hover:bg-white hover:shadow-md"
            >
              <span className="font-display text-xs font-bold tracking-tight text-black">
                {logo.name}
              </span>
              <span className="rounded bg-black/5 px-1.5 py-0.5 text-[9px] font-mono text-black/70">
                {logo.tag}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── 3 Feature Pillars (Step Cards) ────────────────────── */}
      <div className="mx-auto mt-12 max-w-5xl" data-reveal style={{ "--reveal-delay": "0.25s" } as React.CSSProperties}>
        <div className="grid gap-4 sm:grid-cols-3">
          {STEPS.map((s) => (
            <div
              key={s.n}
              className="group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-black/10 bg-white/80 p-6 shadow-sm backdrop-blur-md transition-all duration-300 hover:-translate-y-1.5 hover:border-black/30 hover:bg-white hover:shadow-lg"
            >
              {/* Subtle hover gradient circle */}
              <div className="pointer-events-none absolute right-0 top-0 h-28 w-28 translate-x-8 -translate-y-8 rounded-full bg-black/[0.03] transition-transform duration-500 group-hover:scale-150" />

              <div>
                <span className="font-mono text-xs font-bold tracking-widest text-black/40">
                  {s.n}
                </span>
                <h3 className="mt-3 font-display text-lg font-bold text-black tracking-tight">
                  {s.title}
                </h3>
                <p className="mt-2 text-xs leading-relaxed text-[#66625b]">
                  {s.desc}
                </p>
              </div>

              <div className="mt-5 flex items-center gap-1.5 text-[11px] font-semibold text-black/70 group-hover:text-black">
                <span>Explore mechanism</span>
                <span className="transition-transform duration-200 group-hover:translate-x-1.5">→</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── 9-Stage Protection Flow Pipeline Showcase ─────────── */}
      <div className="mx-auto mt-10 max-w-5xl" data-reveal style={{ "--reveal-delay": "0.3s" } as React.CSSProperties}>
        <div className="overflow-hidden rounded-2xl border border-black/10 bg-white/90 shadow-md backdrop-blur-md">
          <div className="flex flex-wrap items-center justify-between border-b border-black/10 bg-black/[0.02] px-6 py-4">
            <div>
              <p className="text-[10px] font-mono font-bold tracking-[0.2em] uppercase text-black/50">
                Security Architecture
              </p>
              <h4 className="font-display text-base font-bold text-black">
                9-Stage Autonomous Protection Flow
              </h4>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-black px-3 py-1 text-[10px] font-semibold text-white font-mono shadow-sm">
                Active Protocol
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2.5 p-4 sm:grid-cols-3 lg:grid-cols-9">
            {PIPELINE.map((p, i) => (
              <div
                key={p.name}
                className="group relative flex flex-col justify-between rounded-xl border border-black/10 bg-white p-3 transition-all duration-200 hover:-translate-y-1 hover:border-black/30 hover:shadow-md"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] font-bold text-black/40">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="h-2 w-2 rounded-full bg-black/30 group-hover:bg-emerald-600 transition-colors" />
                </div>
                <div className="mt-2">
                  <p className="text-[11px] font-bold text-black leading-tight truncate">
                    {p.name}
                  </p>
                  <p className="text-[9px] text-black/60 truncate font-mono mt-0.5">
                    {p.sub}
                  </p>
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between border-t border-black/10 bg-black/[0.01] px-6 py-3 text-[11px] text-black/70">
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              Runs automatically on every incoming transaction
            </span>
            <span className="font-mono text-[10px] font-semibold text-black">
              100% Non-Custodial & Verifiable
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}