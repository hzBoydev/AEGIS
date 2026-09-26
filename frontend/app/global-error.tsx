"use client";

/**
 * Error boundary tingkat root — menggantikan `layout.tsx`, jadi wajib me-render
 * `<html>` dan `<body>` sendiri dan tidak memakai stylesheet global.
 * Props Next 16: `error` + `retry`.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="id">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
          background: "#0b0f14",
          color: "#e8edf2",
        }}
      >
        <main style={{ maxWidth: 480, width: "100%" }} role="alert">
          <p
            style={{
              margin: 0,
              fontSize: 12,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: "#9aa7b4",
            }}
          >
            AEGIS
          </p>
          <h1 style={{ margin: "8px 0 12px", fontSize: 24 }}>Terjadi Kesalahan Fatal</h1>
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: "#9aa7b4" }}>
            Aplikasi gagal dimuat. Muat ulang halaman; bila masalah berlanjut, periksa
            layanan backend dan koneksi jaringan Anda.
          </p>
          <p
            style={{
              margin: "14px 0 0",
              padding: "10px 12px",
              fontSize: 12,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              background: "#131a22",
              border: "1px solid #26313d",
              borderRadius: 8,
              wordBreak: "break-word",
            }}
          >
            {error.message || "Pesan error tidak tersedia."}
            {error.digest ? ` · digest ${error.digest}` : ""}
          </p>
          <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
            <button
              type="button"
              onClick={() => retry()}
              style={{
                padding: "10px 16px",
                borderRadius: 8,
                border: "1px solid #b98a4b",
                background: "#b98a4b",
                color: "#12181f",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Coba Lagi
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                padding: "10px 16px",
                borderRadius: 8,
                border: "1px solid #2f3a46",
                background: "transparent",
                color: "#e8edf2",
                cursor: "pointer",
              }}
            >
              Muat Ulang
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
