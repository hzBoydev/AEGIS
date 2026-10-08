import { startEventDrivenOracle } from "./src/poller.js";
import { startServer } from "./src/server.js";
import { config } from "./src/config.js";

const PORT = Number(process.env.PORT) || 3001;

startServer(PORT);
startEventDrivenOracle();
void probeOllama();

async function probeOllama(): Promise<void> {
  try {
    // With a key we hit a hosted endpoint, where GET /api/tags is public and
    // returns 200 even with a REVOKED key — that would report "reachable" while
    // every inference call later 401s into a fail-safe REJECT. Validate the key
    // itself via POST /api/me. A local daemon has no such endpoint and no key,
    // so it falls back to the public /api/tags listing.
    const check = config.OLLAMA_API_KEY
      ? fetch(`${config.OLLAMA_URL}/api/me`, {
          method: "POST",
          headers: config.OLLAMA_HEADERS,
          body: "{}",
          signal: AbortSignal.timeout(5_000),
        })
      : fetch(`${config.OLLAMA_URL}/api/tags`, {
          headers: config.OLLAMA_HEADERS,
          signal: AbortSignal.timeout(5_000),
        });
    const res = await check;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log(
      config.OLLAMA_API_KEY
        ? `[LLM]     Ollama reachable and API key accepted at ${config.OLLAMA_URL}`
        : `[LLM]     Ollama reachable at ${config.OLLAMA_URL}`
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[LLM]     Ollama NOT READY at ${config.OLLAMA_URL} (${reason}). ` +
        (reason === "HTTP 401"
          ? `OLLAMA_API_KEY is rejected — revoke it at ${config.OLLAMA_URL}/settings/keys and create a fresh one. ` +
            `Without valid credentials every LLM call 401s and the pipeline fail-safe REJECTs. `
          : `Set OLLAMA_URL to a publicly reachable instance — without an LLM the debate pipeline cannot run. `) +
        `Until this is fixed the pipeline fail-safe REJECTs every escrow.`
    );
  }
}
