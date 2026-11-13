import { createHash } from 'node:crypto';

export const LIMITS = Object.freeze({ body: 50_000, context: 500_000, comments: 100, pages: 5, findings: 10, tickets: 20, patch: 500_000 });
export const digest = (value) => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function requireValue(condition, message) { if (!condition) throw new Error(message); }
export function boundedText(value, label, max = LIMITS.body) {
  requireValue(typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max, `Invalid ${label}`);
  requireValue(!value.includes('\0'), `Invalid ${label}`);
  return value;
}
export function positiveInteger(value, label = 'target') {
  requireValue(/^[1-9]\d{0,8}$/.test(String(value)), `Invalid ${label}`);
  return Number(value);
}
export function sha(value) { requireValue(/^[a-f0-9]{40}$/.test(value), 'Invalid commit SHA'); return value; }
export function config(env) {
  requireValue(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY || ''), 'Invalid GITHUB_REPOSITORY');
  const owner = env.GITHUB_REPOSITORY.split('/')[0];
  const allowedActors = (env.AGENT_ALLOWED_ACTORS || owner).split(',').map((actor) => actor.trim().toLowerCase()).filter(Boolean);
  requireValue(allowedActors.length > 0 && allowedActors.every((actor) => /^[a-z0-9-]+$/.test(actor)), 'Invalid allowed actors');
  const limit = (name, fallback) => positiveInteger(env[name] || fallback, name);
  return { repository: env.GITHUB_REPOSITORY, allowedActors, enabled: env.AGENT_ENABLED !== 'false', mode: env.AGENT_API_ENABLED === 'true' ? 'api' : 'local', dailyRuns: limit('AGENT_MAX_DAILY_RUNS', 10), targetRuns: limit('AGENT_MAX_TARGET_RUNS', 6), workflow: env.AGENT_WORKFLOW_FILE || 'agents.yml' };
}
export function parseCommand(body, isPull) {
  if (typeof body !== 'string') return null;
  const match = /^\/agent (plan|approve ([a-f0-9]{64})|implement|review|fix)$/.exec(body.trim());
  if (!match) return null;
  const action = match[1].split(' ')[0];
  if ((isPull ? ['review', 'fix'] : ['plan', 'approve', 'implement']).includes(action)) return { action, approvalDigest: match[2] };
  return null;
}
export function trustedAuthor(user, settings) {
  return user && (user.login === 'github-actions[bot]' && user.type === 'Bot' || user.type !== 'Bot' && settings.allowedActors.includes(String(user.login).toLowerCase()));
}
const stateMarker = 'agent-control:state:v1';
export function stateBody(state, message = '') { return `${message}\n\n<!-- ${stateMarker}\n${JSON.stringify(state)}\n-->`; }
export function readState(comments, settings, issue) {
  for (const comment of [...comments].reverse()) {
    if (!trustedAuthor(comment.user, settings)) continue;
    const match = new RegExp(`<!-- ${stateMarker}\\n([^]*?)\\n-->$`).exec(comment.body || '');
    if (!match) continue;
    try {
      const state = JSON.parse(match[1]);
      if (state.version === 1 && state.issue === issue && Array.isArray(state.runs)) return { ...state, commentId: comment.id };
    } catch { /* An unrelated or damaged comment is not state. */ }
  }
  return { version: 1, issue, runs: [] };
}
export function planResult(result) {
  requireValue(result && result.spec && Array.isArray(result.tickets) && result.tickets.length > 0 && result.tickets.length <= LIMITS.tickets, 'Invalid plan schema');
  const document = (item) => {
    const value = { title: boundedText(item.title, 'title', 200), body: boundedText(item.body, 'body', 20_000) };
    requireValue(!/[\r\n]/.test(value.title), 'Plan titles must be a single line');
    requireValue(!JSON.stringify(value).includes('<!-- agent-control:'), 'Reserved plan marker');
    return value;
  };
  const plan = { spec: document(result.spec), tickets: result.tickets.map((ticket, index) => {
    requireValue(Array.isArray(ticket.blockedBy) && ticket.blockedBy.every((blocker) => Number.isInteger(blocker) && blocker >= 0 && blocker < index), 'Ticket blockers must reference earlier tickets');
    return { ...document(ticket), blockedBy: [...new Set(ticket.blockedBy)] };
  }) };
  requireValue(Buffer.byteLength(canonical(plan)) < 25_000, 'Plan is too large for an approval comment');
  return plan;
}
export function artifactMarker(issue, planDigest, key) { return `<!-- agent-control:artifact:v1 ${issue}:${planDigest}:${key} -->`; }
export function originMarker(issue, planDigest) { return `<!-- agent-control:origin:v1 ${issue}:${planDigest} -->`; }
export function origin(body = '') {
  const match = /<!-- agent-control:origin:v1 ([1-9]\d{0,8}):([a-f0-9]{64}) -->/.exec(body);
  return match ? { issue: Number(match[1]), digest: match[2] } : null;
}
export function patchPaths(patch) {
  boundedText(patch, 'patch', LIMITS.patch);
  requireValue(!/^(?:GIT binary patch|Binary files |old mode |new mode |deleted file mode (?!100644)|new file mode (?!100644)|rename |copy |similarity index )/m.test(patch), 'Unsafe patch metadata');
  const paths = [];
  for (const line of patch.split('\n')) {
    if (!line.startsWith('diff --git ')) continue;
    const match = /^diff --git a\/([^\s]+) b\/([^\s]+)$/.exec(line);
    requireValue(match && match[1] === match[2], 'Renamed or quoted paths are not allowed');
    const path = match[1];
    requireValue(!path.split('/').some((part) => !part || part === '..' || part.startsWith('.')) && !path.includes('\\') && !/[\x00-\x1f\x7f]/.test(path), 'Unsafe patch path');
    requireValue(!/^(?:AGENTS\.md|CLAUDE\.md)(?:\/|$)/i.test(path) && !/^(?:bin|docs\/agents|script\/agents)(?:\/|$)/i.test(path) && !/(?:^|\/)(?:AGENTS|CLAUDE)\.md$/i.test(path), 'Protected patch path');
    paths.push(path);
  }
  requireValue(paths.length > 0 && paths.length <= 100 && new Set(paths).size === paths.length, 'Invalid patch files');
  // Every file header must agree with the independently checked diff header.
  for (const line of patch.split('\n')) {
    if (!/^--- |^\+\+\+ /.test(line)) continue;
    const path = line.slice(4);
    requireValue(path === '/dev/null' || /^[ab]\//.test(path) && paths.includes(path.slice(2)), 'Unexpected patch file header');
  }
  return paths;
}
export function diffLines(files) {
  const lines = new Map();
  for (const file of files) {
    const valid = new Set();
    let right = 0, inHunk = false;
    for (const line of (file.patch || '').split('\n')) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (match) { right = Number(match[1]); inHunk = true; continue; }
      if (!inHunk || line.startsWith('\\')) continue;
      if (line.startsWith('+') || line.startsWith(' ')) { valid.add(right); right += 1; }
      else if (!line.startsWith('-')) inHunk = false;
    }
    lines.set(file.filename, valid);
  }
  return lines;
}
