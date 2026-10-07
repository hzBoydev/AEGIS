"use client";

import { useState, useEffect, useCallback } from "react";
import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import Image from "next/image";
import Hero from "@/components/Hero";
import SendForm from "@/components/SendForm";
import LiveDebate from "@/components/LiveDebate";
import DebateHistory from "@/components/DebateHistory";
import EscrowHistory from "@/components/EscrowHistory";
import HumanReview from "@/components/HumanReview";
import DebateModal from "@/components/DebateModal";
import { DebateStreamProvider, NewSession } from "@/components/DebateStream";
import { HumanQueueProvider, HumanDecisionLayer } from "@/components/HumanQueue";
import AddressFilter from "@/components/AddressFilter";
import { isValidAddress } from "@/lib/utils";

const NAV = [
  { id: "kirim-token", label: "Send Token" },
  { id: "sidang-live", label: "Live Verification" },
  { id: "arsip-sidang", label: "Verification Archive" },
  { id: "riwayat", label: "Transaction History" },
] as const;

function DashboardIntro() {
  return (
    <div className="pt-2 pb-1" data-reveal>
      <div className="flex items-center gap-2">
        <span className="badge badge-safe">System Connected</span>
        <span className="text-muted text-xs font-mono">BSC Testnet Active</span>
      </div>
      <h1 className="font-display mt-3 text-3xl font-bold leading-tight tracking-tight sm:text-4xl text-ink">
        Transaction Control Center
      </h1>
      <p className="text-muted mt-2 max-w-2xl text-sm leading-relaxed">
        Every transfer you make is protected automatically. Funds are secured in an escrow vault,
        verified by a layered multi-agent AI security system, and you hold full power to cancel whenever danger is suspected.
      </p>
    </div>
  );
}

function ConnectCard() {
  return (
    <section className="card overflow-hidden">
      <div className="card-head">
        <div>
          <p className="eyebrow">Step 01</p>
          <p className="font-display mt-1 text-xl font-bold text-ink">Send Token Securely</p>
          <p className="text-muted mt-1 text-xs">
            Connect a Web3 wallet to start sending with escrow protection
          </p>
        </div>
        <span className="badge badge-bronze">Escrow Vault</span>
      </div>
      <div className="card-pad flex flex-col items-start gap-4">
        <p className="text-muted text-sm leading-relaxed">
          Connect your wallet to the BSC Testnet network to make protected transfers.
        </p>
        <ConnectButton label="Connect Wallet" />
      </div>
    </section>
  );
}

