/**
 * Standalone benchmark script (FINAL OUTPUT deliverable #14).
 *
 * The benchmark harness itself lives in the running API
 * (backend/src/benchmark) so it always uses the same adapters, config, and
 * Phase 3 index decision the rest of the app does - this script is a thin,
 * scriptable CLI wrapper around that API for CI pipelines or ad-hoc runs,
 * rather than a second, divergent implementation of the same logic.
 *
 * Usage:
 *   API_BASE_URL=http://localhost:3000/api \
 *   AUTH_EMAIL=you@example.com AUTH_PASSWORD=your-password \
 *   PROJECT_ID=<project-uuid> \
 *   npx ts-node scripts/run-benchmark.ts [sampleSize] [queryCount]
 */

const baseUrl = process.env.API_BASE_URL ?? 'http://localhost:3000/api';
const projectId = process.env.PROJECT_ID;
const email = process.env.AUTH_EMAIL;
const password = process.env.AUTH_PASSWORD;
const sampleSize = process.argv[2] ? Number(process.argv[2]) : undefined;
const queryCount = process.argv[3] ? Number(process.argv[3]) : undefined;

async function main(): Promise<void> {
  if (!projectId || !email || !password) {
    console.error('Set PROJECT_ID, AUTH_EMAIL, and AUTH_PASSWORD environment variables.');
    process.exitCode = 1;
    return;
  }

  const loginResponse = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!loginResponse.ok) {
    throw new Error(`Login failed: ${loginResponse.status} ${await loginResponse.text()}`);
  }
  const { accessToken } = (await loginResponse.json()) as { accessToken: string };

  const benchmarkResponse = await fetch(`${baseUrl}/projects/${projectId}/optimization/benchmarks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ sampleSize, queryCount }),
  });
  if (!benchmarkResponse.ok) {
    throw new Error(`Benchmark run failed: ${benchmarkResponse.status} ${await benchmarkResponse.text()}`);
  }
  const report = await benchmarkResponse.json();

  console.log(`Index type: ${report.indexType}`);
  console.log(`Recommended: ${report.recommendedVariant.searchParamName} = ${report.recommendedVariant.searchParamValue}`);
  console.log('');
  console.log(`${report.variantResults[0]?.searchParamName ?? 'param'}\tP50\tP95\tP99\tRecall\tQPS`);
  for (const v of report.variantResults) {
    console.log(`${v.searchParamValue}${v.isBaseline ? ' (baseline)' : ''}\t${v.p50LatencyMs}\t${v.p95LatencyMs}\t${v.p99LatencyMs}\t${v.avgRecall}\t${v.achievedQps}`);
  }
  console.log('');
  for (const bottleneck of report.bottlenecks) {
    console.log(`- ${bottleneck}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
