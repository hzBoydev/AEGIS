// CLI: npm run redteam -- [--llm]
// Jalankan dari backend/ (SQLite path CWD-relative; config butuh .env).
import { runRedTeam } from "./src/redTeam.js";

const mode = process.argv.includes("--llm") ? "llm" : "fast";

console.log(`[RedTeam] mode=${mode} — menjalankan suite…`);

runRedTeam(mode)
  .then((report) => {
    console.log(`\n[RedTeam] ─── Hasil (${report.mode}) ───`);
    for (const c of report.cases) {
      const mark = c.pass ? "✓" : "✗";
      console.log(`  ${mark} [${c.category}] ${c.name}`);
      console.log(`      ${c.detail}`);
    }
    console.log(
      `\n[RedTeam] ${report.passed}/${report.total} lulus · ${report.failed} gagal · ${report.durationMs}ms`
    );
    process.exit(report.failed === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("[RedTeam] Runner error:", err);
    process.exit(1);
  });
