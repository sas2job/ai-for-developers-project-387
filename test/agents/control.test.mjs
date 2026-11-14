import assert from "node:assert/strict";
import test from "node:test";
import { createController } from "../../script/agents/control.mjs";

const sha = "a".repeat(40);
function fixture(overrides = {}) {
  const writes = [];
  const comments = [];
  const issue = {
    number: 3,
    title: "Calendar",
    body: "Add bookings",
    state: "open",
    html_url: "https://github.com/owner/calendar/issues/3",
  };
  const issues = [issue];
  const refs = new Map([["main", sha]]);
  const pulls = [];
  const files = [{ filename: "app/booking.rb", patch: "@@ -1,1 +1,2 @@\n old\n+new" }];
  const event = {
    action: "created",
    repository: { full_name: "owner/calendar" },
    sender: { login: "owner", type: "User" },
    issue,
    comment: { body: "/agent plan", user: { login: "owner", type: "User" } },
  };
  const github = {
    async request(method, path, body) {
      if (method !== "GET") {
        writes.push({ method, path, body });
        if (path.endsWith("/issues/3/comments")) {
          const comment = {
            id: comments.length + 1,
            body: body.body,
            user: { login: "github-actions[bot]", type: "Bot" },
          };
          comments.push(comment);
          return comment;
        }
        if (/\/issues\/comments\//.test(path)) {
          const item = comments.find((comment) => comment.id === Number(path.split("/").at(-1)));
          item.body = body.body;
          return item;
        }
        if (path === "/repos/owner/calendar/issues") {
          const item = {
            ...body,
            number: issues.length + 10,
            id: issues.length + 100,
            state: "open",
            user: { login: "github-actions[bot]", type: "Bot" },
          };
          issues.push(item);
          return item;
        }
        if (path === "/repos/owner/calendar/pulls") {
          const item = {
            ...body,
            number: 30,
            html_url: "https://github.com/owner/calendar/pull/30",
            head: { ref: body.head, repo: { full_name: "owner/calendar" } },
          };
          pulls.push(item);
          return item;
        }
        return { id: 1 };
      }
      if (path === "/repos/owner/calendar")
        return { full_name: "owner/calendar", default_branch: "main", owner: { login: "owner" } };
      if (path.includes("/collaborators/")) return { permission: "admin" };
      if (path.includes("/actions/workflows/")) return { workflow_runs: [] };
      if (/\/issues\/\d+$/.test(path))
        return issues.find((item) => item.number === Number(path.split("/").at(-1)));
      if (path.includes("/comments?")) return comments;
      if (path.includes("/git/ref/heads/")) {
        const ref = refs.get(decodeURIComponent(path.split("/git/ref/heads/")[1]));
        if (!ref) throw Object.assign(new Error("Not found"), { status: 404 });
        return { object: { sha: ref } };
      }
      if (path.startsWith("/repos/owner/calendar/issues?")) return issues;
      if (path.startsWith("/repos/owner/calendar/pulls?")) return pulls;
      if (/\/pulls\/\d+\/files\?/.test(path)) return files;
      if (/\/pulls\/\d+\/reviews\?/.test(path)) return [];
      if (/\/pulls\/\d+$/.test(path))
        return pulls.find((item) => item.number === Number(path.split("/").at(-1)));
      throw new Error(`Unexpected request ${method} ${path}`);
    },
  };
  const env = {
    GITHUB_REPOSITORY: "owner/calendar",
    GITHUB_ACTOR: "owner",
    GITHUB_EVENT_NAME: "issue_comment",
    GITHUB_RUN_ID: "17",
    ...overrides,
  };
  return {
    controller: createController({ github, env, clock: () => new Date("2026-11-13T10:00:00Z") }),
    event,
    writes,
    github,
    issue,
    comments,
    issues,
    refs,
    pulls,
    files,
    env,
  };
}

