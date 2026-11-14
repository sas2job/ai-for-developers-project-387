import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeHealth, runReport } from "../../script/agents/report.mjs";
import { publishAudit, runAudit } from "../../script/agents/audit.mjs";

const endpoint = "https://calendar.example.com/api/health";
const observedAt = "2026-11-13T10:00:00.000Z";
const environment = {
  GH_TOKEN: "fixture-token",
  GITHUB_REPOSITORY: "owner/calendar",
  GITHUB_REPOSITORY_OWNER: "owner",
  GITHUB_RUN_ID: "12345",
  GITHUB_EVENT_NAME: "schedule",
};

function githubFixture(issues = []) {
  const writes = [];
  const reads = [];
  return {
    issues,
    writes,
    reads,
    fetchImpl: async (url, options) => {
      const requestUrl = new URL(url);
      assert.equal(requestUrl.origin, "https://api.github.com");
      assert.equal(requestUrl.pathname, "/repos/owner/calendar/issues");
      assert.equal(options.headers.Authorization, "Bearer fixture-token");
      if (options.method === "GET") {
        reads.push(requestUrl);
        assert.equal(requestUrl.searchParams.get("state"), "open");
        const page = Number(requestUrl.searchParams.get("page"));
        return Response.json(
          issues.filter((issue) => issue.state === "open").slice((page - 1) * 100, page * 100),
        );
      }
      assert.equal(options.method, "POST");
      const issue = { ...JSON.parse(options.body), number: issues.length + 1, state: "open" };
      writes.push(issue);
      issues.push(issue);
      return Response.json(issue, { status: 201 });
    },
  };
}

async function failedReport() {
  return probeHealth({
    url: endpoint,
    observedAt,
    fetchImpl: async () => new Response("unavailable", { status: 503 }),
  });
}

test("a healthy public health endpoint produces a clean report", async () => {
  const requests = [];
  const report = await probeHealth({
    url: endpoint,
    observedAt,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ status: "ok" });
    },
  });

  assert.deepEqual(report, {
    schemaVersion: 1,
    observedAt,
    endpoint,
    status: "healthy",
    findings: [],
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, endpoint);
  assert.equal(requests[0].options.method, "GET");
  assert.equal(requests[0].options.redirect, "manual");
  assert.equal(requests[0].options.credentials, "omit");
});

test("only HTTP 200 can produce a healthy report", async () => {
  for (const status of [201, 202, 206]) {
    const report = await probeHealth({
      url: endpoint,
      observedAt,
      fetchImpl: async () => Response.json({ status: "ok" }, { status }),
    });
    assert.equal(report.status, "degraded");
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].kind, "http_error");
  }
});

test("invalid health URLs fail before making a request", async () => {
  let requests = 0;
  for (const url of [
    "http://calendar.example.com/api/health",
    "https://user:password@calendar.example.com/api/health",
    "https://localhost/api/health",
    "https://127.0.0.1/api/health",
    "https://[::1]/api/health",
    "https://calendar.internal/api/health",
    "https://calendar.example.com/admin",
    "https://calendar.example.com/api/health?token=secret",
    "https://calendar.example.com/api/health#secret",
    "https://calendar.example.com:8443/api/health",
  ]) {
    await assert.rejects(
      probeHealth({
        url,
        fetchImpl: async () => {
          requests += 1;
          return Response.json({ status: "ok" });
        },
      }),
      /health URL/,
    );
  }
  assert.equal(requests, 0);
});

test("failed health probes produce bounded findings without raw response or error data", async () => {
  for (const [kind, fetchImpl] of [
    ["http_error", async () => new Response("private response", { status: 503 })],
    ["http_error", async () => new Response("redirect", { status: 302 })],
    ["invalid_response", async () => new Response("private non-JSON response")],
    ["invalid_response", async () => Response.json({ status: "ok", extra: "x".repeat(9000) })],
    ["invalid_response", async () => Response.json({ unexpected: "private value" })],
    ["degraded", async () => Response.json({ status: "private unhealthy explanation" })],
    [
      "unreachable",
      async () => {
        throw new Error("secret transport details");
      },
    ],
  ]) {
    const report = await probeHealth({ url: endpoint, observedAt, fetchImpl });
    assert.equal(report.status, "degraded");
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].kind, kind);
    assert.match(report.findings[0].fingerprint, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(report), /private|secret/);
  }
});

test("health requests and response bodies time out within the configured deadline", async () => {
  for (const fetchImpl of [
    async () => new Promise(() => {}),
    async () => new Response(new ReadableStream({ start() {} })),
  ]) {
    const report = await probeHealth({ url: endpoint, observedAt, timeoutMs: 5, fetchImpl });
    assert.equal(report.status, "degraded");
    assert.equal(report.findings[0].kind, "timeout");
  }
});

