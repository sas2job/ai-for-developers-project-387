import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createGitHub } from "./github.mjs";
import { boundedText, config, LIMITS, positiveInteger, requireValue } from "./policy.mjs";

const defaultModel = "opencode/deepseek-v4.1-flash-free";

export async function authorizeOpenCode({
  github,
  event,
  env = process.env,
  clock = () => new Date(),
}) {
  const settings = config(env);
  const actor = env.GITHUB_ACTOR;
  requireValue(settings.enabled, "Agent automation disabled");
  requireValue(
    settings.allowedActors.includes(String(actor).toLowerCase()) && !actor.endsWith("[bot]"),
    "Actor not explicitly allowed",
  );
  requireValue(!env.GITHUB_RUN_ATTEMPT || env.GITHUB_RUN_ATTEMPT === "1", "Reruns are disabled");
  requireValue(
    ["issue_comment", "pull_request_review_comment"].includes(env.GITHUB_EVENT_NAME) &&
      event.action === "created" &&
      event.repository?.full_name === settings.repository &&
      event.sender?.login === actor &&
      event.sender.type !== "Bot" &&
      event.comment?.user?.login === actor &&
      event.comment.user.type !== "Bot",
    "Invalid OpenCode event or sender",
  );
  const body = boundedText(event.comment.body, "OpenCode command");
  requireValue(
    /^\/(?:oc|opencode) +\S/.test(body),
    "Expected /oc or /opencode followed by a request",
  );
  const model = env.OPENCODE_MODEL || defaultModel;
  requireValue(model === defaultModel, "Only the supported free OpenCode model is allowed");
  const target = positiveInteger(event.issue?.number || event.pull_request?.number);
  const base = `/repos/${settings.repository}`;
  const get = (path) => github.request("GET", `${base}${path}`);
  const permission = await get(`/collaborators/${encodeURIComponent(actor)}/permission`);
  requireValue(
    ["write", "maintain", "admin"].includes(permission.permission),
    "Write permission required",
  );
  const comment = await get(
    `/${env.GITHUB_EVENT_NAME === "issue_comment" ? "issues" : "pulls"}/comments/${positiveInteger(event.comment.id, "comment")}`,
  );
  requireValue(comment.body === body && comment.user?.login === actor, "Trigger comment changed");
  const issue = await get(`/issues/${target}`);
  requireValue(issue.state === "open", "Target must be open");
  if (issue.pull_request || env.GITHUB_EVENT_NAME === "pull_request_review_comment") {
    const pull = await get(`/pulls/${target}`);
    requireValue(
      pull.head?.repo?.full_name === settings.repository &&
        pull.base?.repo?.full_name === settings.repository,
      "Fork pull requests are disabled",
    );
  }

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
    requireValue(daily < settings.dailyRuns, "Daily run budget exhausted");
    requireValue(perTarget < settings.targetRuns, "Target run budget exhausted");
    if (runs.length < 100) return { allowed: "true", model };
  }
  throw new Error("Workflow history exceeds safe pagination limit");
}

export async function main(env = process.env) {
  let output;
  try {
    const raw = await readFile(env.GITHUB_EVENT_PATH, "utf8");
    requireValue(Buffer.byteLength(raw) <= LIMITS.context, "Event exceeds safe size limit");
    output = await authorizeOpenCode({ github: createGitHub(), event: JSON.parse(raw), env });
  } catch (error) {
    output = { allowed: "false" };
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
