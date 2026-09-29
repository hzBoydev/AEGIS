/**
 * Backend base URL (Express + SSE).
 * Configured via NEXT_PUBLIC_API_BASE_URL in .env.local / the build environment.
 * The default is only for local development.
 * NOTE: NEXT_PUBLIC_* variables are frozen at build time, not at runtime.
 */
const rawBase =
  process.env.NEXT_PUBLIC_API_BASE_URL?.trim() || "http://localhost:3001";

export const API_BASE_URL = rawBase.replace(/\/+$/, "");

/** Join a relative path ("/api/stream") with the backend base URL. */
export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Cause of an API fetch failure — used to pick the message shown to the user. */
type ApiErrorKind = "network" | "http" | "payload";

class ApiError extends Error {
  readonly kind: ApiErrorKind;
  constructor(message: string, kind: ApiErrorKind) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
  }
}

const BACKEND_HINT = "Make sure the backend is running: cd backend && npm run dev";

/**
 * fetch JSON with error messages that can be shown to the user.
 * - network failure → suggests checking the backend
 * - non-2xx status  → the HTTP status
 * - not JSON        → invalid response
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
      `Could not reach the AEGIS backend (${API_BASE_URL}). ${BACKEND_HINT}`,
      "network"
    );
  }

  if (!res.ok) {
    throw new ApiError(
      `The backend responded with ${res.status} ${res.statusText || ""}`.trim(),
      "http"
    );
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError("The backend response is not valid (not JSON).", "payload");
  }
}

/** Short message for the UI card (without the long technical hint). */
export function shortApiMessage(err: unknown): string {
  if (err instanceof ApiError && err.kind === "network") {
    return "The AEGIS backend is unreachable — try again once the service is up.";
  }
  if (err instanceof Error && err.message) return err.message;
  return "An unexpected error occurred.";
}