test("transport details and observation time do not change a finding fingerprint", async () => {
  const reports = [];
  for (const [date, message] of [
    [observedAt, "TLS certificate expired 2026-11-13"],
    ["2026-11-14T10:00:00.000Z", "TLS certificate expired 2026-11-14"],
  ]) {
    reports.push(
      await probeHealth({
        url: endpoint,
        observedAt: date,
        fetchImpl: async () => {
          throw new Error(message);
        },
      }),
    );
  }
  assert.notEqual(reports[0].observedAt, reports[1].observedAt);
  assert.deepEqual(reports[0].findings, reports[1].findings);
  const github = githubFixture();
  for (const report of reports)
    await publishAudit({ report, env: environment, fetchImpl: github.fetchImpl });
  assert.equal(github.writes.length, 1);
});

test("publishing a finding twice creates one issue and no comments or updates", async () => {
  const report = await failedReport();
  const github = githubFixture();
  assert.deepEqual(await publishAudit({ report, env: environment, fetchImpl: github.fetchImpl }), {
    created: 1,
    duplicates: 0,
  });
  assert.deepEqual(await publishAudit({ report, env: environment, fetchImpl: github.fetchImpl }), {
    created: 0,
    duplicates: 1,
  });
  assert.equal(github.writes.length, 1);
  const issue = github.writes[0];
  assert.deepEqual(issue.labels, ["agent:audit", "needs-triage"]);
  assert.match(issue.body, /^<!-- agent:audit fingerprint:[a-f0-9]{64} -->$/m);
  assert.ok(issue.body.includes(observedAt));
  assert.ok(issue.body.includes("https://github.com/owner/calendar/actions/runs/12345"));
});

test("deduplication scans every open issue page before creating findings", async () => {
  const report = await failedReport();
  const marker = `<!-- agent:audit fingerprint:${report.findings[0].fingerprint} -->`;
  const github = githubFixture([
    ...Array.from({ length: 100 }, (_, index) => ({
      number: index + 1,
      state: "open",
      body: "Unrelated issue",
    })),
    { number: 101, state: "open", body: marker },
  ]);
  assert.deepEqual(await publishAudit({ report, env: environment, fetchImpl: github.fetchImpl }), {
    created: 0,
    duplicates: 1,
  });
  assert.equal(github.reads.length, 2);
  assert.equal(github.writes.length, 0);
});

test("an incomplete or over-budget issue scan fails before any writes", async () => {
  const report = await failedReport();
  let reads = 0;
  await assert.rejects(
    publishAudit({
      report,
      env: environment,
      fetchImpl: async (_url, options) => {
        assert.equal(options.method, "GET");
        reads += 1;
        if (reads > 100) throw new Error("Requested beyond scan budget");
        return Response.json(
          Array.from({ length: 100 }, (_, index) => ({
            number: index + 1,
            state: "open",
            body: "unrelated",
          })),
        );
      },
    }),
    /pagination limit/,
  );
  assert.equal(reads, 100);
});

test("PR markers, similar titles, and marker substrings do not suppress findings", async () => {
  const report = await failedReport();
  const current = report.findings[0];
  const marker = `<!-- agent:audit fingerprint:${current.fingerprint} -->`;
  const github = githubFixture([
    {
      number: 1,
      state: "open",
      body: marker,
      pull_request: { url: "https://api.github.com/repos/owner/calendar/pulls/1" },
    },
    {
      number: 2,
      state: "open",
      title: `[Health audit] ${current.title}`,
      body: `<!-- agent:audit fingerprint:${"0".repeat(64)} -->`,
    },
    { number: 3, state: "open", body: `prefix ${marker} suffix` },
  ]);
  assert.deepEqual(await publishAudit({ report, env: environment, fetchImpl: github.fetchImpl }), {
    created: 1,
    duplicates: 0,
  });
  assert.equal(github.writes.length, 1);
});

test("a finding can create a fresh issue when the previous occurrence is closed", async () => {
  const report = await failedReport();
  const github = githubFixture();
  await publishAudit({ report, env: environment, fetchImpl: github.fetchImpl });
  github.issues[0].state = "closed";
  assert.deepEqual(await publishAudit({ report, env: environment, fetchImpl: github.fetchImpl }), {
    created: 1,
    duplicates: 0,
  });
  assert.equal(github.writes.length, 2);
  assert.equal(github.issues[0].state, "closed");
});

