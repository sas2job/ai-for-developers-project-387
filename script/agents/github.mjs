import { requireValue } from "./policy.mjs";

export function createGitHub({
  token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  fetchImpl = fetch,
} = {}) {
  requireValue(token, "GH_TOKEN or GITHUB_TOKEN is required");
  return {
    async request(method, path, body) {
      requireValue(
        path.startsWith("/repos/") && !path.includes("://") && !/[\r\n]/.test(path),
        "Invalid GitHub API path",
      );
      const response = await fetchImpl(`https://api.github.com${path}`, {
        method,
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        const error = new Error(`GitHub ${method} failed (${response.status})`);
        error.status = response.status;
        throw error;
      }
      if (response.status === 204) return null;
      const raw = await response.text();
      requireValue(Buffer.byteLength(raw) <= 5_000_000, "GitHub response too large");
      return JSON.parse(raw);
    },
  };
}
