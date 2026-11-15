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
    artifacts: [{ name: "opencode-request" }],
  };
  const requests = [];
  const github = {
    async request(method, path) {
      requests.push({ method, path });
      assert.equal(method, "GET");
      if (path.includes("/collaborators/")) return { permission: data.permission };
      if (/\/(?:issues|pulls)\/comments\/7$/.test(path)) return data.comment;
      if (path.endsWith("/issues/3")) return data.issue;
      if (path.endsWith("/pulls/3")) return data.pull;
      if (path.includes("/actions/workflows/")) return { workflow_runs: data.runs };
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

test("an allowed human can invoke the free model without any write API calls", async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { allowed: "true", model: "opencode/glm-5.3-flash-free" });
  assert.ok(f.requests.some(({ path }) => path.includes("created=%3E%3D2026-11-15")));
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