test("malformed or forged report data is rejected before GitHub requests", async () => {
  const valid = await failedReport();
  const changes = [
    (report) => {
      report.schemaVersion = 2;
    },
    (report) => {
      report.unexpected = true;
    },
    (report) => {
      report.observedAt = "not a date";
    },
    (report) => {
      report.endpoint = "https://localhost/api/health";
    },
    (report) => {
      report.status = "healthy";
    },
    (report) => {
      report.findings = Array.from({ length: 4 }, () => ({ ...report.findings[0] }));
    },
    (report) => {
      report.findings.push({ ...report.findings[0] });
    },
    (report) => {
      report.findings[0].kind = "run_shell";
    },
    (report) => {
      report.findings[0].fingerprint = "0".repeat(64);
    },
    (report) => {
      report.findings[0].title = "untrusted title";
    },
    (report) => {
      report.findings[0].body = "x".repeat(3000);
    },
    (report) => {
      report.findings[0].body = "<!-- agent:audit fingerprint:injected -->";
    },
    (report) => {
      report.findings[0].extra = "untrusted";
    },
  ];
  let requests = 0;
  for (const change of changes) {
    const report = structuredClone(valid);
    change(report);
    await assert.rejects(
      publishAudit({
        report,
        env: environment,
        fetchImpl: async () => {
          requests += 1;
          return Response.json([]);
        },
      }),
      /report|health URL/,
    );
  }
  assert.equal(requests, 0);
});

test("disabled audits and healthy reports never contact GitHub", async () => {
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    throw new Error("Unexpected GitHub request");
  };
  assert.deepEqual(
    await publishAudit({ report: undefined, env: { AGENT_ENABLED: "false" }, fetchImpl }),
    { skipped: "disabled", created: 0, duplicates: 0 },
  );
  const report = await probeHealth({
    url: endpoint,
    observedAt,
    fetchImpl: async () => Response.json({ status: "ok" }),
  });
  assert.deepEqual(await publishAudit({ report, env: environment, fetchImpl }), {
    created: 0,
    duplicates: 0,
  });
  assert.equal(requests, 0);
});

test("publishing requires scheduled or owner-requested execution in the configured repository", async () => {
  const report = await failedReport();
  const invalidEnvironments = [
    { GH_TOKEN: "" },
    { GITHUB_REPOSITORY: "owner/calendar/elsewhere" },
    { GITHUB_REPOSITORY_OWNER: "someone-else" },
    { GITHUB_RUN_ID: "$(untrusted)" },
    { GITHUB_EVENT_NAME: "issue_comment" },
    { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_ACTOR: "outsider" },
  ];
  let requests = 0;
  for (const override of invalidEnvironments) {
    await assert.rejects(
      publishAudit({
        report,
        env: { ...environment, ...override },
        fetchImpl: async () => {
          requests += 1;
          return Response.json([]);
        },
      }),
      /context/,
    );
  }
  assert.equal(requests, 0);
  const github = githubFixture();
  assert.deepEqual(
    await publishAudit({
      report,
      env: { ...environment, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_ACTOR: "owner" },
      fetchImpl: github.fetchImpl,
    }),
    { created: 1, duplicates: 0 },
  );
});

test("failed or malformed GitHub scans do not create issues or expose raw errors", async () => {
  const report = await failedReport();
  for (const response of [
    new Response("secret API error", { status: 403 }),
    new Response("secret invalid JSON"),
    Response.json({ message: "secret wrong shape" }),
    Response.json([{ number: 1, state: "open", body: 42 }]),
  ]) {
    let writes = 0;
    await assert.rejects(
      publishAudit({
        report,
        env: environment,
        fetchImpl: async (_url, options) => {
          if (options.method === "POST") writes += 1;
          return response;
        },
      }),
      (error) => /GitHub/.test(error.message) && !/secret/.test(error.message),
    );
    assert.equal(writes, 0);
  }
});

test("report and audit entrypoints exchange a JSON file when the probe fails", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "health-audit-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "report.json");
  const report = await runReport(["--url", endpoint, "--output", output], {
    env: {},
    fetchImpl: async () => {
      throw new Error("Transport secret");
    },
  });
  assert.equal(report.status, "degraded");
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), report);
  const github = githubFixture();
  assert.deepEqual(
    await runAudit(["--report", output], { env: environment, fetchImpl: github.fetchImpl }),
    { created: 1, duplicates: 0 },
  );
  assert.equal(github.writes.length, 1);
  await writeFile(output, "{malformed private report");
  await assert.rejects(
    runAudit(["--report", output], { env: environment, fetchImpl: github.fetchImpl }),
    /Invalid report JSON/,
  );
  await writeFile(output, "x".repeat(32769));
  await assert.rejects(
    runAudit(["--report", output], { env: environment, fetchImpl: github.fetchImpl }),
    /report file/,
  );
  assert.equal(github.writes.length, 1);
});

test("one audit creates at most three distinct finding issues", async () => {
  const reports = await Promise.all([
    failedReport(),
    probeHealth({
      url: endpoint,
      observedAt,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    }),
    probeHealth({
      url: endpoint,
      observedAt,
      fetchImpl: async () => Response.json({ status: "degraded" }),
    }),
  ]);
  const report = { ...reports[0], findings: reports.flatMap((item) => item.findings) };
  const github = githubFixture();
  assert.deepEqual(await publishAudit({ report, env: environment, fetchImpl: github.fetchImpl }), {
    created: 3,
    duplicates: 0,
  });
  assert.equal(github.writes.length, 3);
});
