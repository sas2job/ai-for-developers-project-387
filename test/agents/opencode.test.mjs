import assert from "node:assert/strict";
import test from "node:test";
import { authorizeOpenCode } from "../../script/agents/opencode.mjs";

function fixture(overrides = {}) {
  const env = {
    GITHUB_REPOSITORY: "owner/calendar",
    GITHUB_ACTOR: "owner",
    GITHUB_EVENT_NAME: "issue_comment",
    GITHUB_RUN_ID: "30",
    ...overrides,
  };
  const event = {
    action: "created",
    repository: { full_name: env.GITHUB_REPOSITORY },
    sender: { login: "owner", type: "User" },
    issue: { number: 3 },
    comment: { id: 7, body: "/oc explain this issue", user: { login: "owner", type: "User" } },
  };
  const data = {
    permission: "admin",
    comment: structuredClone(event.comment),
    issue: { number: 3, state: "open" },
    pull: {
      head: { repo: { full_name: env.GITHUB_REPOSITORY } },
      base: { repo: { full_name: env.GITHUB_REPOSITORY } },
    },
    runs: [],
    jobs: [],
    artifacts: [{ name: "opencode-request" }],
  };
  const requests = [];
  const github = {
    async request(method, path) {
      requests.push({ method, path });
      assert.equal(method, "GET");
      if (path.includes("/collaborators/")) return { permission: data.permission };
      if (path.endsWith(`/comments/${data.comment.id}`)) return data.comment;
      if (path.endsWith("/issues/3")) return data.issue;
      if (path.endsWith("/pulls/3")) return data.pull;
      if (path.includes("/actions/workflows/")) return { workflow_runs: data.runs };
      if (path.includes("/jobs?")) return { jobs: data.jobs };
      if (path.includes("/artifacts?")) return { artifacts: data.artifacts };
      throw new Error(`Unexpected request: ${path}`);
    },
  };
  return {
    env,
    event,
    data,
    requests,
    run: () =>
      authorizeOpenCode({ github, env, event, clock: () => new Date("2026-11-15T12:00:00Z") }),
  };
}

function triageFixture(overrides = {}) {
  const f = fixture({ GITHUB_EVENT_NAME: "issues", ...overrides });
  f.event.action = "opened";
  delete f.event.comment;
  f.event.issue = { number: 3, user: f.event.sender, labels: [] };
  f.data.issue = { ...structuredClone(f.event.issue), state: "open" };
  return f;
}

test("opening an incoming issue authorizes triage with the existing model and run budget", async () => {
  const f = triageFixture({ OPENCODE_MODEL: "opencode/deepseek-v4.1-flash-free" });
  assert.deepEqual(await f.run(), { allowed: "true", model: f.env.OPENCODE_MODEL });
  assert.ok(f.requests.some(({ path }) => path.endsWith("/issues/3")));
  assert.ok(f.requests.some(({ path }) => path.includes("/actions/workflows/opencode.yml/runs")));
  assert.ok(f.requests.every(({ path }) => !path.includes("/comments/")));
});

test("prepared issues skip triage even if the labels were added after opening", async () => {
  for (const name of ["ready-for-agent", "agent:spec", "agent:ticket"]) {
    const prepared = triageFixture();
    prepared.event.issue.labels = [{ name }];
    await assert.rejects(prepared.run(), /ineligible for triage/);
    assert.deepEqual(prepared.requests, []);

    const relabeled = triageFixture();
    relabeled.data.issue.labels = [{ name }];
    await assert.rejects(relabeled.run(), /ineligible for triage/);
    assert.ok(relabeled.requests.every(({ path }) => !path.includes("/actions/")));
  }
});

test("triage rejects reopened issues, bots, and authors without write access", async () => {
  const reopened = triageFixture();
  reopened.event.action = "reopened";
  await assert.rejects(reopened.run(), /Invalid OpenCode event/);
  assert.deepEqual(reopened.requests, []);

  const bot = triageFixture();
  bot.event.sender.type = "Bot";
  await assert.rejects(bot.run(), /Invalid OpenCode event/);
  assert.deepEqual(bot.requests, []);

  const reader = triageFixture();
  reader.data.permission = "read";
  await assert.rejects(reader.run(), /Write permission required/);
  assert.ok(reader.requests.every(({ path }) => path.includes("/collaborators/")));
});

test("an allowed human can invoke the free model without any write API calls", async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { allowed: "true", model: "opencode/glm-5.3-flash-free" });
  assert.ok(f.requests.some(({ path }) => path.includes("created=%3E%3D2026-11-15")));
});

test("real GitHub comment IDs above one billion remain valid", async () => {
  const f = fixture();
  f.event.comment.id = f.data.comment.id = 6_898_116_528;
  assert.equal((await f.run()).allowed, "true");
  assert.ok(f.requests.some(({ path }) => path.endsWith("/comments/6898116528")));
});

test("budget scans accept actual GitHub workflow run IDs above ten billion", async () => {
  const f = fixture();
  f.data.runs = [
    { id: 43_739_168_821, actor: { login: "owner" }, display_title: "OpenCode #9 by owner" },
  ];
  assert.equal((await f.run()).allowed, "true");
  assert.ok(f.requests.some(({ path }) => path.includes("/runs/43739168821/artifacts")));
});

test("invalid or unsafe GitHub comment IDs are rejected before looking up a comment", async () => {
  for (const id of [0, -1, 1.5, "01", "1e10", Number.MAX_SAFE_INTEGER + 1, "9007199254740993"]) {
    const f = fixture();
    f.event.comment.id = id;
    await assert.rejects(f.run(), /Invalid comment/);
    assert.ok(!f.requests.some(({ path }) => path.includes("/comments/")));
  }
});

