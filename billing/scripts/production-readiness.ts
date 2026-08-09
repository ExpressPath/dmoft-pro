import { query as databaseQuery } from "../src/lib/db";
import { getEnv } from "../src/lib/env";
import { assessStaticProductionReadiness, createReadinessReport } from "../src/lib/readiness";
import { runProductionReadiness } from "../src/lib/readiness-probes";
import { getStripe } from "../src/lib/stripe";

async function main(): Promise<void> {
  const now = new Date();
  const env = getEnv();
  const staticOnly = process.argv.includes("--static");
  const report = staticOnly
    ? createReadinessReport(assessStaticProductionReadiness(env, now), now)
    : await runProductionReadiness(env, {
      stripe: getStripe(),
      query: async (text, values) => {
        const result = await databaseQuery(text, values);
        return { rows: result.rows };
      },
    }, now);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ready) process.exitCode = 1;
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify({
    version: 1,
    ready: false,
    checks: [{
      id: "readiness.unhandled_failure",
      category: "configuration",
      status: "fail",
      summary: "The readiness runner completed without an unhandled failure.",
      remediation: "Validate server configuration and probe access, then rerun with protected logs.",
    }],
  }, null, 2)}\n`);
  process.exitCode = 2;
});