test("prepare accepts an authorized exact issue command without publishing anything", async () => {
  const { controller, event, writes } = fixture();
  const context = await controller.prepare(event);
  assert.equal(context.action, "plan");
  assert.equal(context.target, 3);
  assert.equal(context.mode, "local");
  assert.equal(context.baseSha, sha);
  assert.equal(context.branch, "agent/issue-3");
  assert.deepEqual(writes, []);
});

test("publishing a plan proposes the entire plan without creating formal issues", async () => {
  const { controller, event, writes } = fixture();
  const context = await controller.prepare(event);
  const result = await controller.publishPlan(context, {
    spec: { title: "Booking", body: "Guest books a call" },
    tickets: [{ title: "Build booking", body: "Protect overlapping intervals", blockedBy: [] }],
  });
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.equal(writes.length, 1);
  assert.match(writes[0].path, /\/issues\/3\/comments$/);
  assert.match(writes[0].body.body, /Guest books a call/);
  assert.match(writes[0].body.body, /Protect overlapping intervals/);
  assert.match(writes[0].body.body, new RegExp(`/agent approve ${result.digest}`));
});

test("untrusted users, quoted commands, forks and disabled automation cannot prepare tasks", async () => {
  const outsider = fixture({ GITHUB_ACTOR: "outsider" });
  await assert.rejects(outsider.controller.prepare(outsider.event), /explicitly allowed/);
  const disabled = fixture({ AGENT_ENABLED: "false" });
  await assert.rejects(disabled.controller.prepare(disabled.event), /disabled/);
  for (const body of [
    "Please /agent plan",
    "/agent plan\necho unsafe",
    "```\n/agent plan\n```",
    "/agent approve abc",
  ]) {
    const { controller, event } = fixture();
    event.comment.body = body;
    await assert.rejects(controller.prepare(event), /supported exact/);
  }
  const { controller, event } = fixture();
  event.repository.full_name = "attacker/fork";
  await assert.rejects(controller.prepare(event), /repository mismatch/);
});

test("approval rejects a changed source and an untrusted forged state", async () => {
  const { controller, event, issue, comments } = fixture();
  const context = await controller.prepare(event);
  const plan = await controller.publishPlan(context, {
    spec: { title: "Booking", body: "Guest books" },
    tickets: [{ title: "Build", body: "Build it", blockedBy: [] }],
  });
  event.comment.body = `/agent approve ${plan.digest}`;
  const approval = await controller.prepare(event);
  issue.body = "Changed requirements";
  await assert.rejects(controller.approve(approval), /changed/);
  issue.body = "Add bookings";
  comments[0].user = { login: "outsider", type: "User" };
  await assert.rejects(controller.approve(approval), /digest does not match/);
});

test("context hash validation prevents publishing a modified downloaded task", async () => {
  const { controller, event } = fixture({ AGENT_CONTEXT_SHA256: "0".repeat(64) });
  const context = await controller.prepare(event);
  await assert.rejects(controller.publishPlan(context, {}), /Context digest mismatch/);
});

test("publishing a change rejects workflow patches before invoking git", async () => {
  const { controller, event } = fixture();
  const context = { ...(await controller.prepare(event)), action: "implement" };
  await assert.rejects(
    controller.publishChange(
      context,
      { summary: "Change", risk: "Low", tests: "Reviewed" },
      "diff --git a/.github/workflows/agents.yml b/.github/workflows/agents.yml\n--- a/.github/workflows/agents.yml\n+++ b/.github/workflows/agents.yml\n@@ -1 +1 @@\n-old\n+new\n",
    ),
    /patch path/,
  );
});

