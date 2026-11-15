import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

export const DEFAULT_HEALTH_URL = "https://ai-hexlet.duckdns.org/api/health";
export const FINDING_TITLES = Object.freeze({
  http_error: "Public health endpoint returned an HTTP error",
  invalid_response: "Public health endpoint returned an invalid response",
  degraded: "Public health endpoint reported a degraded status",
  unreachable: "Public health endpoint is unreachable",
  timeout: "Public health endpoint timed out",
});
export const FINDING_BODIES = Object.freeze({
  invalid_response: 'Expected a JSON object with status "ok" within an 8 KiB response.',
  degraded: 'The public health endpoint returned a status other than "ok".',
  unreachable:
    "The public health endpoint could not be reached. No raw transport details were retained.",
  timeout: "The public health endpoint did not complete within the 10 second request budget.",
});

export function findingFingerprint(endpoint, kind) {
  return createHash("sha256").update(`${endpoint}\n${kind}`).digest("hex");
}

function finding(endpoint, kind, body = FINDING_BODIES[kind]) {
  return {
    fingerprint: findingFingerprint(endpoint, kind),
    title: FINDING_TITLES[kind],
    body,
    kind,
  };
}

async function readHealthResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty health response");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) throw new Error("Health response exceeds limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function validateHealthUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid health URL: expected a public HTTPS /api/health URL");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/api/health" ||
    url.search ||
    url.hash ||
    isIP(host) ||
    host.includes(":") ||
    !host.includes(".") ||
    !/^[a-z0-9.-]+$/.test(host) ||
    host
      .split(".")
      .some(
        (label) => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"),
      ) ||
    /\.(localhost|local|internal|test|invalid|example|onion)$/.test(host)
  ) {
    throw new Error("Invalid health URL: expected a public HTTPS /api/health URL");
  }
  return url.href;
}

export async function probeHealth({
  url = DEFAULT_HEALTH_URL,
  fetchImpl = fetch,
  observedAt = new Date().toISOString(),
  timeoutMs = 10_000,
} = {}) {
  const endpoint = validateHealthUrl(url);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new Error("Health timeout must be between 1 and 10000 milliseconds");
  }
  if (typeof observedAt !== "string" || new Date(observedAt).toISOString() !== observedAt) {
    throw new Error("Invalid health observation date");
  }
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Health probe timed out"));
    }, timeoutMs);
  });
  let result;
  try {
    const request = (async () => {
      const response = await fetchImpl(endpoint, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        result = finding(
          endpoint,
          "http_error",
          `The public health endpoint returned HTTP ${response.status}.`,
        );
      } else {
        try {
          const health = await readHealthResponse(response);
          if (!health || Array.isArray(health) || typeof health.status !== "string") {
            throw new Error("Missing health status");
          }
          if (health.status !== "ok") {
            result = finding(endpoint, "degraded");
          }
        } catch {
          result = finding(endpoint, "invalid_response");
        }
      }
    })();
    await Promise.race([request, deadline]);
  } catch {
    result = controller.signal.aborted
      ? finding(endpoint, "timeout")
      : finding(endpoint, "unreachable");
  } finally {
    clearTimeout(timer);
  }
  return {
    schemaVersion: 1,
    observedAt,
    endpoint,
    status: result ? "degraded" : "healthy",
    findings: result ? [result] : [],
  };
}

export async function runReport(args, { env = process.env, fetchImpl = fetch } = {}) {
  if (String(env.AGENT_ENABLED).toLowerCase() === "false") return { skipped: "disabled" };
  const { values } = parseArgs({
    args,
    options: { url: { type: "string" }, output: { type: "string" } },
    strict: true,
  });
  if (!values.output) throw new Error("Health report requires --output <path>");
  const report = await probeHealth({ url: values.url, fetchImpl });
  await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return report;
}

if (import.meta.main) {
  try {
    const report = await runReport(process.argv.slice(2));
    console.log(
      JSON.stringify({
        status: report.status,
        skipped: report.skipped,
        findings: report.findings?.length,
      }),
    );
  } catch (error) {
    console.error(`Health report failed: ${error.message}`);
    process.exitCode = 1;
  }
}
