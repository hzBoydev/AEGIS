#!/usr/bin/env node
// ── Expose the local Ollama daemon to a public HTTPS URL (for Railway/Vercel) ──
//
// WHY THIS EXISTS
// ───────────────
// The backend defaults OLLAMA_URL to http://localhost:11434 (config.ts). That
// only works on this machine; a Railway container has no Ollama, so the debate
// pipeline fails ("Ollama UNREACHABLE" → Investigator error → fail-safe REJECT).
//
// A Cloudflare quick tunnel hands us a public https://…trycloudflare.com URL,
// but it is NOT enough on its own: Ollama 0.3x rejects any request whose Host
// header is a public hostname (DNS-rebinding defence) and any disallowed Origin
// with 403. So the tunnel must point at the local proxy below, which rewrites
// Host to 127.0.0.1:<port> and drops Origin before forwarding to Ollama.
//
// USAGE
// ─────
//   node scripts/expose-ollama.mjs          # prints the OLLAMA_URL to paste into Railway
//   node scripts/expose-ollama.mjs --probe  # additionally round-trips a tiny /api/chat
//
// The tunnel URL is random per run: restart → new URL → update the Railway env
// var. The URL is the only secret (no auth header support in the backend), so
// treat it like a password — anyone who has it can drive your local model.

import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const UPSTREAM_HOST = "127.0.0.1";
const UPSTREAM_PORT = Number(process.env.OLLAMA_PORT ?? 11434);
const PROXY_PORT = Number(process.env.EXPOSE_PROXY_PORT ?? 11435);
const URL_TIMEOUT_MS = 90_000;
const PROBE_TIMEOUT_MS = 15_000;

const children = [];
process.on("exit", () => {
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {}
  }
});

const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function resolveCloudflared() {
  const candidates = [
    process.env.CLOUDFLARED_BIN,
    "cloudflared",
    path.join(homedir(), ".local/bin/cloudflared"),
    "/usr/local/bin/cloudflared",
    "/usr/bin/cloudflared",
  ].filter(Boolean);
  for (const c of candidates) {
    if (c.includes("/") ? existsSync(c) : hasOnPath(c)) return c;
  }
  return null;
}

function hasOnPath(bin) {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  return dirs.some((d) => existsSync(path.join(d, bin)));
}

// Ollama rejects Host = public hostname and any Origin outside its allow-list.
// Rewriting here is what makes the tunnel usable at all.
function forward(req, res) {
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.origin;
  delete headers.connection;
  delete headers["transfer-encoding"];

  const upstream = http.request(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      path: req.url,
      method: req.method,
      headers: { ...headers, host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` },
      timeout: 300_000,
    },
    (upRes) => {
      const outHeaders = { ...upRes.headers };
      for (const h of hopByHop) delete outHeaders[h];
      res.writeHead(upRes.statusCode ?? 502, outHeaders);
      upRes.pipe(res);
    },
  );

  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", (err) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `ollama proxy: ${err.message}` }));
  });
  req.pipe(upstream);
}

async function main() {
  const probeChat = process.argv.includes("--probe");

  const cloudflared = resolveCloudflared();
  if (!cloudflared) {
    console.error(
      "cloudflared not found. Install it first:\n" +
        "  curl -fsSL -o ~/.local/bin/cloudflared " +
        "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64\n" +
        "  chmod +x ~/.local/bin/cloudflared",
    );
    process.exit(1);
  }

  const proxy = http.createServer(forward);
  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(PROXY_PORT, "127.0.0.1", resolve);
  });
  console.log(`[proxy]  127.0.0.1:${PROXY_PORT} → ${UPSTREAM_HOST}:${UPSTREAM_PORT} (Host rewritten)`);

  const localTags = await fetch(`http://${UPSTREAM_HOST}:${UPSTREAM_PORT}/api/tags`, {
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  if (!localTags?.ok) {
    console.error(`[ollama] http://${UPSTREAM_HOST}:${UPSTREAM_PORT} is not answering — is Ollama running?`);
    process.exit(1);
  }

  const cf = spawn(cloudflared, ["tunnel", "--url", `http://127.0.0.1:${PROXY_PORT}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(cf);
  const cfOut = (chunk) => process.stdout.write(`[cf]     ${chunk}`);
  cf.stdout.on("data", cfOut);
  cf.stderr.on("data", cfOut);
  cf.on("exit", (code) => {
    console.error(`[cf]     cloudflared exited with code ${code}`);
    process.exit(1);
  });

  const url = await new Promise((resolve, reject) => {
    const buf = { out: "" };
    const onData = (chunk) => {
      buf.out += chunk.toString();
      const m = buf.out.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) {
        cleanup();
        resolve(m[0]);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`no tunnel URL after ${URL_TIMEOUT_MS / 1000}s`));
    }, URL_TIMEOUT_MS);
    function cleanup() {
      clearTimeout(timer);
      cf.stdout.off("data", onData);
      cf.stderr.off("data", onData);
    }
    cf.stdout.on("data", onData);
    cf.stderr.on("data", onData);
  });

  const stopAll = (code) => {
    cf.kill("SIGTERM");
    proxy.close();
    process.exit(code);
  };

  // New trycloudflare subdomains take a few seconds to start resolving/routing.
  let tags = null;
  let lastErr = "";
  for (let attempt = 1; attempt <= 6 && !tags?.ok; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 3_000));
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }).catch((e) => e);
    if (res?.ok) {
      tags = res;
    } else {
      lastErr = res?.status ? `HTTP ${res.status}` : (res?.message ?? String(res));
      console.log(`[probe]  attempt ${attempt}: GET /api/tags → ${lastErr}`);
    }
  }
  if (!tags?.ok) {
    console.error(`[probe]  GET /api/tags never succeeded (${lastErr}) — do not use this URL.`);
    stopAll(1);
  }
  const modelNames = (await tags.json().catch(() => ({})))?.models?.map((m) => m.name) ?? [];
  console.log(`[probe]  GET /api/tags → 200, models: ${modelNames.join(", ") || "none"}`);

  if (probeChat) {
    const res = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OLLAMA_MODEL ?? modelNames[0],
        messages: [{ role: "user", content: "reply with OK" }],
        stream: false,
        think: false,
        options: { num_predict: 8 },
      }),
      signal: AbortSignal.timeout(120_000),
    }).catch((e) => e);
    if (!res?.ok) {
      console.error(`[probe]  POST /api/chat → ${res?.status ?? res?.message ?? "failed"}`);
      stopAll(1);
    }
    const body = await res.json();
    console.log(`[probe]  POST /api/chat → 200, reply: ${JSON.stringify(body?.message?.content ?? "")}`);
  }

  console.log(
    `\nSet this in Railway → backend service → Variables:\n\n  OLLAMA_URL=${url}\n\n` +
      "Keep this terminal open: the URL lives only while this process and Ollama run.\n" +
      "Restarting changes the URL (update Railway, then redeploy/restart the service).\n",
  );

  process.on("SIGINT", () => stopAll(0));
  process.on("SIGTERM", () => stopAll(0));
}

main().catch((err) => {
  console.error(`failed: ${err.message}`);
  process.exit(1);
});
