import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeHealth, runReport } from "../../script/agents/report.mjs";
import { finishAudit, prepareAudit, validateAnalysis } from "../../script/agents/audit-agent.mjs";
import { validateReport } from "../../script/agents/audit.mjs";

const endpoint = "https://calendar.example.com/api/health";
const env = {
  GH_TOKEN: "fixture-token",
  GITHUB_REPOSITORY: "owner/calendar",
  GITHUB_REPOSITORY_OWNER: "owner",
  GITHUB_RUN_ID: "12345",
  GITHUB_EVENT_NAME: "schedule",
};
const failedReport = () =>
  probeHealth({ url: endpoint, fetchImpl: async () => new Response(null, { status: 503 }) });
const analysisFor = (report) => ({
  summary: report.training
    ? "Учебная находка, дефект не подтверждён."
    : "HTTP 503 требует проверки сервиса.",
  findings: report.findings.map(({ fingerprint }) => ({
    fingerprint,
    action: "Проверить health endpoint и журнал сервиса.",
    existingIssue: null,
  })),
});

function githubFixture() {
  const issues = [];
  const writes = [];
  return {
    issues,
    writes,
    fetchImpl: async (url, options) => {
      if (options.method === "GET") return Response.json(issues);
      const data = JSON.parse(options.body);
      writes.push({ method: options.method, data });
      if (options.method === "PATCH") {
        const issue = issues.find((item) => url.endsWith(`/${item.number}`));
        Object.assign(issue, data);
        return Response.json(issue);
      }
      const issue = {
        ...data,
        number: issues.length + 1,
        state: "open",
        html_url: `https://github.com/owner/calendar/issues/${issues.length + 1}`,
      };
      issues.push(issue);
      return Response.json(issue, { status: 201 });
    },
  };
}

test("training uses reproducible synthetic data without contacting the application and has a separate fingerprint", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "audit-training-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "report.json");
  const options = {
    env: {},
    fetchImpl: async () => {
      throw new Error("Must not contact the application");
    },
  };
  const first = await runReport(["--url", endpoint, "--output", path, "--training"], options);
  const second = await runReport(["--url", endpoint, "--output", path, "--training"], options);
  assert.deepEqual(first, second);
  assert.equal(validateReport(first).training, true);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), first);
  assert.notEqual(first.findings[0].fingerprint, (await failedReport()).findings[0].fingerprint);
  assert.throws(() => validateReport({ ...first, training: false }), /Invalid/);
});

test("two model audits create one finding and one journal without duplicate comments", async () => {
  const report = await failedReport();
  const analysis = analysisFor(report);
  const github = githubFixture();
  const first = await finishAudit({ report, analysis, env, fetchImpl: github.fetchImpl });
  assert.equal(first.created, 1);
  assert.match(github.issues[0].body, /Предлагаемое действие: Проверить health endpoint/);
  assert.match(github.issues[0].body, /application-health-report/);
  const context = await prepareAudit({ report, env, fetchImpl: github.fetchImpl });
  assert.equal(context.openIssues[0].number, 1);
  assert.equal(context.openIssues.length, 1);
  const second = await finishAudit({ report, analysis, env, fetchImpl: github.fetchImpl });
  assert.equal(second.created, 0);
  assert.equal(second.duplicates, 1);
  assert.equal(github.issues.length, 2);
  assert.equal(github.writes.filter(({ method }) => method === "POST").length, 2);
  assert.match(github.issues[1].body, /Создано задач: 0. Повторных находок: 1/);
});

test("the model can identify an existing ordinary issue without an audit fingerprint", async () => {
  const report = await failedReport();
  const analysis = analysisFor(report);
  const github = githubFixture();
  github.issues.push({ number: 42, state: "open", title: "Health returns 503", body: endpoint });
  analysis.findings[0].existingIssue = 42;
  const result = await finishAudit({ report, analysis, env, fetchImpl: github.fetchImpl });
  assert.equal(result.created, 0);
  assert.equal(result.duplicates, 1);
  analysis.findings[0].existingIssue = 99;
  await assert.rejects(
    finishAudit({ report, analysis, env, fetchImpl: github.fetchImpl }),
    /no longer open/,
  );
});

test("a clean report leaves a durable model conclusion without a finding issue", async () => {
  const report = await probeHealth({
    url: endpoint,
    fetchImpl: async () => Response.json({ status: "ok" }),
  });
  const github = githubFixture();
  const result = await finishAudit({
    report,
    analysis: { summary: "Находок нет; health вернул status ok.", findings: [] },
    env,
    fetchImpl: github.fetchImpl,
  });
  assert.equal(result.created, 0);
  assert.equal(github.issues.length, 1);
  assert.match(github.issues[0].body, /Находок нет/);
  assert.match(github.issues[0].body, /actions\/runs\/12345/);
});

test("invalid or incomplete model output fails before any publication", async () => {
  const report = await failedReport();
  const valid = analysisFor(report);
  for (const analysis of [
    null,
    { summary: "No findings", findings: [] },
    { ...valid, summary: "" },
    { ...valid, findings: [{ ...valid.findings[0], fingerprint: "0".repeat(64) }] },
    { ...valid, findings: [{ ...valid.findings[0], existingIssue: "42" }] },
  ]) {
    const github = githubFixture();
    assert.throws(() => validateAnalysis(analysis, report), /Invalid model/);
    await assert.rejects(
      finishAudit({ report, analysis, env, fetchImpl: github.fetchImpl }),
      /Invalid model/,
    );
    assert.equal(github.writes.length, 0);
  }
});

test("publication can be disabled while retaining the model conclusion", async () => {
  const report = await failedReport();
  const result = await finishAudit({
    report,
    analysis: analysisFor(report),
    publish: false,
    env,
    fetchImpl: async () => {
      throw new Error("Unexpected request");
    },
  });
  assert.equal(result.created, 0);
  assert.match(result.markdown, /HTTP 503/);
});

test("the kill switch prevents both finding and journal publication even after model execution", async () => {
  const report = await failedReport();
  const result = await finishAudit({
    report,
    analysis: analysisFor(report),
    env: { ...env, AGENT_ENABLED: "false" },
    fetchImpl: async () => {
      throw new Error("Disabled audits must never contact GitHub");
    },
  });
  assert.equal(result.skipped, "disabled");
  assert.equal(result.created, 0);
  assert.match(result.markdown, /Аудит отключён/);
});
