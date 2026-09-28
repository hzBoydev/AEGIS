// CLI: npm run redteam -- [--llm]
// Run from backend/ (SQLite path is CWD-relative; config requires .env).
import { runRedTeam } from "./src/redTeam.js";

const mode = process.argv.includes("--llm") ? "llm" : "fast";

console.log(`[RedTeam] mode=${mode} — running suite…`);

runRedTeam(mode)
  .then((report) => {
    console.log(`\n[RedTeam] ─── Result (${report.mode}) ───`);
    for (const c of report.cases) {
      const mark = c.pass ? "✓" : "✗";
      console.log(`  ${mark} [${c.category}] ${c.name}`);
      console.log(`      ${c.detail}`);
    }
    console.log(
      `\n[RedTeam] ${report.passed}/${report.total} passed · ${report.failed} failed · ${report.durationMs}ms`
    );
    process.exit(report.failed === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("[RedTeam] Runner error:", err);
    process.exit(1);
  });
