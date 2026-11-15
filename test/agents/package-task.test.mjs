import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { packageTask } from "../../script/agents/package-task.mjs";
import { digest } from "../../script/agents/policy.mjs";

async function fixture(t, action = "plan") {
  const taskDir = await mkdtemp(join(tmpdir(), "agent-package-"));
  t.after(() => rm(taskDir, { recursive: true, force: true }));
  const body = JSON.stringify({ action, body: "untrusted issue contents" });
  await writeFile(join(taskDir, "context.json"), body);
  await writeFile(join(taskDir, "prompt.md"), "Trusted preparation instructions.\n");
  return {
    taskDir,
    root: resolve(import.meta.dirname, "../.."),
    action,
    contextDigest: digest(body),
  };
}

test("downloaded task bundles checksum, role and matching response schema", async (t) => {
  const options = await fixture(t);
  await packageTask(options);
  assert.equal(
    await readFile(join(options.taskDir, "context.sha256"), "utf8"),
    `${options.contextDigest}  context.json\n`,
  );
  const prompt = await readFile(join(options.taskDir, "prompt.md"), "utf8");
  assert.match(prompt, /to-spec\/SKILL.md/);
  assert.match(prompt, /to-tickets\/SKILL.md/);
  assert.equal(
    JSON.parse(await readFile(join(options.taskDir, "result-schema.json"), "utf8")).properties
      .tickets.type,
    "array",
  );
});

test("tampered context and mismatched role are rejected before packaging", async (t) => {
  const options = await fixture(t);
  await writeFile(join(options.taskDir, "context.json"), JSON.stringify({ action: "fix" }));
  await assert.rejects(packageTask(options), /checksum mismatch/);
  const body = await readFile(join(options.taskDir, "context.json"), "utf8");
  await assert.rejects(
    packageTask({ ...options, contextDigest: digest(body) }),
    /role does not match/,
  );
  await assert.rejects(readFile(join(options.taskDir, "context.sha256")), { code: "ENOENT" });
});

test("role names cannot escape trusted prompt directory and bundles cannot be overwritten", async (t) => {
  const options = await fixture(t, "review");
  await assert.rejects(
    packageTask({ ...options, action: "../../package.json" }),
    /Unknown task role/,
  );
  await packageTask(options);
  await assert.rejects(packageTask(options), { code: "EEXIST" });
  assert.match(await readFile(join(options.taskDir, "role.md"), "utf8"), /code-review\/SKILL.md/);
});