test("the backup model is selectable, and paid or injected model names are refused", async () => {
  const f = fixture({ OPENCODE_MODEL: "opencode/deepseek-v4.1-flash-free" });
  assert.equal((await f.run()).model, f.env.OPENCODE_MODEL);
  for (const model of ["opencode/glm-5.3-flash", "opencode/big-pickle\nallowed=true"]) {
    const invalid = fixture({ OPENCODE_MODEL: model });
    await assert.rejects(invalid.run(), /free models/);
    assert.deepEqual(invalid.requests, []);
  }
});

test("outsiders, bots, reruns, disabled automation and untrusted senders are refused", async () => {
  for (const [env, mutate] of [
    [{ GITHUB_ACTOR: "outsider" }, () => {}],
    [{ GITHUB_RUN_ATTEMPT: "2" }, () => {}],
    [{ AGENT_ENABLED: "false" }, () => {}],
    [
      {},
      (event) => {
        event.sender.type = "Bot";
      },
    ],
    [
      {},
      (event) => {
        event.comment.user.login = "outsider";
      },
    ],
    [
      {},
      (event) => {
        event.repository.full_name = "outsider/fork";
      },
    ],
    [
      {},
      (event) => {
        event.action = "edited";
      },
    ],
  ]) {
    const f = fixture(env);
    mutate(f.event);
    await assert.rejects(f.run());
    assert.deepEqual(f.requests, []);
  }
});

test("only a new leading slash command with a nonempty request is accepted", async () => {
  for (const body of [
    "/oc",
    "/oc ",
    "Please /oc implement",
    "> /oc implement",
    "/ocx implement",
    "/agent plan",
  ]) {
    const f = fixture();
    f.event.comment.body = body;
    await assert.rejects(f.run());
    assert.deepEqual(f.requests, []);
  }
  const f = fixture();
  f.event.comment.body = f.data.comment.body = "/opencode review this\nMore context";
  assert.equal((await f.run()).allowed, "true");
});

test("allowlisted actors still need repository write permission", async () => {
  const f = fixture();
  f.data.permission = "read";
  await assert.rejects(f.run(), /Write permission/);
});

test("edited trigger comments and closed targets cannot run a model", async () => {
  const edited = fixture();
  edited.data.comment.body = "/oc a different request";
  await assert.rejects(edited.run(), /comment changed/);
  const closed = fixture();
  closed.data.issue.state = "closed";
  await assert.rejects(closed.run(), /must be open/);
});

test("fork PRs are refused for both discussion and inline comments", async () => {
  for (const eventName of ["issue_comment", "pull_request_review_comment"]) {
    const f = fixture({ GITHUB_EVENT_NAME: eventName });
    f.data.issue.pull_request = {};
    f.data.pull.head.repo.full_name = "outsider/calendar";
    f.event.pull_request = { number: 3 };
    await assert.rejects(f.run(), /Fork/);
  }
});

test("same-repository PR discussion and inline comments are accepted", async () => {
  for (const eventName of ["issue_comment", "pull_request_review_comment"]) {
    const f = fixture({ GITHUB_EVENT_NAME: eventName });
    f.data.issue.pull_request = {};
    f.event.pull_request = { number: 3 };
    assert.equal((await f.run()).allowed, "true");
  }
});

test("daily and per-target limits count reserved model attempts", async () => {
  for (const [setting, title] of [
    ["AGENT_MAX_DAILY_RUNS", "OpenCode #9 by owner"],
    ["AGENT_MAX_TARGET_RUNS", "OpenCode #3 by owner"],
  ]) {
    const f = fixture({ [setting]: "1" });
    f.data.runs = [{ id: 20, actor: { login: "owner" }, display_title: title }];
    await assert.rejects(f.run(), /budget exhausted/);
  }
});

test("ordinary comments, outsiders and the current run cannot consume the model budget", async () => {
  const f = fixture({ AGENT_MAX_DAILY_RUNS: "1" });
  f.data.runs = [
    { id: 20, actor: { login: "owner" } },
    { id: 21, actor: { login: "outsider" } },
    { id: 30, actor: { login: "owner" } },
  ];
  f.data.artifacts = [];
  assert.equal((await f.run()).allowed, "true");
  assert.equal(f.requests.filter(({ path }) => path.includes("/artifacts?")).length, 1);
});

test("an unbounded history fails closed rather than bypassing quotas", async () => {
  const f = fixture();
  f.data.runs = Array.from({ length: 100 }, () => ({ id: 20, actor: { login: "outsider" } }));
  await assert.rejects(f.run(), /pagination limit/);
});

test("PR budget spans days and counts reruns of a reserved request without using comments", async () => {
  const f = fixture({ AGENT_MAX_PR_RUNS: "3" });
  f.data.issue.pull_request = {};
  f.data.runs = [
    {
      id: 20,
      run_attempt: 3,
      display_title: "OpenCode #3 by owner",
      created_at: "2026-11-12T12:00:00Z",
    },
    { id: 21, run_attempt: 20, display_title: "OpenCode #8 by owner" },
  ];
  f.data.jobs = [
    {
      name: "Authorize request",
      steps: [{ name: "Reserve the authorized attempt", conclusion: "success" }],
    },
  ];
  await assert.rejects(f.run(), /Pull request run budget exhausted/);
  assert(f.requests.some(({ path }) => path.includes("/runs/20/jobs?filter=all")));
  assert(!f.requests.some(({ path }) => path.includes("/runs/21/jobs")));
  assert(!f.requests.some(({ path }) => path.includes("created=")));
});
