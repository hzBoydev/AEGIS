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
 * Best-effort read of `{ error: "…" }` from a failed response, so the user sees
 * the backend's reason instead of a bare status line. Returns null when the body
 * is missing or not JSON (e.g. a proxy's HTML error page).
 */
async function readErrorDetail(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object") {
      const err = (body as { error?: unknown }).error;
      if (typeof err === "string" && err.trim()) return err.trim();
    }
  } catch {
    // not JSON — fall through
  }
  return null;
}

/** Collapse a raw backend message so it stays readable on a small error card. */
function tidyDetail(detail: string): string {
  const flat = detail.replace(/\s+/g, " ").trim();
  return flat.length > 180 ? `${flat.slice(0, 177)}…` : flat;
}

/**
 * User-facing message for a non-2xx response.
 * Never shows the raw status line ("The backend responded with 500 Internal
 * Server Error"): a 5xx is phrased as a retryable problem, and the backend's own
 * reason is appended only when it is short enough to be useful.
 */
function httpErrorMessage(status: number, detail: string | null): string {
  if (detail) {
    const reason = tidyDetail(detail);
    if (status >= 500) return `The server could not complete the request — ${reason}`;
    return reason;
  }
  if (status === 404) return "This item is no longer waiting for a decision.";
  if (status === 400) return "The request was rejected as invalid.";
  if (status >= 500) return "The server hit an unexpected problem. Please try again.";
  return `The request failed (HTTP ${status}).`;
}

/**
 * fetch JSON with error messages that can be shown to the user.
 * - network failure → suggests checking the backend
 * - non-2xx status  → the backend's own reason, or a friendly fallback
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
    const detail = await readErrorDetail(res);
    throw new ApiError(httpErrorMessage(res.status, detail), "http");
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