test("approval creates linked issues once, and only unchanged approved artifacts can be implemented", async () => {
  const { controller, event, writes, issues } = fixture();
  const planning = await controller.prepare(event);
  const plan = await controller.publishPlan(planning, {
    spec: { title: "Booking spec", body: "Guest books a call" },
    tickets: [
      { title: "Protect intervals", body: "Use the database constraint", blockedBy: [] },
      { title: "Booking form", body: "Submit the booking", blockedBy: [0] },
    ],
  });
  event.comment.body = `/agent approve ${plan.digest}`;
  const approval = await controller.prepare(event);
  const result = await controller.approve(approval);
  assert.deepEqual(result.tickets, [12, 13]);
  assert.equal(result.spec, 11);
  await controller.approve(approval);
  assert.equal(writes.filter((item) => item.path === "/repos/owner/calendar/issues").length, 3);
  assert.ok(
    writes.some(
      (item) =>
        item.path === "/repos/owner/calendar/issues/13/dependencies/blocked_by" &&
        item.body.issue_id === 102,
    ),
  );
  event.issue = issues.find((item) => item.number === 12);
  event.comment.body = "/agent implement";
  const implementation = await controller.prepare(event);
  assert.equal(implementation.approval.rootIssue, 3);
  assert.equal(implementation.branch, "agent/issue-12");
  event.issue.body += "\nChanged after approval";
  await assert.rejects(controller.prepare(event), /unchanged approved plan artifact/);
});

test("review posts comments on current diff lines and refuses stale or off-diff findings", async () => {
  const f = fixture();
  f.issue.pull_request = { url: "pull" };
  f.pulls.push({
    number: 3,
    state: "open",
    head: { sha: "b".repeat(40), ref: "agent/issue-12", repo: { full_name: "owner/calendar" } },
    base: { ref: "main", repo: { full_name: "owner/calendar" } },
  });
  f.event.comment.body = "/agent review";
  const context = await f.controller.prepare(f.event);
  const result = {
    summary: "Check interval validation",
    findings: [{ path: "app/booking.rb", line: 2, body: "This allows an overlapping booking." }],
  };
  await f.controller.publishReview(context, result);
  const review = f.writes.at(-1);
  assert.equal(review.body.event, "COMMENT");
  assert.equal(review.body.commit_id, "b".repeat(40));
  assert.equal(review.body.comments[0].side, "RIGHT");
  result.findings[0].line = 500;
  await assert.rejects(f.controller.publishReview(context, result), /current diff line/);
  f.pulls[0].head.sha = "c".repeat(40);
  await assert.rejects(f.controller.publishReview(context, result), /Stale/);
});

test("the local queue reserves a bounded run and explicitly says that no model has run", async () => {
  const f = fixture({ AGENT_MAX_TARGET_RUNS: "1" });
  const context = await f.controller.prepare(f.event);
  await f.controller.queue(context);
  assert.match(f.writes.at(-1).body.body, /No model has run/);
  await f.controller.queue(context);
  context.runId = "18";
  await assert.rejects(f.controller.queue(context), /Target run budget exhausted/);
});

test("fixes update the existing approved branch and reuse its pull request", async () => {
  const f = fixture();
  const planning = await f.controller.prepare(f.event);
  const plan = await f.controller.publishPlan(planning, {
    spec: { title: "Spec", body: "Booking" },
    tickets: [{ title: "Task", body: "Booking code", blockedBy: [] }],
  });
  f.event.comment.body = `/agent approve ${plan.digest}`;
  await f.controller.approve(await f.controller.prepare(f.event));
  f.refs.set("agent/issue-3", "b".repeat(40));
  const pr = { ...f.issue, number: 30, pull_request: { url: "pull" } };
  f.issues.push(pr);
  f.event.issue = pr;
  f.pulls.push({
    number: 30,
    state: "open",
    head: { sha: "b".repeat(40), ref: "agent/issue-3", repo: { full_name: "owner/calendar" } },
    base: { ref: "main", repo: { full_name: "owner/calendar" } },
  });
  f.event.comment.body = "/agent fix";
  const context = await f.controller.prepare(f.event);
  const published = [];
  const controller = createController({
    github: f.github,
    env: f.env,
    git: {
      async publish(task) {
        published.push(task);
        return { headSha: "c".repeat(40) };
      },
    },
  });
  const result = await controller.publishChange(
    context,
    { summary: "Prevent overlap", risk: "Small", tests: "Booking test passes" },
    "diff --git a/app/booking.rb b/app/booking.rb\n--- a/app/booking.rb\n+++ b/app/booking.rb\n@@ -1 +1 @@\n-old\n+new\n",
  );
  assert.equal(result.pr, 30);
  assert.equal(result.branch, "agent/issue-3");
  assert.equal(published[0].headSha, "b".repeat(40));
  assert.equal(published[0].issue, 3);
  assert.equal(f.writes.filter((item) => item.path === "/repos/owner/calendar/pulls").length, 0);
  assert.match(f.writes.at(-1).body.body, /Updated the existing branch/);
});

