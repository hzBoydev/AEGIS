"use client";

import { useEffect, useRef, useState } from "react";
import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { parseEther } from "viem";
import { CONTRACT_ADDRESS, AEGIS_VAULT_ABI } from "@/config/contract";

interface SendFormProps {
  /** Dipanggil sekali tiap transaksi baru terkirim (untuk membuka popup sidang). */
  onSubmitted?: () => void;
}

export default function SendForm({ onSubmitted }: SendFormProps) {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");

  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({ hash });

  const notifiedHash = useRef<string | null>(null);

  useEffect(() => {
    if (hash && hash !== notifiedHash.current) {
      notifiedHash.current = hash;
      onSubmitted?.();
    }
  }, [hash, onSubmitted]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!recipient || !amount) return;
    writeContract({
      address: CONTRACT_ADDRESS,
      abi: AEGIS_VAULT_ABI,
      functionName: "submitTransfer",
      args: [recipient as `0x${string}`],
      value: parseEther(amount),
    });
  }

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

      <form onSubmit={handleSubmit} className="card-pad flex flex-col gap-5">
        <div>
          <label htmlFor="recipient" className="field-label">
            Alamat penerima
          </label>
          <input
            id="recipient"
            type="text"
            placeholder="0x..."
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            className="field"
            autoComplete="off"
            spellCheck={false}
            required
          />
        </div>

        <div>
          <label htmlFor="amount" className="field-label">
            Jumlah (BNB)
          </label>
          <input
            id="amount"
            type="text"
            inputMode="decimal"
            placeholder="0.001"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="field"
            required
          />
        </div>

        <div className="flex flex-col gap-3 pt-0.5">
          <button type="submit" disabled={isPending || isConfirming} className="btn btn-bronze w-full">
            {isPending
              ? "Menunggu konfirmasi wallet"
              : isConfirming
              ? "Memproses transaksi"
              : "Kirim ke Escrow"}
          </button>
          <p className="text-muted text-[11px] leading-relaxed">
            Dana ditahan kontrak escrow dan hanya keluar setelah putusan oracle.
          </p>
        </div>

        {error && (
          <div className="alert alert-danger" role="alert">
            <span aria-hidden>✕</span>
            <span>
              {error.message.split("\n")[0]}
              <span className="mt-1 block text-[11px] opacity-80">
                Kalau transaksi tidak terkirim, cek jaringan wallet (BSC Testnet) lalu
                coba lagi.
              </span>
            </span>
          </div>
        )}

        {isConfirming && (
          <div className="alert" role="status">
            <span aria-hidden>⏳</span>
            <span>
              Menunggu transaksi dikonfirmasi jaringan BSC Testnet…
            </span>
          </div>
        )}

        {isConfirmed && (
          <div className="alert alert-safe" role="status">
            <span aria-hidden>✓</span>
            <span>
              Escrow dibuat — dana ditahan kontrak. Sidang AI (Investigator →
              Advocate → Judge) segera dimulai; hasilnya tampil di bagian{" "}
              <strong>Sidang AI Live</strong> (biasanya 30–60 detik).
              {hash && (
                <span className="mt-1 block font-mono text-[11px] opacity-80">
                  tx {hash.slice(0, 18)}…
                </span>
              )}
            </span>
          </div>
        )}
      </form>
    </section>
  );
}
