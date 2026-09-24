"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { DebateStreamProvider } from "@/components/DebateStream";
import Hero from "@/components/Hero";
import SendForm from "@/components/SendForm";
import HowItWorks from "@/components/HowItWorks";
import HumanReview from "@/components/HumanReview";
import LiveDebate from "@/components/LiveDebate";
import DebateHistory from "@/components/DebateHistory";
import DebateModal from "@/components/DebateModal";
import EscrowHistory from "@/components/EscrowHistory";

const NAV = [
  { id: "kirim-token", label: "Kirim Token" },
  { id: "sidang-live", label: "Sidang Live" },
  { id: "arsip-sidang", label: "Arsip Sidang" },
  { id: "tata-cara", label: "Tata Cara" },
  { id: "riwayat", label: "Riwayat" },
] as const;

function BrandMark() {
  return (
    <svg width="18" height="22" viewBox="0 0 22 26" fill="none" aria-hidden>
      <path
        d="M11 1L20 5V12C20 18 16 23 11 25C6 23 2 18 2 12V5L11 1Z"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path d="M11 6V20M6 10H16" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function DashboardIntro() {
  return (
    <div className="pt-2" data-reveal>
      <p className="eyebrow">Ruang kendali</p>
      <h1 className="font-display mt-2 text-3xl leading-tight tracking-tight sm:text-4xl">
        Perisai aktif
      </h1>
      <p className="text-muted mt-2 max-w-xl text-sm leading-relaxed">
        Transfer ditahan di escrow, disidang AI Oracle, lalu hanya lolos bila aman — atau
        diveto oleh satu suara manusia. Pilih bagianmu lewat menu di atas.
      </p>
    </div>
  );
}

function ConnectCard() {
  return (
    <section className="card overflow-hidden">
      <div className="card-head">
        <div>
          <p className="eyebrow">Langkah 01</p>
          <p className="font-display mt-1 text-xl text-ink">Kirim Token</p>
          <p className="text-muted mt-1 text-xs">
            BNB Testnet — ditahan hingga diverifikasi aman
          </p>
        </div>
        <span className="badge badge-bronze">Escrow</span>
      </div>
      <div className="card-pad flex flex-col items-start gap-4">
        <p className="text-muted text-sm leading-relaxed">
          Sambungkan wallet untuk mengirim transfer yang dijaga Aegis.
        </p>
        <ConnectButton />
      </div>
    </section>
  );
}

export default function Home() {
  const { isConnected } = useAccount();
  const [modalOpen, setModalOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<string>(NAV[0].id);

  const openModal = useCallback(() => setModalOpen(true), []);
  const closeModal = useCallback(() => setModalOpen(false), []);

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
    <DebateStreamProvider>
      <div className="flex min-h-screen flex-col">
        <header className="site-header">
          <div className="shell flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 md:h-16 md:flex-nowrap md:py-0">
            <div className="flex shrink-0 items-center gap-3">
              <span className="icon-tile">
                <BrandMark />
              </span>
              <div>
                <p className="font-display text-lg leading-none tracking-[0.22em] text-ink">
                  AEGIS
                </p>
                <p className="text-muted mt-1.5 text-[11px] tracking-wide">
                  AI Transfer Guardian
                </p>
              </div>
            </div>

            <nav
              className="nav-scroll order-3 w-full overflow-x-auto md:order-none md:w-auto md:flex-1"
              aria-label="Navigasi utama"
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

            <div className="shrink-0">
              <ConnectButton />
            </div>
          </div>
        </header>

        <main className="shell flex-1 pb-16 pt-8 sm:pt-10">
          {!isConnected ? <Hero /> : <DashboardIntro />}

          <section id="kirim-token" className="section-block" data-reveal>
            <div className="grid items-start gap-6 lg:grid-cols-12">
              <div className="min-w-0 lg:col-span-7">
                {isConnected ? <SendForm onSubmitted={openModal} /> : <ConnectCard />}
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
            <DebateHistory />
          </section>

          <section id="tata-cara" className="section-block" data-reveal>
            <HowItWorks />
          </section>

          <section id="riwayat" className="section-block" data-reveal>
            <EscrowHistory />
          </section>
        </main>

        <footer className="site-footer">
          <div className="shell flex flex-wrap items-center justify-between gap-3 py-6">
            <p className="text-muted text-xs">© AEGIS — AI Transfer Guardian</p>
            <p className="text-muted text-xs">
              Escrow · Sidang multi-agen · Veto manusia — BSC Testnet
            </p>
          </div>
        </footer>
      </div>

      <DebateModal open={modalOpen} onClose={closeModal} />
    </DebateStreamProvider>
  );
}