export default function Home() {
  const { isConnected, address: walletAddress } = useAccount();
  const [modalOpen, setModalOpen] = useState(false);
  const [newSession, setNewSession] = useState<NewSession>({ key: 0, at: 0 });
  const [activeSection, setActiveSection] = useState<string>(NAV[0].id);

  const [filterAddress, setFilterAddress] = useState("");
  const query = filterAddress.trim();
  const activeAddress =
    query.length === 0
      ? walletAddress
      : isValidAddress(query)
      ? query
      : "";

  const openModal = useCallback(() => setModalOpen(true), []);
  const closeModal = useCallback(() => setModalOpen(false), []);
  const handleSubmitted = useCallback(() => {
    const at = Date.now();
    setNewSession((s) => ({ key: s.key + 1, at }));
    setModalOpen(true);
  }, []);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible?.target.id) setActiveSection(visible.target.id);
      },
      { rootMargin: "-30% 0px -55% 0px", threshold: [0, 0.2, 0.5, 1] }
    );

    for (const item of NAV) {
      const el = document.getElementById(item.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));

    if (!("IntersectionObserver" in window)) {
      els.forEach((el) => el.classList.add("is-in"));
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            io.unobserve(entry.target);
          }
        }
      },
      { rootMargin: "0px 0px -6% 0px", threshold: 0.05 }
    );

    for (const el of els) io.observe(el);
    return () => io.disconnect();
  }, [isConnected]);

  return (
    <DebateStreamProvider newSession={newSession}>
      <HumanQueueProvider>
        <div className="flex min-h-screen flex-col">
          {/* ── Editorial Header (Clean Brand Text) ─────────────── */}
          <header className="site-header">
            <div className="shell flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3.5 md:h-20 md:flex-nowrap md:py-0">
              <div className="flex shrink-0 items-center gap-3">
                <a href="#" className="flex items-center gap-2 group">
                  <Image src="/logo.png" alt="AEGIS" width={56} height={56} className="h-14 w-14 object-contain" />
                  <span className="font-display text-2xl font-bold tracking-tight text-ink">
                    AEGIS
                  </span>
                </a>
              </div>

              <nav
                className="nav-scroll order-3 w-full overflow-x-auto md:order-none md:w-auto md:flex-1"
                aria-label="Main navigation"
              >
                <div className="flex items-center gap-1.5 md:justify-center">
                  {NAV.map((item) => (
                    <a
                      key={item.id}
                      href={`#${item.id}`}
                      className={`nav-link ${activeSection === item.id ? "is-active" : ""}`}
                    >
                      {item.label}
                    </a>
                  ))}
                </div>
              </nav>

              <div className="shrink-0 flex items-center gap-3">
                <div className="hidden lg:flex items-center gap-2 rounded-full border border-black/10 bg-black/5 px-3 py-1.5 text-[11px] font-mono font-medium text-black">
                  <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                  <span>BSC Testnet</span>
                </div>
                <div className="scale-95">
                  <ConnectButton label="Connect" />
                </div>
              </div>
            </div>
          </header>

          <main className="shell flex-1 pb-16 pt-6 sm:pt-10">
            {!isConnected ? <Hero /> : <DashboardIntro />}

            <section id="kirim-token" className="section-block" data-reveal>
              <div className="grid items-start gap-6 lg:grid-cols-12">
                <div className="min-w-0 lg:col-span-7">
                  {isConnected ? <SendForm onSubmitted={handleSubmitted} /> : <ConnectCard />}
                </div>
                <div className="min-w-0 lg:col-span-5">
                  <HumanReview />
                </div>
              </div>
            </section>

            <section id="sidang-live" className="section-block" data-reveal>
              <LiveDebate onOpenPopup={openModal} />
            </section>

            <section id="arsip-sidang" className="section-block" data-reveal>
              <AddressFilter
                id="filter-arsip"
                value={filterAddress}
                onChange={setFilterAddress}
                walletAddress={walletAddress}
              />
              <DebateHistory address={activeAddress} />
            </section>

            <section id="riwayat" className="section-block" data-reveal>
              <AddressFilter
                id="filter-riwayat"
                value={filterAddress}
                onChange={setFilterAddress}
                walletAddress={walletAddress}
              />
              <EscrowHistory address={activeAddress} />
            </section>
          </main>

          {/* ── Minimalist Editorial Footer ───────────────────── */}
          <footer className="site-footer">
            <div className="shell flex flex-wrap items-center justify-between gap-6 py-10">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-display font-bold text-lg text-ink">AEGIS</span>
                  <span className="text-muted text-xs ml-2 font-mono">Autonomous Escrow Protocol</span>
                </div>
                <p className="text-muted text-xs mt-2 max-w-md leading-relaxed">
                  Layered AI multi-agent verification engine defending Web3 transactions in real time.
                </p>
              </div>
              <div className="flex flex-col sm:items-end gap-2 text-xs text-black/60 font-mono">
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  <span>BSC Testnet Active</span>
                </div>
                <p className="text-[11px] text-black/40">
                  © {new Date().getFullYear()} AEGIS Security. All rights reserved.
                </p>
              </div>
            </div>
          </footer>
        </div>

        <DebateModal open={modalOpen} onClose={closeModal} />
        <HumanDecisionLayer />
      </HumanQueueProvider>
    </DebateStreamProvider>
  );
}