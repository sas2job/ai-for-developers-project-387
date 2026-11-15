import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { requireValue, sha, patchPaths } from "./policy.mjs";

// This adapter only invokes fixed git operations. It never runs project scripts,
// model output, hooks, shell fragments, tests or package installation.
export function createGitPublisher({ cwd = process.cwd(), env = process.env } = {}) {
  async function git(args, input) {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(
        "git",
        ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
        {
          cwd,
          shell: false,
          env: {
            ...env,
            GIT_TERMINAL_PROMPT: "0",
            GIT_CONFIG_COUNT: "0",
            GIT_LITERAL_PATHSPECS: "1",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let output = "",
        size = 0;
      const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size > 2_000_000) child.kill("SIGKILL");
        else output += chunk;
      });
      // Git stderr can contain credential-bearing remote URLs. Never forward it.
      child.stderr.resume();
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`Cannot start trusted git operation: ${error.code}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolvePromise(output.trim());
        else reject(new Error(`Trusted git ${args[0]} failed (${code})`));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
  }
  async function safeWorktree(paths) {
    const root = await realpath(cwd);
    for (const file of paths) {
      let current = resolve(root, file);
      requireValue(relative(root, current) === file, "Patch path escapes checkout");
      while (current !== root) {
        try {
          const item = await lstat(current);
          requireValue(!item.isSymbolicLink(), "Symlinks are not allowed in patch paths");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        current = dirname(current);
      }
    }
    const modes = await git(["ls-files", "--stage", "--", ...paths]);
    requireValue(
      modes.split("\n").every((line) => !line || line.startsWith("100644 ")),
      "Unsafe existing file mode",
    );
  }
  return {
    async publish(task) {
      const paths = patchPaths(task.patch);
      sha(task.headSha);
      sha(task.baseSha);
      requireValue(/^agent\/issue-[1-9]\d{0,8}$/.test(task.branch), "Invalid controlled branch");
      requireValue(
        (await git(["status", "--porcelain"])) === "",
        "Publisher checkout must be clean",
      );
      const remote = await git(["remote", "get-url", "origin"]);
      requireValue(
        remote === `https://github.com/${task.repository}.git` ||
          remote === `https://github.com/${task.repository}` ||
          remote === `git@github.com:${task.repository}.git`,
        "Publisher origin must be the configured repository",
      );
      await git(["fetch", "--no-tags", "origin", task.headSha]);
      await git(["switch", "--detach", task.headSha]);
      await safeWorktree(paths);
      await git(["apply", "--check", "--whitespace=error-all", "-"], task.patch);
      await git(["apply", "--whitespace=error-all", "-"], task.patch);
      await safeWorktree(paths);
      await git(["add", "--", ...paths]);
      const changed = (await git(["diff", "--cached", "--name-only"])).split("\n").filter(Boolean);
      requireValue(
        changed.length > 0 && changed.every((file) => paths.includes(file)),
        "Unexpected staged changes",
      );
      await git([
        "-c",
        "user.name=github-actions[bot]",
        "-c",
        "user.email=41898282+github-actions[bot]@users.noreply.github.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        `feat: implement approved issue (#${task.issue})`,
      ]);
      const headSha = sha(await git(["rev-parse", "HEAD"]));
      // A normal push rejects a concurrent update; this publisher never force-pushes.
      await git(["push", "origin", `HEAD:refs/heads/${task.branch}`]);
      return { headSha };
    },
  };
}
