import { startEventDrivenOracle } from "./src/poller.js";
import { startServer } from "./src/server.js";
import { config } from "./src/config.js";

const PORT = Number(process.env.PORT) || 3001;

startServer(PORT);
startEventDrivenOracle();
void probeOllama();

async function probeOllama(): Promise<void> {
  try {
    const res = await fetch(`${config.OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log(`[LLM]     Ollama reachable at ${config.OLLAMA_URL}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[LLM]     Ollama UNREACHABLE at ${config.OLLAMA_URL} (${reason}). ` +
        `Set OLLAMA_URL to a publicly reachable instance — without an LLM the debate pipeline cannot run.`
    );
  }
}
