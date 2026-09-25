"use client";

import { isValidAddress, truncateAddress } from "@/lib/utils";

interface AddressFilterProps {
  /** Nilai input (mentah, bisa belum tervalidasi). */
  value: string;
  onChange: (value: string) => void;
  /** Address dompet yang tersambung (untuk tombol "Dompet saya"). */
  walletAddress?: string;
  /** ID unik untuk label/input (agar bisa dipakai di >1 section). */
  id: string;
}

/**
 * Filter alamat untuk arsip sidang & riwayat escrow.
 * Default: dompet terhubung. Bisa diganti alamat mana pun (multi-wallet).
 * State diangkat ke page.tsx supaya kedua section selalu sinkron.
 */
export default function AddressFilter({
  value,
  onChange,
  walletAddress,
  id,
}: AddressFilterProps) {
  const trimmed = value.trim();
  const hasQuery = trimmed.length > 0;
  const invalid = hasQuery && !isValidAddress(trimmed);
  const filtered = hasQuery && !invalid;
  const target = filtered ? trimmed : walletAddress;

  return (
    <div className="mb-3 flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="field-label mb-0 shrink-0">
          Alamat
        </label>
        <input
          id={id}
          type="text"
          className="field min-w-0 flex-1"
          placeholder="0x… (default: dompet terhubung)"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="btn btn-ghost btn-sm shrink-0"
          onClick={() => onChange("")}
          disabled={!filtered}
        >
          Dompet saya
        </button>
      </div>

      <p className="text-muted text-[11px]" role="status">
        {invalid ? (
          <span className="text-danger">
            Format alamat tidak valid — gunakan 0x diikuti 40 karakter hex.
          </span>
        ) : filtered ? (
          <>
            Menampilkan data untuk <span className="font-mono">{truncateAddress(trimmed)}</span>{" "}
            (bisa address siapa pun — tidak perlu sambungkan wallet-nya).
          </>
        ) : target ? (
          <>
            Menampilkan data untuk dompet terhubung{" "}
            <span className="font-mono">{truncateAddress(target)}</span>.
          </>
        ) : (
          <>Sambungkan wallet — atau ketik alamat mana pun — untuk memuat data.</>
        )}
      </p>
    </div>
  );
}
