import { appendFile, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { githubRequest, listAuditIssues, publishAudit, validateReport } from "./audit.mjs";

const journalMarker = "<!-- agent:audit journal:v1 -->";

export function validateAnalysis(value, report) {
  const boundedText = (text) =>
    typeof text === "string" && text.trim().length > 0 && text.length <= 2000;
  if (
    !value ||
    Object.keys(value).sort().join() !== "findings,summary" ||
    !boundedText(value.summary) ||
    !Array.isArray(value.findings) ||
    value.findings.length !== report.findings.length ||
    new Set(value.findings.map((item) => item?.fingerprint)).size !== value.findings.length ||
    value.findings.some(
      (item) =>
        !item ||
        Object.keys(item).sort().join() !== "action,existingIssue,fingerprint" ||
        !report.findings.some((finding) => finding.fingerprint === item.fingerprint) ||
        !boundedText(item.action) ||
        !(
          item.existingIssue === null ||
          (Number.isSafeInteger(item.existingIssue) && item.existingIssue > 0)
        ),
    )
  )
    throw new Error("Invalid model audit analysis: expected summary and every report finding");
  return value;
}

export async function prepareAudit({ report, env = process.env, fetchImpl = fetch }) {
  validateReport(report);
  const issues = await listAuditIssues({ env, fetchImpl });
  return {
    report,
    openIssues: issues
      .filter(
        (issue) =>
          !issue.pull_request &&
          !issue.body?.includes(journalMarker) &&
          Boolean(issue.title?.startsWith("[Учебный аудит]")) === Boolean(report.training),
      )
      .map(({ number, title, body }) => ({ number, title, body })),
  };
}

export async function finishAudit({
  report,
  analysis,
  publish = true,
  env = process.env,
  fetchImpl = fetch,
}) {
  validateReport(report);
  validateAnalysis(analysis, report);
  const run = `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  const result = publish
    ? await publishAudit({ report, analysis, env, fetchImpl })
    : { created: 0, duplicates: 0, skipped: "publication disabled" };
  const markdown =
    [
      journalMarker,
      "## Последний аудит приложения",
      report.training
        ? "**Учебный отчёт: синтетический HTTP 503; дефект приложения не подтверждён.**"
        : "Проверка реального приложения.",
      `Приложение: ${report.endpoint}`,
      `Наблюдение: ${report.observedAt}`,
      `Прогон: ${run}`,
      "Исходные данные: артефакт application-health-report / health-report.json (7 дней).",
      `Вывод OpenCode: ${analysis.summary}`,
      ...analysis.findings.map(
        (item) =>
          `- ${item.action}${item.existingIssue ? ` (существующая задача #${item.existingIssue})` : ""}`,
      ),
      `Создано задач: ${result.created}. Повторных находок: ${result.duplicates}.`,
      "Список находок: https://github.com/" +
        env.GITHUB_REPOSITORY +
        "/issues?q=is%3Aissue+label%3Aagent%3Aaudit",
      "Журнал хранит последний вывод; отдельные задачи сохраняют проблему, действие и ссылку на исходный прогон. Решение о реализации принимает человек.",
    ].join("\n\n") + "\n";
  if (publish) {
    const issues = await listAuditIssues({ env, fetchImpl });
    const journal = issues.find(
      (issue) => !issue.pull_request && issue.body?.split(/\r?\n/).includes(journalMarker),
    );
    const response = await githubRequest(
      fetchImpl,
      `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/issues${journal ? `/${journal.number}` : ""}`,
      {
        method: journal ? "PATCH" : "POST",
        headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json" },
        body: JSON.stringify({
          title: "Журнал регулярного аудита приложения",
          body: markdown,
          ...(journal ? {} : { labels: ["agent:audit"] }),
        }),
      },
    );
    result.journal = response.html_url;
  }
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, markdown);
  return { ...result, markdown };
}

export async function runAuditAgent(args, { env = process.env, fetchImpl = fetch } = {}) {
  const { values } = parseArgs({
    args,
    options: {
      report: { type: "string" },
      context: { type: "string" },
      analysis: { type: "string" },
      output: { type: "string" },
      publish: { type: "boolean", default: false },
    },
    strict: true,
  });
  const report = validateReport(JSON.parse(await readFile(values.report, "utf8")));
  if (values.context) {
    const context = await prepareAudit({ report, env, fetchImpl });
    await writeFile(values.context, JSON.stringify(context, null, 2));
    return;
  }
  const raw = await readFile(values.analysis, "utf8");
  const analysis = validateAnalysis(
    JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1")),
    report,
  );
  const result = await finishAudit({ report, analysis, publish: values.publish, env, fetchImpl });
  await writeFile(values.output, result.markdown);
  console.log(
    JSON.stringify({
      created: result.created,
      duplicates: result.duplicates,
      journal: result.journal,
    }),
  );
}

if (import.meta.main) {
  try {
    await runAuditAgent(process.argv.slice(2));
  } catch (error) {
    console.error(`Audit agent failed: ${error.message}`);
    process.exitCode = 1;
  }
}