test("approval recovers an issue created before a state-write failure, with text link fallback", async () => {
  const f = fixture();
  const plan = await f.controller.publishPlan(await f.controller.prepare(f.event), {
    spec: { title: "Spec", body: "Guest booking" },
    tickets: [
      { title: "Task one", body: "First", blockedBy: [] },
      { title: "Task two", body: "Second", blockedBy: [0] },
    ],
  });
  f.event.comment.body = `/agent approve ${plan.digest}`;
  const context = await f.controller.prepare(f.event);
  const request = f.github.request;
  let failOnce = true;
  f.github.request = async (method, path, body) => {
    if (method === "PATCH" && failOnce) {
      failOnce = false;
      throw new Error("Temporary state-write failure");
    }
    if (method === "POST" && /\/(sub_issues|blocked_by)$/.test(path))
      throw Object.assign(new Error("Unsupported"), { status: 422 });
    return request(method, path, body);
  };
  await assert.rejects(f.controller.approve(context), /Temporary/);
  const result = await f.controller.approve(context);
  assert.equal(f.issues.length, 4);
  assert.equal(result.spec, 11);
  assert.match(f.issues.find((item) => item.number === 13).body, /Part of #11\nBlocked by: #12/);
});

test("daily run and collaborator permissions are enforced before a task can be queued", async () => {
  const f = fixture({ AGENT_MAX_DAILY_RUNS: "2" });
  const request = f.github.request;
  f.github.request = async (method, path, body) =>
    path.includes("/actions/workflows/")
      ? {
          workflow_runs: [
            { id: 1, actor: { login: "owner" } },
            { id: 2, actor: { login: "owner" } },
          ],
        }
      : request(method, path, body);
  await assert.rejects(f.controller.prepare(f.event), /Daily run budget exhausted/);
  f.github.request = async (method, path, body) =>
    path.includes("/collaborators/") ? { permission: "read" } : request(method, path, body);
  await assert.rejects(f.controller.prepare(f.event), /collaborator write permission/);
  assert.equal(f.writes.length, 0);
});

test("unauthorized event spam cannot consume the allowed actor daily budget", async () => {
  const f = fixture({ AGENT_MAX_DAILY_RUNS: "1" });
  const request = f.github.request;
  f.github.request = async (method, path, body) =>
    path.includes("/actions/workflows/")
      ? {
          workflow_runs: [
            { id: 1, actor: { login: "outsider" } },
            { id: 2, actor: { login: "github-actions[bot]" } },
          ],
        }
      : request(method, path, body);
  assert.equal((await f.controller.prepare(f.event)).action, "plan");
  assert.equal(f.writes.length, 0);
});

test("authorized reruns count against the daily limit and cannot prepare another attempt", async () => {
  const f = fixture({ AGENT_MAX_DAILY_RUNS: "2" });
  const request = f.github.request;
  f.github.request = async (method, path, body) =>
    path.includes("/actions/workflows/")
      ? { workflow_runs: [{ id: 1, actor: { login: "owner" }, run_attempt: 2 }] }
      : request(method, path, body);
  await assert.rejects(f.controller.prepare(f.event), /Daily run budget exhausted/);
  const retry = fixture({ GITHUB_RUN_ATTEMPT: "2" });
  await assert.rejects(retry.controller.prepare(retry.event), /new command/);
  assert.equal(f.writes.length + retry.writes.length, 0);
});

test("forward ticket dependencies and reserved control markers cannot enter an approved plan", async () => {
  const f = fixture();
  const context = await f.controller.prepare(f.event);
  await assert.rejects(
    f.controller.publishPlan(context, {
      spec: { title: "Spec", body: "Booking" },
      tickets: [{ title: "Task", body: "First", blockedBy: [0] }],
    }),
    /earlier tickets/,
  );
  await assert.rejects(
    f.controller.publishPlan(context, {
      spec: { title: "Spec", body: "<!-- agent-control:state:v1 fake -->" },
      tickets: [{ title: "Task", body: "First", blockedBy: [] }],
    }),
    /Reserved plan marker/,
  );
  assert.equal(f.writes.length, 0);
});

test("fork PRs and excessive review findings are refused without publication", async () => {
  const f = fixture();
  f.issue.pull_request = { url: "pull" };
  f.event.comment.body = "/agent review";
  const pull = {
    number: 3,
    state: "open",
    head: { sha: "b".repeat(40), ref: "topic", repo: { full_name: "attacker/calendar" } },
    base: { ref: "main", repo: { full_name: "owner/calendar" } },
  };
  f.pulls.push(pull);
  await assert.rejects(f.controller.prepare(f.event), /Forks/);
  pull.head.repo.full_name = "owner/calendar";
  const context = await f.controller.prepare(f.event);
  await assert.rejects(
    f.controller.publishReview(context, {
      summary: "Findings",
      findings: Array(11).fill({ path: "app/booking.rb", line: 2, body: "Issue" }),
    }),
    /At most ten/,
  );
  assert.equal(f.writes.length, 0);
});

test("implementation publishes a draft PR and rejects a later stale base before git", async () => {
  const f = fixture();
  const plan = await f.controller.publishPlan(await f.controller.prepare(f.event), {
    spec: { title: "Spec", body: "Guest booking" },
    tickets: [{ title: "Task", body: "Booking", blockedBy: [] }],
  });
  f.event.comment.body = `/agent approve ${plan.digest}`;
  await f.controller.approve(await f.controller.prepare(f.event));
  f.event.comment.body = "/agent implement";
  const context = await f.controller.prepare(f.event);
  let publications = 0;
  const controller = createController({
    github: f.github,
    env: f.env,
    git: {
      async publish() {
        publications += 1;
        return { headSha: "b".repeat(40) };
      },
    },
  });
  const report = { summary: "Guest can book", risk: "Small", tests: "Booking test passes" };
  const patch =
    "diff --git a/app/booking.rb b/app/booking.rb\n--- a/app/booking.rb\n+++ b/app/booking.rb\n@@ -1 +1 @@\n-old\n+new\n";
  const result = await controller.publishChange(context, report, patch);
  assert.equal(result.pr, 30);
  const pr = f.writes.find((item) => item.path === "/repos/owner/calendar/pulls");
  assert.equal(pr.body.draft, true);
  assert.equal(pr.body.base, "main");
  assert.match(pr.body.body, /Closes #3/);
  f.refs.set("main", "c".repeat(40));
  await assert.rejects(controller.publishChange(context, report, patch), /Stale default branch/);
  assert.equal(publications, 1);
});

test("all control paths, binary patches, executable modes and renames are refused", async () => {
  const f = fixture();
  const context = { ...(await f.controller.prepare(f.event)), action: "implement" };
  const report = { summary: "Change", risk: "Small", tests: "Checked" };
  for (const path of [
    "AGENTS.md",
    "app/AGENTS.md",
    "docs/agents/policy.md",
    "bin/check",
    "script/agents/cli.mjs",
    ".env",
    "app/.secret",
    "../outside",
  ]) {
    await assert.rejects(
      f.controller.publishChange(
        context,
        report,
        `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`,
      ),
      /patch path/,
    );
  }
  for (const metadata of [
    "new file mode 100755",
    "new file mode 120000",
    "GIT binary patch",
    "rename from app/old.rb",
  ]) {
    await assert.rejects(
      f.controller.publishChange(
        context,
        report,
        `diff --git a/app/new.rb b/app/new.rb\n${metadata}\n`,
      ),
      /Unsafe patch metadata/,
    );
  }
  await assert.rejects(
    f.controller.publishChange(context, report, "diff --git a/app/old.rb b/app/new.rb\n"),
    /Renamed/,
  );
});
