"use client";

import { useEffect, useRef, useState } from "react";
import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { parseEther } from "viem";
import { CONTRACT_ADDRESS, AEGIS_VAULT_ABI } from "@/config/contract";
import { isValidAddress } from "@/lib/utils";

interface SendFormProps {
  onSubmitted?: () => void;
}

const PRESET_AMOUNTS = ["0.001", "0.01", "0.05", "0.1"];

export default function SendForm({ onSubmitted }: SendFormProps) {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

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
    setFormError(null);

    const to = recipient.trim();
    if (!isValidAddress(to)) {
      setFormError("Alamat penerima tidak valid — gunakan format 0x diikuti 40 karakter hex.");
      return;
    }

    const rawAmount = amount.trim();
    if (!rawAmount) {
      setFormError("Masukkan jumlah transfer.");
      return;
    }

    let value: bigint;
    try {
      value = parseEther(rawAmount);
    } catch {
      setFormError("Jumlah transfer bukan angka desimal yang valid.");
      return;
    }
    if (value <= BigInt(0)) {
      setFormError("Jumlah transfer harus lebih besar dari 0.");
      return;
    }

    writeContract({
      address: CONTRACT_ADDRESS,
      abi: AEGIS_VAULT_ABI,
      functionName: "submitTransfer",
      args: [to as `0x${string}`],
      value,
    });
  }

  return (
    <section className="card overflow-hidden">
      <div className="card-head">
        <div>
          <p className="eyebrow">Langkah 01</p>
          <p className="font-display mt-1 text-xl text-ink">Kirim Token Aman</p>
          <p className="text-muted mt-1 text-xs">
            Dana masuk ke brankas penampung (Escrow) sebelum diverifikasi
          </p>
        </div>
        <span className="badge badge-bronze">Escrow Vault</span>
      </div>

      <form onSubmit={handleSubmit} className="card-pad flex flex-col gap-5">
        <div>
          <label htmlFor="recipient" className="field-label flex items-center justify-between">
            <span>Alamat Dompet Penerima</span>
            <span className="text-muted text-[11px] font-normal">Format: 0x... (BSC Testnet)</span>
          </label>
          <input
            id="recipient"
            type="text"
            placeholder="Masukkan alamat dompet (0x...)"
            value={recipient}
            onChange={(e) => {
              setRecipient(e.target.value);
              if (formError) setFormError(null);
            }}
            className="field font-mono text-xs sm:text-sm"
            autoComplete="off"
            spellCheck={false}
            required
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label htmlFor="amount" className="field-label mb-0">
              Jumlah Transfer (BNB)
            </label>
            <div className="flex items-center gap-1.5">
              {PRESET_AMOUNTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setAmount(p)}
                  className={`btn-ghost btn-sm py-0.5 px-2 text-[11px] rounded-md transition-all ${
                    amount === p ? "border-[var(--bronze)] text-[var(--bronze)] font-semibold" : ""
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          <input
            id="amount"
            type="text"
            inputMode="decimal"
            placeholder="Contoh: 0.001"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              if (formError) setFormError(null);
            }}
            className="field"
            required
          />
        </div>

        {formError && (
          <div className="alert alert-danger" role="alert">
            <span aria-hidden className="text-base font-bold">✕</span>
            <span>{formError}</span>
          </div>
        )}

        <div className="flex flex-col gap-3 pt-1">
          <button type="submit" disabled={isPending || isConfirming} className="btn btn-bronze w-full">
            {isPending
              ? "Menunggu Konfirmasi di Wallet…"
              : isConfirming
              ? "Memproses Transaksi di Jaringan…"
              : "Kirim dengan Proteksi Aegis"}
          </button>
          <div className="flex items-center justify-between text-muted text-[11px]">
            <span>🛡️ Dana aman di escrow hingga diverifikasi</span>
            <span>Jaringan: BSC Testnet</span>
          </div>
        </div>

        {error && (
          <div className="alert alert-danger" role="alert">
            <span aria-hidden className="text-base font-bold">✕</span>
            <div>
              <p className="font-semibold">{error.message.split("\n")[0]}</p>
              <p className="mt-1 text-[11px] opacity-80">
                Pastikan saldo BNB mencukupi dan jaringan dompet Anda berada di BSC Testnet.
              </p>
            </div>
          </div>
        )}

        {isConfirming && (
          <div className="alert alert-safe" role="status">
            <span aria-hidden className="pulse-bronze h-2 w-2 rounded-full bg-[var(--bronze)] shrink-0 mt-1" />
            <div>
              <p className="font-semibold">Menunggu konfirmasi blok di BSC Testnet…</p>
              <p className="text-[11px] opacity-85">Transaksi Anda sedang dicatat di blockchain.</p>
            </div>
          </div>
        )}

        {isConfirmed && (
          <div className="alert alert-safe" role="status">
            <span aria-hidden className="text-base font-bold">✓</span>
            <div>
              <p className="font-semibold">Transaksi Berhasil Dibuat!</p>
              <p className="mt-0.5 text-xs opacity-90 leading-relaxed">
                Dana kini berada di brankas escrow. Sistem verifikasi otomatis sedang berjalan.
                Hasil dan perkembangan dapat dipantau di bagian <strong>Pemantauan Verifikasi Live</strong> di bawah.
              </p>
              {hash && (
                <p className="mt-1.5 font-mono text-[11px] opacity-75">
                  ID Transaksi: {hash.slice(0, 20)}…
                </p>
              )}
            </div>
          </div>
        )}
      </form>
    </section>
  );
}
