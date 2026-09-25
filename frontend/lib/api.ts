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
  constructor(message: string, kind: ApiErrorKind) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
  }
}

export const BACKEND_HINT =
  "Pastikan backend berjalan: cd backend && npm run dev";

/**
 * fetch JSON dengan pesan error yang bisa ditampilkan ke user.
 * - gagal jaringan  → saran cek backend
 * - status bukan 2xx → status HTTP
 * - bukan JSON       → respons tidak valid
 */
export async function fetchJson<T = unknown>(
  path: string,
  init?: RequestInit
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
    throw new ApiError(
      `Backend merespons ${res.status} ${res.statusText || ""}`.trim(),
      "http"
    );
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError("Respons backend tidak valid (bukan JSON).", "payload");
  }
}

/** Pesan singkat untuk ditampilkan di kartu UI (tanpa hint teknis panjang). */
export function shortApiMessage(err: unknown): string {
  if (err instanceof ApiError && err.kind === "network") {
    return "Backend AEGIS tidak terjangkau — coba lagi setelah service menyala.";
  }
  if (err instanceof Error && err.message) return err.message;
  return "Terjadi kesalahan tak terduga.";
}
