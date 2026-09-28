"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
  DebateStreamProvider,
  type NewSession,
} from "@/components/DebateStream";
import Hero from "@/components/Hero";
import SendForm from "@/components/SendForm";
import HumanReview from "@/components/HumanReview";
import LiveDebate from "@/components/LiveDebate";
import DebateHistory from "@/components/DebateHistory";
import DebateModal from "@/components/DebateModal";
import EscrowHistory from "@/components/EscrowHistory";
import AddressFilter from "@/components/AddressFilter";
import { isValidAddress } from "@/lib/utils";

const NAV = [
  { id: "kirim-token", label: "Send Token" },
  { id: "sidang-live", label: "Live Verification" },
  { id: "arsip-sidang", label: "Verification Archive" },
  { id: "riwayat", label: "Transaction History" },
] as const;

function BrandMark() {
  return (
    <svg width="20" height="24" viewBox="0 0 22 26" fill="none" aria-hidden>
      <path
        d="M11 1L20 5V12C20 18 16 23 11 25C6 23 2 18 2 12V5L11 1Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path d="M11 6V20M6 10H16" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

function DashboardIntro() {
  return (
    <div className="pt-2 pb-1" data-reveal>
      <div className="flex items-center gap-2">
        <span className="badge badge-safe">System Connected</span>
        <span className="text-muted text-xs">BSC Testnet</span>
      </div>
      <h1 className="font-display mt-3 text-3xl leading-tight tracking-tight sm:text-4xl text-ink">
        Transaction Control Center
      </h1>
      <p className="text-muted mt-2 max-w-2xl text-sm leading-relaxed">
        Every transfer you make is protected automatically. Funds are secured in an escrow vault,
        verified by a layered security system, and you hold full power to cancel whenever danger is suspected.
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
          <p className="font-display mt-1 text-xl text-ink">Send Token Securely</p>
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
      <div className="flex min-h-screen flex-col">
        <header className="site-header">
          <div className="shell flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 md:h-16 md:flex-nowrap md:py-0">
            <div className="flex shrink-0 items-center gap-3">
              <span className="icon-tile">
                <BrandMark />
              </span>
              <div>
                <p className="font-display text-lg leading-none tracking-[0.2em] font-bold text-ink">
                  AEGIS
                </p>
                <p className="text-muted mt-1 text-[11px] tracking-wide">
                  Smart Escrow & Security Guardian
                </p>
              </div>
            </div>

            <nav
              className="nav-scroll order-3 w-full overflow-x-auto md:order-none md:w-auto md:flex-1"
              aria-label="Main navigation"
            >
              <div className="flex items-center gap-1 md:justify-center">
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

            <div className="shrink-0 flex items-center gap-2">
              <ConnectButton label="Connect Wallet" />
            </div>
          </div>
        </header>

        <main className="shell flex-1 pb-16 pt-8 sm:pt-10">
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

        <footer className="site-footer">
          <div className="shell flex flex-wrap items-center justify-between gap-4 py-8">
            <div>
              <p className="font-display font-semibold text-sm text-ink">AEGIS — Smart Escrow Guardian</p>
              <p className="text-muted text-xs mt-1">
                Automatic crypto transaction protection with layered verification and full user control.
              </p>
            </div>
            <div className="text-right">
              <span className="badge badge-bronze">BSC Testnet Active</span>
              <p className="text-muted text-[11px] mt-1.5">
                © {new Date().getFullYear()} Aegis Security Protocol.
              </p>
            </div>
          </div>
        </footer>
      </div>

      <DebateModal open={modalOpen} onClose={closeModal} />
    </DebateStreamProvider>
  );
}
