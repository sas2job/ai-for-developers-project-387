import { appendFile, readFile, writeFile, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { digest, LIMITS, requireValue } from "./policy.mjs";

const schemas = {
  plan: "plan",
  approve: null,
  implement: "change",
  review: "review",
  fix: "change",
};

export async function packageTask({ taskDir, root, action, contextDigest }) {
  requireValue(Object.hasOwn(schemas, action), "Unknown task role");
  requireValue(/^[a-f0-9]{64}$/.test(contextDigest), "Invalid context checksum");
  const contextPath = resolve(taskDir, "context.json");
  const item = await lstat(contextPath);
  requireValue(item.isFile() && item.size <= LIMITS.context, "Invalid task context file");
  const body = await readFile(contextPath, "utf8");
  requireValue(digest(body) === contextDigest, "Task context checksum mismatch");
  requireValue(JSON.parse(body).action === action, "Task role does not match context");
  const role = await readFile(resolve(root, "docs/agents/prompts", `${action}.md`), "utf8");
  const schema = schemas[action]
    ? await readFile(resolve(root, "docs/agents/schemas", `${schemas[action]}.json`), "utf8")
    : null;
  const options = { mode: 0o600, flag: "wx" };
  await writeFile(resolve(taskDir, "context.sha256"), `${contextDigest}  context.json\n`, options);
  await writeFile(resolve(taskDir, "role.md"), role, options);
  if (schema) await writeFile(resolve(taskDir, "result-schema.json"), schema, options);
  await appendFile(
    resolve(taskDir, "prompt.md"),
    `\n${role}\n${schema ? `\nResult JSON schema:\n${schema}\n` : ""}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  packageTask({
    taskDir: resolve(process.env.RUNNER_TEMP || "/tmp", "agent-task"),
    root: process.cwd(),
    action: process.env.TASK_ACTION,
    contextDigest: process.env.CONTEXT_SHA256,
  }).catch(() => {
    process.stderr.write("Task instructions could not be packaged safely.\n");
    process.exitCode = 1;
  });
}
