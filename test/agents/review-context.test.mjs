import assert from "node:assert/strict";
import test from "node:test";
import { collectReview } from "../../script/agents/review-context.mjs";

const repository = "owner/calendar";
const head = "a".repeat(40);
const owner = { login: "owner", type: "User" };
const app = { login: "github-actions[bot]", type: "Bot" };

function fixture(user = owner) {
  const approval = "https://github.com/owner/calendar/issues/15#issuecomment-7084186128";
  const pull = {
    number: 19,
    state: "open",
    user,
    head: { sha: head, ref: "opencode/issue15-20261122", repo: { full_name: repository } },
    base: { ref: "main", repo: { full_name: repository } },
    body: "Refs #15\nCloses #17\nCloses #18\n[Согласование](" + approval + ")",
    changed_files: 1,
  };
  const event = {
    action: "synchronize",
    pull_request: structuredClone(pull),
    sender: user,
    repository: { full_name: repository, default_branch: "main" },
  };
  const env = {
    GITHUB_REPOSITORY: repository,
    GITHUB_ACTOR: user.login,
    GITHUB_EVENT_NAME: "pull_request",
  };
  const endpoints = new Map([
    ["/collaborators/owner/permission", { permission: "write" }],
    ["/pulls/19", pull],
    ["/issues/15", { number: 15, body: "Need to filter meetings" }],
    ["/issues/17", { number: 17, body: "Agreed scenarios" }],
    ["/issues/18", { number: 18, body: "Filter /admin" }],
    ["/issues/comments/7084186128", { user: owner, html_url: approval, body: "Approved" }],
    ["/pulls/19/files?per_page=40", [{ filename: "app/controller.rb", patch: "+filter" }]],
    [
      "/commits/" + head + "/check-runs?per_page=40",
      { check_runs: [{ name: "check", status: "in_progress" }] },
    ],
    ["/commits/" + head + "/status?per_page=40", { statuses: [] }],
    ["/issues/19/comments?per_page=20", []],
    ["/pulls/19/reviews?per_page=20", []],
    ["/pulls/19/comments?per_page=20", []],
  ]);
  const calls = [];
  const github = {
    async request(method, path) {
      assert.equal(method, "GET");
      calls.push(path);
      const route = path.slice(("/repos/" + repository).length);
      assert(endpoints.has(route), route);
      return endpoints.get(route);
    },
  };
  return { event, pull, calls, run: () => collectReview({ github, event, env }) };
}

test("review reads the issue, spec, ticket, human approval, diff and status of the exact SHA", async () => {
  const { run } = fixture();
  const review = await run();
  assert.equal(review.head, head);
  assert.deepEqual(
    review.issues.map(({ number }) => number),
    [15, 17, 18],
  );
  assert.equal(review.approvalLinks[0].trustedHuman, true);
  assert.equal(review.approvalLinks[0].body, "Approved");
  assert.equal(review.files[0].patch, "+filter");
  assert.equal(review.checks[0].status, "in_progress");
});

test("review accepts a generated agent PR and rejects forks or unrelated bot branches", async () => {
  const generated = fixture(app);
  assert.equal((await generated.run()).number, 19);
  const fork = fixture();
  fork.event.pull_request.head.repo.full_name = "outsider/calendar";
  await assert.rejects(fork.run(), /ineligible/);
  assert.deepEqual(fork.calls, []);
  const otherBotBranch = fixture(app);
  otherBotBranch.event.pull_request.head.ref = "random-bot-branch";
  await assert.rejects(otherBotBranch.run(), /ineligible/);
  assert.deepEqual(otherBotBranch.calls, []);
});

test("a newer head aborts review before loading the diff or contacting the model", async () => {
  const { pull, run, calls } = fixture();
  pull.head.sha = "b".repeat(40);
  await assert.rejects(run(), /changed/);
  assert.equal(calls.length, 2);
});
