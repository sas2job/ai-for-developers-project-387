import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { localPublish } from '../../script/agents/local-publish.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-publish-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const context = { actor: 'owner', repository: 'owner/calendar', version: 1 };
  const body = JSON.stringify(context);
  const hash = createHash('sha256').update(body).digest('hex');
  await writeFile(join(directory, 'context.json'), body);
  await writeFile(join(directory, 'context.sha256'), `${hash}  context.json\n`);
  const result = join(directory, 'result.json');
  await writeFile(result, '{}');
  const calls = [];
  const run = async (file, args, options) => {
    calls.push({ file, args, options });
    if (file === 'git') return 'git@github.com:owner/calendar.git\n';
    if (file === 'gh' && args[0] === 'api') return 'owner\n';
    if (file === 'gh') return 'secret-token\n';
    return '';
  };
  return { directory, result, context, hash, calls, run };
}

test('local publication checks identity then invokes the trusted publisher with fixed arguments', async (t) => {
  const f = await fixture(t);
  const result = await localPublish(['publish-plan', f.directory, f.result], { env: { PATH: process.env.PATH }, cwd: f.directory, run: f.run });
  assert.deepEqual(f.calls.slice(0, 3).map((call) => [call.file, call.args]), [
    ['git', ['remote', 'get-url', 'origin']],
    ['gh', ['api', 'user', '--jq', '.login']],
    ['gh', ['auth', 'token']],
  ]);
  const publisher = f.calls[3];
  assert.equal(publisher.file, process.execPath);
  assert.deepEqual(publisher.args.slice(1), ['publish-plan', '--context', join(f.directory, 'context.json'), '--result', f.result]);
  assert.equal(publisher.options.env.GH_TOKEN, 'secret-token');
  assert.equal(publisher.options.env.AGENT_CONTEXT_SHA256, f.hash);
  assert.equal(publisher.options.env.GITHUB_REPOSITORY, 'owner/calendar');
  assert.equal(publisher.options.env.GITHUB_ACTOR, 'owner');
  assert.equal(publisher.options.env.AGENT_ALLOWED_ACTORS, 'owner');
  assert.ok(f.calls.slice(0, 3).every((call) => !call.options.env.GH_TOKEN));
  assert.equal(JSON.stringify(result).includes('secret-token'), false);
});

test('tampered context and malformed checksum files fail before any subprocess', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'context.json'), JSON.stringify({ ...f.context, actor: 'attacker' }));
  await assert.rejects(localPublish(['publish-plan', f.directory, f.result], { run: f.run }), /checksum does not match/);
  for (const checksum of [
    `${f.hash}  ../context.json\n`,
    `${f.hash}  context.json\n${f.hash}  context.json\n`,
    `${f.hash} context.json\n`,
    `${f.hash.toUpperCase()}  context.json\n`,
    `${f.hash}  context.json\r\n`,
  ]) {
    await writeFile(join(f.directory, 'context.sha256'), checksum);
    await assert.rejects(localPublish(['publish-plan', f.directory, f.result], { run: f.run }), /checksum (format|size)/);
  }
  assert.equal(f.calls.length, 0);
});

test('unknown operations and extra arguments are rejected without reading files or subprocesses', async (t) => {
  const f = await fixture(t);
  for (const args of [[], ['plan'], ['publish-plan', '/missing', '/missing', 'extra'], ['publish-review', '/missing', '/missing', 'extra'], ['publish-change', '/missing', '/missing'], ['publish-change', '/missing', '/missing', '/missing', 'extra'], ['publish-plan; gh auth token', '/missing', '/missing']]) {
    await assert.rejects(localPublish(args, { run: f.run }), /Usage/);
  }
  assert.equal(f.calls.length, 0);
});

test('a different repository or authenticated actor stops before token retrieval', async (t) => {
  const f = await fixture(t);
  const calls = [];
  const wrongRepository = async (file, args) => { calls.push([file, args]); return 'https://github.com/outsider/calendar.git\n'; };
  await assert.rejects(localPublish(['publish-plan', f.directory, f.result], { run: wrongRepository }), /Current repository does not match/);
  assert.deepEqual(calls.map(([file]) => file), ['git']);
  calls.length = 0;
  const wrongActor = async (file, args) => { calls.push([file, args]); return file === 'git' ? 'https://github.com/owner/calendar.git\n' : 'outsider\n'; };
  await assert.rejects(localPublish(['publish-plan', f.directory, f.result], { run: wrongActor }), /Authenticated GitHub user does not match/);
  assert.deepEqual(calls.map(([file, args]) => [file, args]), [['git', ['remote', 'get-url', 'origin']], ['gh', ['api', 'user', '--jq', '.login']]]);
});

test('change publication preserves configured limits and passes patch paths as a fixed argument', async (t) => {
  const f = await fixture(t);
  const patch = join(f.directory, 'change;not-a-command.patch');
  await writeFile(patch, 'text patch');
  const token = 'existing-token';
  const env = { GH_TOKEN: token, AGENT_ALLOWED_ACTORS: 'owner,maintainer', AGENT_MAX_TARGET_RUNS: '4', AGENT_MAX_DAILY_RUNS: '8' };
  const result = await localPublish(['publish-change', f.directory, f.result, patch], { env, run: f.run });
  assert.equal(f.calls.length, 3);
  const publisher = f.calls.at(-1);
  assert.deepEqual(publisher.args.slice(1), ['publish-change', '--context', join(f.directory, 'context.json'), '--result', f.result, '--patch', patch]);
  assert.equal(publisher.options.env.AGENT_ALLOWED_ACTORS, 'owner,maintainer');
  assert.equal(publisher.options.env.AGENT_MAX_TARGET_RUNS, '4');
  assert.equal(publisher.options.env.AGENT_MAX_DAILY_RUNS, '8');
  assert.equal(publisher.options.env.GH_TOKEN, token);
  assert.equal(result.operation, 'publish-change');
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(env.AGENT_CONTEXT_SHA256, undefined);
});

test('oversized or malformed results fail before authentication', async (t) => {
  const f = await fixture(t);
  await writeFile(f.result, 'x'.repeat(500_001));
  await assert.rejects(localPublish(['publish-review', f.directory, f.result], { run: f.run }), /Invalid result size/);
  await writeFile(f.result, '{"secret":"do-not-echo"');
  await assert.rejects(localPublish(['publish-review', f.directory, f.result], { run: f.run }), (error) => /Invalid result JSON/.test(error.message) && !error.message.includes('do-not-echo'));
  assert.equal(f.calls.length, 0);
});

test('subprocess failure output never becomes a credential-bearing error', async (t) => {
  const f = await fixture(t);
  const run = async (file, args, options) => {
    if (file === process.execPath) throw new Error(`remote failure exposed ${options.env.GH_TOKEN}`);
    return f.run(file, args, options);
  };
  await assert.rejects(localPublish(['publish-plan', f.directory, f.result], { env: {}, run }), (error) => /Trusted publisher failed/.test(error.message) && !error.message.includes('secret-token'));
});
