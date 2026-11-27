import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { requireValue } from "./policy.mjs";

const audience = "https://opencode.ai/console";
const exchangeURL = `${audience}/auth/oauth/token`;

function token(value, label) {
  requireValue(
    typeof value === "string" && value.length <= 16_384 && /^[A-Za-z0-9._~+/-]+=*$/.test(value),
    `Invalid ${label}`,
  );
  return value;
}

export async function consoleCredentials({ env = process.env, fetchImpl = fetch } = {}) {
  requireValue(
    /^sk_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      env.OPENCODE_CLIENT_ID || "",
    ),
    "Configure the OPENCODE_CLIENT_ID repository variable",
  );
  requireValue(
    env.ACTIONS_ID_TOKEN_REQUEST_URL,
    "GitHub OIDC URL is missing; grant id-token: write",
  );
  let oidcURL;
  try {
    oidcURL = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  } catch {
    throw new Error("Invalid GitHub OIDC URL");
  }
  requireValue(
    oidcURL.protocol === "https:" &&
      oidcURL.hostname.endsWith(".actions.githubusercontent.com") &&
      !oidcURL.port &&
      !oidcURL.username &&
      !oidcURL.password,
    "Invalid GitHub OIDC URL",
  );
  const requestToken = token(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, "GitHub OIDC request token");
  oidcURL.searchParams.set("audience", audience);

  async function json(url, options, label) {
    let response;
    try {
      response = await fetchImpl(url, {
        ...options,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error(`${label} request failed`);
    }
    requireValue(response.ok, `${label} failed (${response.status})`);
    try {
      const body = await response.text();
      requireValue(Buffer.byteLength(body) <= 65_536, "Response too large");
      return JSON.parse(body);
    } catch {
      throw new Error(`Invalid ${label} response`);
    }
  }

  const identity = await json(
    oidcURL,
    { headers: { Authorization: `Bearer ${requestToken}` } },
    "GitHub OIDC",
  );
  const oidc = token(identity.value, "GitHub OIDC token");
  const exchanged = await json(
    exchangeURL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        client_id: env.OPENCODE_CLIENT_ID,
        subject_token: oidc,
      }),
    },
    "Console token exchange",
  );
  return { oidc, accessToken: token(exchanged.access_token, "Console access token") };
}

export async function signIn({
  env = process.env,
  fetchImpl = fetch,
  log = (line) => process.stdout.write(line),
} = {}) {
  requireValue(env.GITHUB_ENV, "GitHub environment file is missing");
  const credentials = env.OPENCODE_API_KEY
    ? { accessToken: token(env.OPENCODE_API_KEY, "Console API key") }
    : await consoleCredentials({ env, fetchImpl });
  if (credentials.oidc) log(`::add-mask::${credentials.oidc}\n`);
  log(`::add-mask::${credentials.accessToken}\n`);
  await appendFile(env.GITHUB_ENV, `OPENCODE_API_KEY=${credentials.accessToken}\n`, {
    mode: 0o600,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await signIn();
  } catch (error) {
    // Never include fetch errors, response bodies or credentials in logs.
    process.stderr.write(
      `OpenCode sign-in failed: ${error.code ? "Environment file unavailable" : error.message}\n`,
    );
    process.exitCode = 1;
  }
}
