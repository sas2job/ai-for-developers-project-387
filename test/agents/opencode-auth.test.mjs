import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { consoleCredentials, signIn } from "../../script/agents/opencode-auth.mjs";

function fixture() {
  const env = {
    OPENCODE_CLIENT_ID: "sk_12345678-1234-1234-1234-123456789abc",
    ACTIONS_ID_TOKEN_REQUEST_URL:
      "https://oidc.actions.githubusercontent.com/idtoken?api-version=2.0",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "github-request-token",
  };
  const calls = [];
  const responses = [{ value: "identity.jwt.signature" }, { access_token: "oc_access-test-token" }];
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(url), options });
    return new Response(JSON.stringify(responses.shift()));
  };
  return { env, calls, responses, fetchImpl, run: () => consoleCredentials({ env, fetchImpl }) };
}

test("GitHub identity is exchanged with the exact Console audience and OAuth grant", async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), {
    oidc: "identity.jwt.signature",
    accessToken: "oc_access-test-token",
  });
  assert.equal(f.calls.length, 2);
  const [identity, exchange] = f.calls;
  assert.equal(identity.url.searchParams.get("api-version"), "2.0");
  assert.equal(identity.url.searchParams.get("audience"), "https://opencode.ai/console");
  assert.equal(identity.options.headers.Authorization, "Bearer github-request-token");
  assert.equal(exchange.url.href, "https://opencode.ai/console/auth/oauth/token");
  assert.equal(exchange.options.method, "POST");
  assert.deepEqual(Object.fromEntries(exchange.options.body), {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    client_id: f.env.OPENCODE_CLIENT_ID,
    subject_token: "identity.jwt.signature",
  });
  assert.ok(f.calls.every(({ options }) => options.redirect === "error"));
});

test("missing setup and invalid identities fail before any network request", async () => {
  for (const [key, value] of [
    ["OPENCODE_CLIENT_ID", ""],
    ["OPENCODE_CLIENT_ID", "arbitrary-client"],
    ["ACTIONS_ID_TOKEN_REQUEST_URL", ""],
    ["ACTIONS_ID_TOKEN_REQUEST_URL", "not-a-url"],
    ["ACTIONS_ID_TOKEN_REQUEST_TOKEN", ""],
    ["ACTIONS_ID_TOKEN_REQUEST_TOKEN", "secret\r\nX-Test: injected"],
  ]) {
    const f = fixture();
    f.env[key] = value;
    await assert.rejects(f.run());
    assert.deepEqual(f.calls, []);
  }
});

test("the GitHub request credential cannot be sent to an arbitrary URL", async () => {
  for (const url of [
    "https://example.com/idtoken",
    "https://oidc.actions.githubusercontent.com.example.com/idtoken",
    "http://oidc.actions.githubusercontent.com/idtoken",
    "https://user:password@oidc.actions.githubusercontent.com/idtoken",
    "https://oidc.actions.githubusercontent.com:444/idtoken",
  ]) {
    const f = fixture();
    f.env.ACTIONS_ID_TOKEN_REQUEST_URL = url;
    await assert.rejects(f.run(), /Invalid GitHub OIDC URL/);
    assert.deepEqual(f.calls, []);
  }
});

test("malformed token responses cannot inject GitHub environment entries or workflow commands", async () => {
  for (const value of [
    undefined,
    "",
    42,
    "token\nOTHER=value",
    "token\r::warning::injected",
    "x".repeat(16_385),
  ]) {
    const identity = fixture();
    identity.responses[0] = { value };
    await assert.rejects(identity.run(), /Invalid GitHub OIDC token/);
    assert.equal(identity.calls.length, 1);
    const access = fixture();
    access.responses[1] = { access_token: value };
    await assert.rejects(access.run(), /Invalid Console access token/);
  }
});

test("failed HTTP responses never expose their credential-bearing body", async () => {
  for (const failAt of [1, 2]) {
    const f = fixture();
    let calls = 0;
    f.fetchImpl = async () => {
      calls += 1;
      if (calls === failAt) return new Response("secret-provider-error-detail", { status: 403 });
      return new Response(JSON.stringify(f.responses.shift()));
    };
    await assert.rejects(consoleCredentials(f), (error) => {
      assert.match(error.message, /failed \(403\)/);
      assert.ok(!error.message.includes("secret-provider-error-detail"));
      return true;
    });
  }
});

test("network and JSON failures produce fixed errors without raw details", async () => {
  const f = fixture();
  for (const [fetchImpl, expected] of [
    [
      async () => {
        throw new Error("request included secret");
      },
      "GitHub OIDC request failed",
    ],
    [async () => new Response("secret-not-json"), "Invalid GitHub OIDC response"],
    [async () => new Response("x".repeat(65_537)), "Invalid GitHub OIDC response"],
  ]) {
    await assert.rejects(consoleCredentials({ env: f.env, fetchImpl }), { message: expected });
  }
});

test("successful sign-in masks both tokens and passes only the access token to the next step", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-auth-"));
  try {
    const f = fixture();
    f.env.GITHUB_ENV = join(directory, "github-env");
    let output = "";
    await signIn({
      ...f,
      log: (line) => {
        output += line;
      },
    });
    assert.equal(output, "::add-mask::identity.jwt.signature\n::add-mask::oc_access-test-token\n");
    assert.equal(
      await readFile(f.env.GITHUB_ENV, "utf8"),
      "OPENCODE_API_KEY=oc_access-test-token\n",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed exchange leaves no token in the environment file or log", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-auth-"));
  try {
    const f = fixture();
    f.env.GITHUB_ENV = join(directory, "github-env");
    f.responses[1] = { error_description: "secret-error-detail" };
    let output = "";
    await assert.rejects(
      signIn({
        ...f,
        log: (line) => {
          output += line;
        },
      }),
      /Invalid Console access token/,
    );
    assert.equal(output, "");
    await assert.rejects(readFile(f.env.GITHUB_ENV), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an environment API key is masked and used without requesting GitHub OIDC", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-auth-"));
  try {
    const env = {
      OPENCODE_API_KEY: "oc_sk_scoped-model-key",
      GITHUB_ENV: join(directory, "github-env"),
    };
    let output = "";
    await signIn({
      env,
      fetchImpl: () => assert.fail("API-key authentication must not request OIDC"),
      log: (line) => {
        output += line;
      },
    });
    assert.equal(output, "::add-mask::oc_sk_scoped-model-key\n");
    assert.equal(
      await readFile(env.GITHUB_ENV, "utf8"),
      "OPENCODE_API_KEY=oc_sk_scoped-model-key\n",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed API keys cannot inject environment entries or silently fall back to OIDC", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-auth-"));
  try {
    for (const key of [
      "secret\nOTHER=value",
      "secret\r::warning::injected",
      " ",
      "x".repeat(16_385),
    ]) {
      const env = { OPENCODE_API_KEY: key, GITHUB_ENV: join(directory, "github-env") };
      let output = "";
      await assert.rejects(
        signIn({
          env,
          fetchImpl: () => assert.fail("Unexpected OIDC fallback"),
          log: (line) => {
            output += line;
          },
        }),
        /Invalid Console API key/,
      );
      assert.equal(output, "");
      await assert.rejects(readFile(env.GITHUB_ENV), { code: "ENOENT" });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
