import type { z } from "zod";

/**
 * Base URL backend (Express + SSE).
 * Diatur lewat NEXT_PUBLIC_API_BASE_URL di .env.local / environment build.
 * Default hanya untuk development lokal.
 * NOTE: variabel NEXT_PUBLIC_* dibekukan saat build — bukan saat runtime.
 */
const rawBase =
  process.env.NEXT_PUBLIC_API_BASE_URL?.trim() || "http://localhost:3001";

export const API_BASE_URL = rawBase.replace(/\/+$/, "");

/** Gabungkan path relatif ("/api/stream") dengan base URL backend. */
export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Penyebab kegagalan fetch API — dipakai untuk memilih pesan ke user. */
export type ApiErrorKind = "network" | "http" | "payload";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  constructor(message: string, kind: ApiErrorKind, status?: number) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
  }
}

export const BACKEND_HINT =
  "Pastikan backend berjalan: cd backend && npm run dev";

/**
 * fetch JSON dengan pesan error yang bisa ditampilkan ke user.
 * - gagal jaringan  → saran cek backend
 * - status bukan 2xx → pesan `error` dari body backend (bila ada), fallback status HTTP
 * - bukan JSON       → respons tidak valid
 * - `schema` diberikan → respons di-validasi runtime; selisih kontrak backend
 *   terdeteksi di sini, bukan sebagai crash saat render.
 */
export async function fetchJson<T = unknown>(
  path: string,
  init?: RequestInit,
  schema?: z.ZodType<unknown>
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), init);
  } catch {
    throw new ApiError(
      `Tidak bisa terhubung ke backend AEGIS (${API_BASE_URL}). ${BACKEND_HINT}`,
      "network"
    );
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: unknown; details?: unknown };
      if (typeof body?.error === "string" && body.error.trim()) {
        detail = body.error.trim();
      }
      // Backend menyertakan `details` (array string) untuk error validasi zod.
      if (Array.isArray(body?.details)) {
        const extra = body.details
          .filter((d): d is string => typeof d === "string" && d.trim().length > 0)
          .join("; ");
        if (extra) detail = detail ? `${detail} — ${extra}` : extra;
      }
    } catch {
      /* body bukan JSON — pakai status saja */
    }
    throw new ApiError(
      detail ||
        `Backend merespons ${res.status} ${res.statusText || ""}`.trim(),
      "http",
      res.status
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ApiError("Respons backend tidak valid (bukan JSON).", "payload");
  }

  if (schema) {
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const at = first?.path.length
        ? ` pada "${first.path.map(String).join(".")}"`
        : "";
      throw new ApiError(
        `Respons backend tidak sesuai kontrak${at}: ${
          first?.message ?? "format tak dikenal"
        }.`,
        "payload"
      );
    }
    return parsed.data as T;
  }

  return json as T;
}

/** Pesan singkat untuk ditampilkan di kartu UI (tanpa hint teknis panjang). */
export function shortApiMessage(err: unknown): string {
  if (err instanceof ApiError && err.kind === "network") {
    return "Backend AEGIS tidak terjangkau — coba lagi setelah service menyala.";
  }
  if (err instanceof Error && err.message) return err.message;
  return "Terjadi kesalahan tak terduga.";
}
