import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonical, digest, LIMITS, requireValue } from './policy.mjs';

const commands = new Set(['publish-plan', 'publish-review', 'publish-change']);
const publisherFile = fileURLToPath(new URL('./cli.mjs', import.meta.url));

async function readBounded(path, maximum, label) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    requireValue(stat.isFile() && stat.size > 0 && stat.size <= maximum, `Invalid ${label} size`);
    const body = await file.readFile('utf8');
    requireValue(Buffer.byteLength(body) <= maximum, `Invalid ${label} size`);
    return body;
  } catch (error) {
    if (error.message === `Invalid ${label} size`) throw error;
    throw new Error(`Cannot read ${label} as a regular file`);
  } finally {
    await file?.close();
  }
}

function parseJSON(body, label) {
  try { return JSON.parse(body); }
  catch { throw new Error(`Invalid ${label} JSON`); }
}

function repositoryFromRemote(remote) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote.trim());
  return match?.[1];
}

// Capture all subprocess output, including failures: authentication commands may
// return credentials, and remote error messages can contain credential URLs.
async function runCaptured(file, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { ...options, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', size = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) child.kill('SIGKILL');
      else output += chunk;
    });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(new Error('Cannot start trusted publishing subprocess')); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(output);
      else reject(new Error('Trusted publishing subprocess failed'));
    });
  });
}

export async function localPublish(args, { env = process.env, cwd = process.cwd(), run = runCaptured } = {}) {
  async function invoke(file, argv, options, failure) {
    try {
      const output = await run(file, argv, options);
      requireValue(typeof output === 'string' && Buffer.byteLength(output) <= 1_000_000, failure);
      return output;
    } catch { throw new Error(failure); }
  }
  const [command, directory, resultName, patchName] = args;
  requireValue(commands.has(command) && args.length === (command === 'publish-change' ? 4 : 3), 'Usage: bin/agent-publish <publish-plan|publish-review|publish-change> <task-directory> <result.json> [change.patch]');
  requireValue([directory, resultName, ...(patchName ? [patchName] : [])].every((value) => typeof value === 'string' && value.length > 0), 'Publishing file paths are required');
  const contextPath = resolve(cwd, directory, 'context.json');
  const checksumPath = resolve(cwd, directory, 'context.sha256');
  const resultPath = resolve(cwd, resultName);
  const patchPath = patchName ? resolve(cwd, patchName) : undefined;

  // Complete read-only artifact validation before touching git or GitHub auth.
  const checksum = await readBounded(checksumPath, 100, 'context checksum');
  const match = /^([a-f0-9]{64})  context\.json\n?$/.exec(checksum);
  requireValue(match, 'Invalid context checksum format');
  const contextBody = await readBounded(contextPath, LIMITS.context, 'context');
  requireValue(digest(contextBody) === match[1], 'Task context checksum does not match');
  const context = parseJSON(contextBody, 'context');
  requireValue(context && context.version === 1 && canonical(context) === contextBody, 'Task context must use canonical version 1 JSON');
  requireValue(typeof context.repository === 'string' && typeof context.actor === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.repository) && /^[A-Za-z0-9-]+$/.test(context.actor), 'Invalid task repository or actor');
  parseJSON(await readBounded(resultPath, LIMITS.context, 'result'), 'result');
  if (patchPath) await readBounded(patchPath, LIMITS.patch, 'patch');

  const authEnvironment = { ...env, GH_HOST: 'github.com' };
  const repository = repositoryFromRemote(await invoke('git', ['remote', 'get-url', 'origin'], { cwd, env: authEnvironment }, 'Repository identity check failed'));
  requireValue(repository?.toLowerCase() === context.repository.toLowerCase(), 'Current repository does not match the downloaded task');
  const actor = (await invoke('gh', ['api', 'user', '--jq', '.login'], { cwd, env: authEnvironment }, 'GitHub identity check failed')).trim();
  requireValue(actor.toLowerCase() === context.actor.toLowerCase(), 'Authenticated GitHub user does not match the downloaded task actor');
  const token = env.GH_TOKEN || env.GITHUB_TOKEN || (await invoke('gh', ['auth', 'token'], { cwd, env: authEnvironment }, 'GitHub token retrieval failed')).trim();
  requireValue(typeof token === 'string' && token.length > 0 && token.length <= 16_384 && !/[\r\n\0]/.test(token), 'Cannot obtain a valid GitHub authentication token');
  const publisherEnvironment = {
    ...env,
    GH_TOKEN: token,
    GITHUB_REPOSITORY: context.repository,
    GITHUB_ACTOR: context.actor,
    AGENT_CONTEXT_SHA256: match[1],
    AGENT_ALLOWED_ACTORS: env.AGENT_ALLOWED_ACTORS || context.repository.split('/')[0],
  };
  const publisherArgs = [publisherFile, command, '--context', contextPath, '--result', resultPath];
  if (patchPath) publisherArgs.push('--patch', patchPath);
  await invoke(process.execPath, publisherArgs, { cwd, env: publisherEnvironment }, 'Trusted publisher failed; check task freshness, repository permissions and result schema');
  return { operation: command, repository: context.repository, actor: context.actor };
}

export async function main(args = process.argv.slice(2)) {
  await localPublish(args);
  process.stdout.write('Result published.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
