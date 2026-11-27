import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createGitHub } from "./github.mjs";
import { boundedText, config, LIMITS, positiveInteger, requireValue } from "./policy.mjs";

const models = [
  "opencode/deepseek-v4.1-flash",
  "opencode/glm-5.3-flash-free",
  "opencode/deepseek-v4.1-flash-free",
];

class BudgetExhausted extends Error {
  constructor(message, pr) {
    super(message);
    this.pr = pr;
  }
}

async function checkPullBudget({ get, target, limit, runId }) {
  let attempts = 0;
  const runTitle = "OpenCode #" + target + " by ";
  for (let page = 1; page <= LIMITS.pages; page += 1) {
    const { workflow_runs: runs } = await get(
      "/actions/workflows/opencode.yml/runs?per_page=100&page=" + page,
    );
    requireValue(Array.isArray(runs), "Invalid workflow history");
    for (const run of runs) {
      if (String(run.id) === String(runId) || !run.display_title?.startsWith(runTitle)) continue;
      const { jobs } = await get(
        "/actions/runs/" + positiveInteger(run.id, "run") + "/jobs?filter=all&per_page=100",
      );
      requireValue(Array.isArray(jobs) && jobs.length < 100, "Invalid workflow jobs");
      const reserved = jobs.some(
        (job) =>
          job.name === "Authorize request" &&
          job.steps?.some(
            (step) =>
              step.name === "Reserve the authorized attempt" && step.conclusion === "success",
          ),
      );
      if (reserved) attempts += positiveInteger(run.run_attempt || 1, "run attempt");
      if (attempts >= limit) throw new BudgetExhausted("Pull request run budget exhausted", target);
    }
    if (runs.length < 100) return;
  }
  throw new Error("Workflow history exceeds safe pagination limit");
}

export async function authorizeOpenCode({
  github,
  event,
  env = process.env,
  clock = () => new Date(),
}) {
  const settings = config(env);
  const actor = env.GITHUB_ACTOR;
  const triage = env.GITHUB_EVENT_NAME === "issues";
  const inline = env.GITHUB_EVENT_NAME === "pull_request_review_comment";
  const author = triage ? event.issue?.user : event.comment?.user;
  requireValue(settings.enabled, "Agent automation disabled");
  requireValue(
    settings.allowedActors.includes(String(actor).toLowerCase()) && !actor.endsWith("[bot]"),
    "Actor not explicitly allowed",
  );
  requireValue(!env.GITHUB_RUN_ATTEMPT || env.GITHUB_RUN_ATTEMPT === "1", "Reruns are disabled");
  requireValue(
    (triage || inline || env.GITHUB_EVENT_NAME === "issue_comment") &&
      event.action === (triage ? "opened" : "created") &&
      event.repository?.full_name === settings.repository &&
      event.sender?.login === actor &&
      event.sender.type !== "Bot" &&
      author?.login === actor &&
      author.type !== "Bot",
    "Invalid OpenCode event or sender",
  );
  if (triage) {
    requireValue(isIncomingIssue(event.issue, actor), "Issue is ineligible for triage");
  }
  const body = triage ? null : boundedText(event.comment.body, "OpenCode command");
  requireValue(
    triage || /^\/(?:oc|opencode) +\S/.test(body),
    "Expected /oc or /opencode followed by a request",
  );
  const model = env.OPENCODE_MODEL || models[0];
  requireValue(models.includes(model), "Only the configured models are allowed");
  const target = positiveInteger(event.issue?.number || event.pull_request?.number);
  const base = `/repos/${settings.repository}`;
  const get = (path) => github.request("GET", `${base}${path}`);
  const permission = await get(`/collaborators/${encodeURIComponent(actor)}/permission`);
  requireValue(
    ["write", "maintain", "admin"].includes(permission.permission),
    "Write permission required",
  );
  if (!triage) {
    const comment = await get(
      `/${inline ? "pulls" : "issues"}/comments/${positiveInteger(event.comment.id, "comment")}`,
    );
    requireValue(comment.body === body && comment.user?.login === actor, "Trigger comment changed");
  }
  const issue = await get(`/issues/${target}`);
  requireValue(issue.state === "open", "Target must be open");
  const pr = Boolean(issue.pull_request || inline);
  if (triage) {
    requireValue(isIncomingIssue(issue, actor), "Issue is ineligible for triage");
  } else if (pr) {
    const pull = await get(`/pulls/${target}`);
    requireValue(
      pull.head?.repo?.full_name === settings.repository &&
        pull.base?.repo?.full_name === settings.repository,
      "Fork pull requests are disabled",
    );
  }

  if (pr) await checkPullBudget({ get, target, limit: settings.prRuns, runId: env.GITHUB_RUN_ID });
  const day = clock().toISOString().slice(0, 10);
  let daily = 0;
  let perTarget = 0;
  for (let page = 1; page <= LIMITS.pages; page += 1) {
    const { workflow_runs: runs } = await get(
      `/actions/workflows/opencode.yml/runs?created=${encodeURIComponent(`>=${day}`)}&per_page=100&page=${page}`,
    );
    requireValue(Array.isArray(runs), "Invalid workflow run list");
    for (const run of runs) {
      if (
        String(run.id) === String(env.GITHUB_RUN_ID) ||
        !settings.allowedActors.includes(String(run.actor?.login).toLowerCase())
      )
        continue;
      const { artifacts } = await get(
        `/actions/runs/${positiveInteger(run.id, "run")}/artifacts?per_page=100`,
      );
      requireValue(
        Array.isArray(artifacts) && artifacts.length < 100,
        "Invalid workflow artifact list",
      );
      const attempts = artifacts.some((artifact) => artifact.name === "opencode-request") ? 1 : 0;
      daily += attempts;
      if (run.display_title === `OpenCode #${target} by ${run.actor.login}`) perTarget += attempts;
    }
    if (daily >= settings.dailyRuns)
      throw new BudgetExhausted("Daily run budget exhausted", pr && target);
    if (!pr && perTarget >= settings.targetRuns)
      throw new BudgetExhausted("Target run budget exhausted");
    if (runs.length < 100) return { allowed: "true", model, ...(pr ? { pr: target } : {}) };
  }
  throw new Error("Workflow history exceeds safe pagination limit");
}

const preparedLabels = new Set(["ready-for-agent", "agent:spec", "agent:ticket"]);

function isIncomingIssue(issue, actor) {
  return (
    issue?.user?.login === actor &&
    issue.user.type === "User" &&
    !issue.pull_request &&
    Array.isArray(issue.labels) &&
    !issue.labels.some((label) => preparedLabels.has(label.name))
  );
}

export async function main(env = process.env) {
  let output;
  try {
    const raw = await readFile(env.GITHUB_EVENT_PATH, "utf8");
    requireValue(Buffer.byteLength(raw) <= LIMITS.context, "Event exceeds safe size limit");
    output = await authorizeOpenCode({ github: createGitHub(), event: JSON.parse(raw), env });
  } catch (error) {
    output =
      error instanceof BudgetExhausted && error.pr
        ? { allowed: "false", reason: "limit_exhausted", pr: error.pr }
        : { allowed: "false" };
    process.stderr.write(
      `OpenCode request rejected: ${error instanceof SyntaxError ? "Invalid event JSON" : error.message}\n`,
    );
  }
  const lines = Object.entries(output)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, lines);
  else process.stdout.write(lines);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
