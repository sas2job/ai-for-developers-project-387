import {
  LIMITS,
  config,
  digest,
  boundedText,
  positiveInteger,
  sha,
  requireValue,
  parseCommand,
  readState,
  stateBody,
  planResult,
  artifactMarker,
  originMarker,
  origin,
  diffLines,
  patchPaths,
  trustedAuthor,
} from "./policy.mjs";

export function createController({
  github,
  env = process.env,
  clock = () => new Date(),
  git,
} = {}) {
  const settings = config(env);
  const base = `/repos/${settings.repository}`;
  const request = (method, path, body) => github.request(method, `${base}${path}`, body);
  async function pages(path, field) {
    const values = [];
    for (let page = 1; page <= LIMITS.pages; page += 1) {
      const result = await request(
        "GET",
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      const batch = field ? result[field] : result;
      requireValue(Array.isArray(batch), "Invalid GitHub collection");
      values.push(...batch);
      if (batch.length < 100) return values;
    }
    throw new Error("GitHub collection exceeds safe pagination limit");
  }
  const issue = (number) => request("GET", `/issues/${positiveInteger(number)}`);
  const comments = (number) => pages(`/issues/${number}/comments`);
  const state = async (number) => readState(await comments(number), settings, number);
  async function authority(actor = env.GITHUB_ACTOR) {
    requireValue(settings.enabled, "Agent automation is disabled");
    requireValue(
      typeof actor === "string" &&
        settings.allowedActors.includes(actor.toLowerCase()) &&
        !actor.endsWith("[bot]"),
      "Actor is not explicitly allowed",
    );
    const permission = await request(
      "GET",
      `/collaborators/${encodeURIComponent(actor)}/permission`,
    );
    requireValue(
      ["write", "maintain", "admin"].includes(permission.permission),
      "Actor needs collaborator write permission",
    );
    return actor;
  }
  async function repository() {
    const repo = await request("GET", "");
    requireValue(
      repo.full_name === settings.repository && /^[\w./-]+$/.test(repo.default_branch),
      "Repository mismatch",
    );
    const ref = await request("GET", `/git/ref/heads/${encodeURIComponent(repo.default_branch)}`);
    return { defaultBranch: repo.default_branch, baseSha: sha(ref.object.sha) };
  }
  async function approved(target) {
    const source = await issue(target);
    requireValue(source && !source.pull_request, "Implementation must reference a plan issue");
    const parent = origin(source.body);
    const root = parent ? parent.issue : target;
    const current = root === target ? source : await issue(root);
    const record = await state(root);
    requireValue(
      record.plan &&
        record.approval &&
        record.published &&
        record.approval.digest === record.planDigest &&
        settings.allowedActors.includes(record.approval.actor?.toLowerCase()),
      "A human-approved plan is required",
    );
    requireValue(
      digest(current.body || "") === record.sourceDigest &&
        digest({ plan: record.plan, sourceDigest: record.sourceDigest }) === record.planDigest,
      "Approved source or plan changed",
    );
    const artifacts = [record.artifacts?.spec, ...(record.artifacts?.tickets || [])];
    requireValue(
      artifacts.length === record.plan.tickets.length + 1 &&
        artifacts.every((number) => Number.isSafeInteger(number) && number > 0),
      "Issue is not an unchanged approved plan artifact",
    );
    if (parent)
      requireValue(
        parent.digest === record.planDigest && artifacts.includes(target),
        "Issue is not an unchanged approved plan artifact",
      );
    for (const number of artifacts) {
      const artifact = number === target ? source : await issue(number);
      requireValue(
        artifact &&
          !artifact.pull_request &&
          record.artifactDigests?.[number] === digest(artifact.body || ""),
        "Issue is not an unchanged approved plan artifact",
      );
    }
    return {
      rootIssue: root,
      digest: record.planDigest,
      actor: record.approval.actor,
      sourceDigest: record.sourceDigest,
    };
  }
  async function budgets(target, runId = env.GITHUB_RUN_ID) {
    const current = await state(target);
    requireValue(
      (current.runs || []).filter((run) => run.id !== runId).length < settings.targetRuns,
      "Target run budget exhausted",
    );
    const day = clock().toISOString().slice(0, 10);
    const runs = await pages(
      `/actions/workflows/${encodeURIComponent(settings.workflow)}/runs?created=${encodeURIComponent(`>=${day}`)}`,
      "workflow_runs",
    );
    const allowedAttempts = runs
      .filter(
        (run) =>
          String(run.id) !== String(runId) &&
          settings.allowedActors.includes(String(run.actor?.login || "").toLowerCase()),
      )
      .reduce((total, run) => total + positiveInteger(run.run_attempt || 1, "run attempt"), 0);
    requireValue(allowedAttempts < settings.dailyRuns, "Daily run budget exhausted");
    return current;
  }
  async function prepare(event) {
    const actor = await authority();
    requireValue(
      !env.GITHUB_RUN_ATTEMPT || env.GITHUB_RUN_ATTEMPT === "1",
      "Reruns are disabled; submit a new command",
    );
    requireValue(event.repository?.full_name === settings.repository, "Event repository mismatch");
    requireValue(
      !event.sender || (event.sender.login === actor && event.sender.type !== "Bot"),
      "Event sender mismatch or bot",
    );
    let command, target;
    const eventName = env.GITHUB_EVENT_NAME;
    if (eventName === "workflow_dispatch") {
      const inputs = event.inputs || {};
      target = positiveInteger(inputs.target);
      requireValue(
        ["plan", "approve", "implement", "review", "fix"].includes(inputs.action),
        "Invalid dispatch action",
      );
      command = { action: inputs.action, approvalDigest: inputs.approval_digest };
    } else if (eventName === "issue_comment" && event.action === "created") {
      requireValue(
        event.comment?.user?.login === actor && event.comment.user.type !== "Bot",
        "Comment actor mismatch",
      );
      command = parseCommand(event.comment.body, Boolean(event.issue?.pull_request));
      target = positiveInteger(event.issue?.number);
    } else if (eventName === "pull_request_review_comment" && event.action === "created") {
      requireValue(
        event.comment?.user?.login === actor && event.comment.user.type !== "Bot",
        "Review comment actor mismatch",
      );
      command = parseCommand(event.comment.body, true);
      target = positiveInteger(event.pull_request?.number);
    } else if (eventName === "pull_request_review" && event.action === "submitted") {
      requireValue(
        event.review?.user?.login === actor && event.review.user.type !== "Bot",
        "Review actor mismatch",
      );
      command = parseCommand(event.review.body, true);
      target = positiveInteger(event.pull_request?.number);
    } else if (eventName === "issues" && event.action === "labeled") {
      target = positiveInteger(event.issue?.number);
      command = {
        action: { "agent:plan": "plan", "agent:implement": "implement" }[event.label?.name],
      };
    } else if (
      eventName === "pull_request" &&
      ["opened", "synchronize", "reopened"].includes(event.action)
    ) {
      target = positiveInteger(event.pull_request?.number);
      command = { action: "review" };
    }
    requireValue(command?.action, "No supported exact agent command");
    if (command.action === "approve")
      requireValue(
        /^[a-f0-9]{64}$/.test(command.approvalDigest || ""),
        "Approval requires the full plan digest",
      );
    const source = await issue(target);
    const isPull = Boolean(source.pull_request);
    requireValue(
      (isPull ? ["review", "fix"] : ["plan", "approve", "implement"]).includes(command.action),
      "Action is not valid for this target",
    );
    requireValue(source.state === "open", "Target must be open");
    boundedText(source.title, "target title", 500);
    requireValue(Buffer.byteLength(source.body || "") <= LIMITS.body, "Target body is too large");
    const repo = await repository();
    let pull,
      branch = `agent/issue-${target}`,
      headSha = repo.baseSha,
      approval;
    if (isPull) {
      pull = await request("GET", `/pulls/${target}`);
      requireValue(
        pull.head?.repo?.full_name === settings.repository &&
          pull.base?.repo?.full_name === settings.repository &&
          pull.base.ref === repo.defaultBranch,
        "Forks and non-default base branches are not allowed",
      );
      branch = pull.head.ref;
      headSha = sha(pull.head.sha);
      if (command.action === "fix") {
        const match = /^agent\/issue-([1-9]\d{0,8})$/.exec(branch);
        requireValue(match, "Fixes require the existing controlled issue branch");
        approval = await approved(Number(match[1]));
      }
    } else if (command.action === "implement") {
      approval = await approved(target);
      try {
        headSha = sha((await request("GET", `/git/ref/heads/${branch}`)).object.sha);
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    await budgets(target);
    const discussion = (await comments(target)).map((comment) => ({
      id: comment.id,
      author: comment.user?.login,
      body: comment.body || "",
    }));
    const inline = isPull
      ? (await pages(`/pulls/${target}/comments`)).map((comment) => ({
          path: comment.path,
          line: comment.line,
          author: comment.user?.login,
          body: comment.body || "",
        }))
      : [];
    const reviews = isPull
      ? (await pages(`/pulls/${target}/reviews`)).map((review) => ({
          id: review.id,
          state: review.state,
          author: review.user?.login,
          body: review.body || "",
          commitId: review.commit_id,
        }))
      : [];
    const files = isPull
      ? (await pages(`/pulls/${target}/files`)).map(({ filename, status, patch }) => ({
          filename,
          status,
          patch,
        }))
      : [];
    const context = {
      version: 1,
      repository: settings.repository,
      actor,
      runId: String(env.GITHUB_RUN_ID || `local-${clock().getTime()}`),
      createdAt: clock().toISOString(),
      mode: settings.mode,
      ...command,
      target,
      kind: isPull ? "pull" : "issue",
      ...repo,
      headSha,
      branch,
      title: source.title,
      body: source.body || "",
      sourceDigest: digest(source.body || ""),
      discussion,
      inline,
      reviews,
      files,
      ...(approval ? { approval } : {}),
    };
    requireValue(
      Buffer.byteLength(JSON.stringify(context)) <= LIMITS.context,
      "Task context exceeds safe limit",
    );
    return context;
  }
  async function saveState(record, message) {
    const payload = { ...record };
    delete payload.commentId;
    const path = record.commentId
      ? `/issues/comments/${record.commentId}`
      : `/issues/${record.issue}/comments`;
    const response = await request(record.commentId ? "PATCH" : "POST", path, {
      body: stateBody(payload, message),
    });
    record.commentId = response.id;
    return record;
  }
  async function validateContext(context) {
    await authority();
    requireValue(
      context.version === 1 &&
        context.repository === settings.repository &&
        context.actor === env.GITHUB_ACTOR,
      "Context identity mismatch",
    );
    positiveInteger(context.target);
    requireValue(
      !env.AGENT_CONTEXT_SHA256 || digest(context) === env.AGENT_CONTEXT_SHA256,
      "Context digest mismatch",
    );
  }
  async function queue(context) {
    await validateContext(context);
    const record = await budgets(context.target, context.runId);
    if (!record.runs.some((run) => run.id === context.runId))
      record.runs.push({ id: context.runId, action: context.action, at: clock().toISOString() });
    const runLink = /^[1-9]\d*$/.test(context.runId)
      ? `[Task artifact and run](https://github.com/${settings.repository}/actions/runs/${context.runId}).`
      : "Task artifacts were prepared locally.";
    return saveState(
      record,
      `Agent task prepared: **${context.action}** for #${context.target}.\n\nMode: ${context.mode}. ${context.mode === "local" ? "No model has run. Download the task artifact, execute it locally, then publish the result using the trusted CLI." : "Task reserved for the isolated API runner."}\n\n${runLink} Base: \`${context.baseSha}\`; head: \`${context.headSha}\`.`,
    );
  }
  async function publishPlan(context, result) {
    await validateContext(context);
    requireValue(
      context.action === "plan" && context.kind === "issue",
      "Plan requires an issue planning context",
    );
    const source = await issue(context.target);
    requireValue(
      digest(source.body || "") === context.sourceDigest,
      "Source issue changed; prepare a new plan",
    );
    const plan = planResult(result);
    const planDigest = digest({ plan, sourceDigest: context.sourceDigest });
    const record = await state(context.target);
    const unchanged = record.planDigest === planDigest;
    const next = {
      version: 1,
      issue: context.target,
      runs: record.runs,
      commentId: record.commentId,
      plan,
      planDigest,
      sourceDigest: context.sourceDigest,
      ...(unchanged
        ? {
            approval: record.approval,
            artifacts: record.artifacts,
            artifactDigests: record.artifactDigests,
            published: record.published,
          }
        : {}),
    };
    const tickets = plan.tickets
      .map(
        (ticket, index) =>
          `### Ticket ${index + 1}: ${ticket.title}\n\n${ticket.body}\n\nBlocked by: ${ticket.blockedBy.map((blocker) => `ticket ${blocker + 1}`).join(", ") || "none"}`,
      )
      .join("\n\n");
    await saveState(
      next,
      `## Proposed plan\n\n### Specification: ${plan.spec.title}\n\n${plan.spec.body}\n\n${tickets}\n\nSource digest: \`${context.sourceDigest}\`\n\nPlan digest: \`${planDigest}\`\n\nAn allowed human with write permission can approve this exact plan with:\n\n\`/agent approve ${planDigest}\`\n\nFormal specification and ticket issues are created only after that approval.`,
    );
    return { digest: planDigest };
  }
  async function approve(context) {
    await validateContext(context);
    requireValue(
      context.action === "approve" && context.kind === "issue",
      "Approval requires an issue approval context",
    );
    const actor = await authority();
    const record = await state(context.target);
    requireValue(
      record.plan && context.approvalDigest === record.planDigest,
      "Approval digest does not match the proposed plan",
    );
    requireValue(
      digest((await issue(context.target)).body || "") === record.sourceDigest &&
        digest({ plan: record.plan, sourceDigest: record.sourceDigest }) === record.planDigest,
      "Source issue or proposed plan changed",
    );
    const plan = planResult(record.plan);
    record.artifacts ||= { tickets: [] };
    record.artifacts.tickets ||= [];
    record.artifactDigests ||= {};
    const known = await pages("/issues?state=all");
    async function artifact(key, document, parent, blockers = []) {
      const marker = artifactMarker(context.target, record.planDigest, key);
      const body = `${originMarker(context.target, record.planDigest)}\n${marker}\n\nPart of #${parent}\n${blockers.length ? `Blocked by: ${blockers.map((item) => `#${item.number}`).join(", ")}\n` : ""}\n${document.body}`;
      let created = known.find(
        (item) =>
          !item.pull_request &&
          trustedAuthor(item.user, settings) &&
          item.body === body &&
          item.title === document.title,
      );
      if (!created) {
        created = await request("POST", "/issues", {
          title: document.title,
          body,
          labels: ["ready-for-agent", key === "spec" ? "agent:spec" : "agent:ticket"],
        });
        known.push(created);
      }
      positiveInteger(created.number);
      requireValue(Number.isSafeInteger(created.id), "Issue database ID is required");
      record.artifactDigests[created.number] = digest(created.body || body);
      return created;
    }
    async function link(path, body) {
      try {
        await request("POST", path, body);
      } catch (error) {
        if (![404, 409, 422].includes(error.status)) throw error;
      }
    }
    const spec = await artifact("spec", plan.spec, context.target);
    record.artifacts.spec = spec.number;
    await saveState(
      record,
      `Publishing the approved plan \`${record.planDigest}\`; specification #${spec.number}.`,
    );
    await link(`/issues/${context.target}/sub_issues`, { sub_issue_id: spec.id });
    const tickets = [];
    for (let index = 0; index < plan.tickets.length; index += 1) {
      const ticket = plan.tickets[index];
      const blockers = ticket.blockedBy.map((blocker) => tickets[blocker]);
      const created = await artifact(`ticket-${index}`, ticket, spec.number, blockers);
      tickets.push(created);
      record.artifacts.tickets[index] = created.number;
      await saveState(
        record,
        `Publishing approved plan \`${record.planDigest}\`; specification #${spec.number}, tickets ${record.artifacts.tickets.map((number) => `#${number}`).join(", ")}.`,
      );
      await link(`/issues/${spec.number}/sub_issues`, { sub_issue_id: created.id });
      for (const blocker of blockers)
        await link(`/issues/${created.number}/dependencies/blocked_by`, { issue_id: blocker.id });
    }
    requireValue(
      digest((await issue(context.target)).body || "") === record.sourceDigest,
      "Source issue changed during publication",
    );
    record.approval = { digest: record.planDigest, actor, at: clock().toISOString() };
    record.published = true;
    await saveState(
      record,
      `Plan \`${record.planDigest}\` approved by @${actor}.\n\nSpecification: #${spec.number}\n\n${tickets.map((ticket) => `- #${ticket.number}: ${ticket.title}`).join("\n")}\n\nImplementation is ready for an explicit \`/agent implement\` request on the source issue, specification or ticket.`,
    );
    return {
      spec: spec.number,
      tickets: tickets.map((ticket) => ticket.number),
      digest: record.planDigest,
    };
  }
  async function currentPull(context) {
    const pull = await request("GET", `/pulls/${context.target}`);
    requireValue(
      pull.state === "open" &&
        pull.head?.repo?.full_name === settings.repository &&
        pull.base?.repo?.full_name === settings.repository,
      "Pull request is closed or from a fork",
    );
    const repo = await repository();
    requireValue(
      pull.head.sha === context.headSha &&
        pull.head.ref === context.branch &&
        pull.base.ref === repo.defaultBranch &&
        repo.baseSha === context.baseSha,
      "Stale pull request head or base",
    );
    return pull;
  }
  async function publishReview(context, result) {
    await validateContext(context);
    requireValue(
      context.action === "review" && context.kind === "pull",
      "Review requires a pull request review context",
    );
    await currentPull(context);
    boundedText(result.summary, "review summary", 20_000);
    requireValue(
      Array.isArray(result.findings) && result.findings.length <= LIMITS.findings,
      "At most ten review findings are allowed",
    );
    const valid = diffLines(await pages(`/pulls/${context.target}/files`));
    const findings = result.findings.map((finding) => {
      requireValue(
        typeof finding.path === "string" &&
          Number.isInteger(finding.line) &&
          valid.get(finding.path)?.has(finding.line),
        "Review finding must refer to a current diff line",
      );
      return {
        path: finding.path,
        line: finding.line,
        side: "RIGHT",
        body: boundedText(finding.body, "finding body", 5000),
      };
    });
    return request("POST", `/pulls/${context.target}/reviews`, {
      commit_id: context.headSha,
      event: "COMMENT",
      body: result.summary,
      comments: findings,
    });
  }
  async function publishChange(context, result, patch) {
    await validateContext(context);
    requireValue(
      ["implement", "fix"].includes(context.action),
      "Change requires implementation or fix context",
    );
    const paths = patchPaths(patch);
    const match = /^agent\/issue-([1-9]\d{0,8})$/.exec(context.branch);
    requireValue(match, "Changes require a controlled issue branch");
    const issueNumber = Number(match[1]);
    const approval = await approved(issueNumber);
    requireValue(
      context.approval?.digest === approval.digest &&
        context.approval?.rootIssue === approval.rootIssue,
      "Approval context changed",
    );
    if (context.action === "implement")
      requireValue(
        context.target === issueNumber &&
          digest((await issue(issueNumber)).body || "") === context.sourceDigest,
        "Implementation issue changed",
      );
    boundedText(result.summary, "change summary", 10_000);
    boundedText(result.risk, "change risk", 5000);
    boundedText(result.tests, "test report", 10_000);
    const repo = await repository();
    requireValue(
      repo.baseSha === context.baseSha && repo.defaultBranch === context.defaultBranch,
      "Stale default branch",
    );
    let exists = true;
    try {
      requireValue(
        sha((await request("GET", `/git/ref/heads/${context.branch}`)).object.sha) ===
          context.headSha,
        "Stale branch head",
      );
    } catch (error) {
      if (error.status !== 404) throw error;
      exists = false;
      requireValue(
        context.headSha === context.baseSha && context.action === "implement",
        "Controlled branch disappeared",
      );
    }
    if (context.action === "fix") await currentPull(context);
    const open = await pages(
      `/pulls?state=open&head=${encodeURIComponent(`${settings.repository.split("/")[0]}:${context.branch}`)}`,
    );
    const matching = open.filter(
      (item) =>
        item.head?.ref === context.branch && item.head?.repo?.full_name === settings.repository,
    );
    requireValue(
      matching.every(
        (item) =>
          item.base?.ref === repo.defaultBranch &&
          item.base?.repo?.full_name === settings.repository,
      ),
      "Forks and non-default base branches are not allowed",
    );
    let pull = matching[0];
    requireValue(git?.publish, "A trusted git publisher is required");
    const change = await git.publish({
      repository: settings.repository,
      branch: context.branch,
      headSha: context.headSha,
      baseSha: context.baseSha,
      patch,
      paths,
      issue: issueNumber,
      exists,
    });
    sha(change.headSha);
    const body = `${originMarker(approval.rootIssue, approval.digest)}\n\nCloses #${issueNumber}\n\n${result.summary}\n\n### Risk\n\n${result.risk}\n\n### Validation reported by the task runner\n\n${result.tests}\n\nThe privileged publisher applied the text patch without running application code. CI must validate this head.`;
    if (!pull)
      pull = await request("POST", "/pulls", {
        title: `Implement #${issueNumber}: ${(await issue(issueNumber)).title}`.slice(0, 200),
        head: context.branch,
        base: repo.defaultBranch,
        body,
        draft: true,
      });
    else
      await request("POST", `/issues/${pull.number}/comments`, {
        body: `Updated the existing branch.\n\n${body}`,
      });
    return {
      pr: positiveInteger(pull.number),
      branch: context.branch,
      headSha: change.headSha,
      url: pull.html_url,
    };
  }
  return { prepare, queue, publishPlan, approve, publishReview, publishChange };
}
