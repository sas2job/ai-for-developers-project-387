import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createGitHub } from "./github.mjs";
import { config, positiveInteger, requireValue, sha, trustedAuthor } from "./policy.mjs";

const bot = "github-actions[bot]";
const agentBranch = /^(?:agent\/issue-\d+|opencode\/(?:issue|pr)\d+-[a-zA-Z0-9-]+)$/;

export async function collectReview({ github, event, env }) {
  const settings = config(env);
  const { pull_request: snapshot, sender, repository } = event;
  const author = snapshot?.user;
  const isAgent = author?.login === bot && author.type === "Bot";
  requireValue(
    settings.enabled &&
      env.GITHUB_EVENT_NAME === "pull_request" &&
      ["opened", "reopened", "synchronize", "ready_for_review"].includes(event.action) &&
      repository?.full_name === settings.repository &&
      sender?.login === env.GITHUB_ACTOR &&
      trustedAuthor(sender, settings) &&
      trustedAuthor(author, settings) &&
      snapshot.head?.repo?.full_name === settings.repository &&
      snapshot.base?.repo?.full_name === settings.repository &&
      snapshot.base.ref === repository.default_branch &&
      (!isAgent || agentBranch.test(snapshot.head.ref)),
    "Pull request is ineligible for automatic review",
  );
  const number = positiveInteger(snapshot.number, "pull request");
  const head = sha(snapshot.head.sha);
  const get = (path) => github.request("GET", `/repos/${settings.repository}${path}`);
  for (const login of new Set(
    [sender, author].filter((user) => user.type === "User").map((user) => user.login),
  )) {
    const access = await get(`/collaborators/${encodeURIComponent(login)}/permission`);
    requireValue(
      ["write", "maintain", "admin"].includes(access.permission),
      "Write permission required",
    );
  }
  const pull = await get(`/pulls/${number}`);
  requireValue(
    pull.state === "open" &&
      !pull.draft &&
      pull.head?.sha === head &&
      pull.head?.repo?.full_name === settings.repository &&
      pull.base?.ref === repository.default_branch,
    "Pull request changed or is unavailable",
  );

  const description = pull.body || "";
  const root = `https://github.com/${settings.repository}/issues/`;
  const fromLinks = [
    ...description.matchAll(
      /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/([1-9]\d*)(?:#issuecomment-([1-9]\d*))?/g,
    ),
  ].filter(([url]) => url.startsWith(root));
  const fromReferences = [...description.matchAll(/(?:^|\s)#([1-9]\d*)\b/g)];
  const references = [...new Set([...fromLinks, ...fromReferences].map(([, id]) => id))].slice(
    0,
    10,
  );
  const issues = [];
  for (const id of references) {
    try {
      const issue = await get(`/issues/${positiveInteger(id, "issue")}`);
      issues.push({
        number: issue.number,
        title: issue.title,
        body: issue.body?.slice(0, 10000),
        url: issue.html_url,
        labels: issue.labels?.map(({ name }) => name),
      });
    } catch (error) {
      if (error.status !== 404 && error.status !== 403) throw error;
      issues.push({ number: id, unavailable: true });
    }
  }
  const approvalLinks = [];
  for (const [url, , commentId] of fromLinks.filter(([, , id]) => id).slice(0, 4)) {
    try {
      const comment = await get(`/issues/comments/${positiveInteger(commentId, "comment")}`);
      approvalLinks.push({
        url,
        author: comment.user?.login,
        trustedHuman: comment.user?.type === "User" && trustedAuthor(comment.user, settings),
        body: comment.html_url === url ? comment.body?.slice(0, 12000) : null,
      });
    } catch (error) {
      if (error.status !== 404 && error.status !== 403) throw error;
      approvalLinks.push({ url, unavailable: true });
    }
  }
  const [files, checks, statuses, comments, reviews, inline] = await Promise.all([
    get(`/pulls/${number}/files?per_page=40`),
    get(`/commits/${head}/check-runs?per_page=40`),
    get(`/commits/${head}/status?per_page=40`),
    get(`/issues/${number}/comments?per_page=20`),
    get(`/pulls/${number}/reviews?per_page=20`),
    get(`/pulls/${number}/comments?per_page=20`),
  ]);
  let remainingPatch = 96000;
  const patches = files.map(({ filename, previous_filename, status, patch }) => {
    const excerpt = patch?.slice(0, remainingPatch);
    remainingPatch -= excerpt?.length || 0;
    return {
      filename,
      previous_filename,
      status,
      patch: excerpt,
      truncated: !patch || excerpt.length < patch.length,
    };
  });
  return {
    number,
    head,
    title: pull.title,
    description: description.slice(0, 12000),
    issues,
    approvalLinks,
    changedFiles: pull.changed_files,
    files: patches,
    checks: checks.check_runs.map(({ name, status, conclusion, html_url }) => ({
      name,
      status,
      conclusion,
      html_url,
    })),
    statuses: statuses.statuses.map(({ context, state, target_url }) => ({
      context,
      state,
      target_url,
    })),
    discussion: [...comments, ...reviews].map(({ user, body, html_url }) => ({
      author: user?.login,
      body: body?.slice(0, 2000),
      url: html_url,
    })),
    inline: inline.map(({ path, line, body, html_url }) => ({
      path,
      line,
      body: body?.slice(0, 1500),
      url: html_url,
    })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const raw = await readFile(process.env.GITHUB_EVENT_PATH, "utf8");
  requireValue(Buffer.byteLength(raw) <= 500000, "Event is too large");
  const data = await collectReview({
    github: createGitHub(),
    event: JSON.parse(raw),
    env: process.env,
  });
  await writeFile(process.argv[2], JSON.stringify(data), { flag: "wx", mode: 0o600 });
}
