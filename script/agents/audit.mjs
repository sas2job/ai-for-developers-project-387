import {
  FINDING_BODIES,
  FINDING_TITLES,
  findingFingerprint,
  validateHealthUrl,
} from "./report.mjs";
import { readFile, stat } from "node:fs/promises";
import { parseArgs } from "node:util";

function exactKeys(value, expected) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

async function githubRequest(fetchImpl, url, options) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
      headers: {
        ...options.headers,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch {
    throw new Error("GitHub audit request failed or timed out");
  }
  if (!response.ok) throw new Error(`GitHub audit request failed with HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error("Invalid GitHub audit response JSON");
  }
}

export function validateReport(report) {
  const reject = () => {
    throw new Error("Invalid health report schema or finding");
  };
  if (
    !exactKeys(report, ["schemaVersion", "observedAt", "endpoint", "status", "findings"]) ||
    report.schemaVersion !== 1 ||
    typeof report.observedAt !== "string" ||
    !Number.isFinite(Date.parse(report.observedAt)) ||
    new Date(report.observedAt).toISOString() !== report.observedAt ||
    typeof report.endpoint !== "string" ||
    validateHealthUrl(report.endpoint) !== report.endpoint ||
    !Array.isArray(report.findings) ||
    report.findings.length > 3 ||
    !["healthy", "degraded"].includes(report.status) ||
    (report.status === "healthy") !== (report.findings.length === 0)
  )
    reject();
  const fingerprints = new Set();
  for (const item of report.findings) {
    if (
      !exactKeys(item, ["fingerprint", "title", "body", "kind"]) ||
      typeof item.kind !== "string" ||
      !Object.hasOwn(FINDING_TITLES, item.kind) ||
      item.fingerprint !== findingFingerprint(report.endpoint, item.kind) ||
      item.title !== FINDING_TITLES[item.kind] ||
      typeof item.body !== "string" ||
      item.body.length > 1024 ||
      (item.kind === "http_error"
        ? !/^The public health endpoint returned HTTP [1-5][0-9]{2}\.$/.test(item.body)
        : item.body !== FINDING_BODIES[item.kind]) ||
      fingerprints.has(item.fingerprint)
    )
      reject();
    fingerprints.add(item.fingerprint);
  }
  return report;
}

export async function publishAudit({ report, env = process.env, fetchImpl = fetch }) {
  if (String(env.AGENT_ENABLED).toLowerCase() === "false")
    return { skipped: "disabled", created: 0, duplicates: 0 };
  validateReport(report);
  if (report.findings.length === 0) return { created: 0, duplicates: 0 };
  const repository = env.GITHUB_REPOSITORY;
  const owner = repository?.split("/")[0];
  if (
    typeof repository !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/i.test(repository) ||
    typeof env.GH_TOKEN !== "string" ||
    !env.GH_TOKEN.trim() ||
    !/^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID ?? "") ||
    env.GITHUB_REPOSITORY_OWNER?.toLowerCase() !== owner?.toLowerCase() ||
    !(
      env.GITHUB_EVENT_NAME === "schedule" ||
      (env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
        env.GITHUB_ACTOR?.toLowerCase() === owner?.toLowerCase())
    )
  ) {
    throw new Error(
      "Invalid audit publishing context: expected scheduled or owner manual GitHub Actions execution",
    );
  }
  const url = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/issues`;
  const headers = {
    Authorization: `Bearer ${env.GH_TOKEN}`,
    Accept: "application/vnd.github+json",
  };
  const issues = [];
  for (let page = 1; ; page += 1) {
    const batch = await githubRequest(fetchImpl, `${url}?state=open&per_page=100&page=${page}`, {
      method: "GET",
      headers,
    });
    if (
      !Array.isArray(batch) ||
      batch.length > 100 ||
      batch.some(
        (issue) =>
          !issue ||
          !Number.isSafeInteger(issue.number) ||
          issue.number < 1 ||
          !["open", "closed"].includes(issue.state) ||
          (issue.body != null && (typeof issue.body !== "string" || issue.body.length > 65_536)),
      )
    ) {
      throw new Error("Invalid GitHub audit issue listing");
    }
    issues.push(...batch);
    if (batch.length < 100) break;
    if (page === 100)
      throw new Error("Audit issue pagination limit exceeded; no issues were created");
  }
  let created = 0;
  let duplicates = 0;
  for (const finding of report.findings) {
    const marker = `<!-- agent:audit fingerprint:${finding.fingerprint} -->`;
    if (
      issues.some(
        (issue) =>
          issue.state === "open" &&
          !issue.pull_request &&
          issue.body?.split(/\r?\n/).includes(marker),
      )
    ) {
      duplicates += 1;
      continue;
    }
    await githubRequest(fetchImpl, url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: `[Health audit] ${finding.title}`,
        body: `${finding.body}\n\nEndpoint: ${report.endpoint}\nObserved at: ${report.observedAt}\nRun: https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}\n\n${marker}`,
        labels: ["agent:audit", "needs-triage"],
      }),
    });
    created += 1;
  }
  return { created, duplicates };
}

export async function runAudit(args, { env = process.env, fetchImpl = fetch } = {}) {
  if (String(env.AGENT_ENABLED).toLowerCase() === "false")
    return { skipped: "disabled", created: 0, duplicates: 0 };
  const { values } = parseArgs({ args, options: { report: { type: "string" } }, strict: true });
  if (!values.report) throw new Error("Audit requires --report <path>");
  const file = await stat(values.report);
  if (!file.isFile() || file.size > 32_768)
    throw new Error("Invalid report file: maximum size is 32 KiB");
  let report;
  try {
    report = JSON.parse(await readFile(values.report, "utf8"));
  } catch {
    throw new Error("Invalid report JSON");
  }
  return publishAudit({ report, env, fetchImpl });
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await runAudit(process.argv.slice(2))));
  } catch (error) {
    console.error(`Health audit failed: ${error.message}`);
    process.exitCode = 1;
  }
}
