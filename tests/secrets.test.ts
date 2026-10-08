import assert from "node:assert/strict";
import test from "node:test";
import { parseExport, SecretStore, type Secret } from "../lib/secrets.ts";

const entries = [{ name: "API_KEY", value: "secret-value" }];

test("parse exports with strings, empty values and unresolved nulls", () => {
  assert.deepEqual(parseExport('{"secrets":{"TOKEN":"abc","EMPTY":"","MISSING":null}}'), [
    { name: "TOKEN", value: "abc" }, { name: "EMPTY", value: "" },
  ]);
});
for (const input of ["sensitive-garbage", "null", "[]", "{}", '{"secrets":[]}',
  '{"secrets":{"bad-name":"value"}}', '{"secrets":{"X":42}}']) {
  test(`invalid export is rejected without echoing it: ${input.length} bytes`, () => {
    assert.throws(() => parseExport(input), error => error instanceof Error && !error.message.includes(input));
  });
}

test("single-flight loading uses explicit config/profile/cwd and injects only after completion", async () => {
  const env: NodeJS.ProcessEnv = { FNOX_CONFIG: "/private/vault.toml", FNOX_PROFILE: "work" };
  let resolve!: (secrets: Secret[]) => void;
  let calls = 0;
  const store = new SecretStore(env, async request => {
    calls++;
    assert.equal(request.cwd, "/project");
    assert.equal(request.config, "/private/vault.toml");
    assert.equal(request.profile, "work");
    return new Promise(done => { resolve = done; });
  });
  const first = store.reload("/project");
  assert.equal(first, store.reload("/project"));
  assert.equal(calls, 1);
  assert.equal(env.API_KEY, undefined);
  resolve(entries);
  await first;
  assert.equal(env.API_KEY, "secret-value");
  assert.deepEqual(store.names(), ["API_KEY"]);
});

test("rotation/removal restore inherited env and retain old values for redaction", async () => {
  const env: NodeJS.ProcessEnv = { API_KEY: "inherited" };
  let next = entries;
  const store = new SecretStore(env, async () => next);
  await store.reload(".");
  next = [{ name: "OTHER", value: "rotated-value" }];
  await store.reload(".");
  assert.equal(env.API_KEY, "inherited");
  assert.equal(env.OTHER, "rotated-value");
  assert.equal(store.redactor.text("secret-value rotated-value"), "[REDACTED] [REDACTED]");
  next = [];
  await store.reload(".");
  assert.equal(env.OTHER, undefined);
  assert.deepEqual(store.names(), []);
});

test("failed refresh leaves previous snapshot and environment intact", async () => {
  const env: NodeJS.ProcessEnv = {};
  let fail = false;
  const store = new SecretStore(env, async () => {
    if (fail) throw new Error("provider failed");
    return entries;
  });
  await store.reload(".");
  fail = true;
  await assert.rejects(store.reload("."));
  assert.equal(env.API_KEY, "secret-value");
  assert.deepEqual(store.names(), ["API_KEY"]);
  store.clear();
  assert.equal(env.API_KEY, undefined);
});

test("shutdown cancels late loads and does not overwrite other extensions' env changes", async () => {
  const env: NodeJS.ProcessEnv = {};
  let resolve!: (secrets: Secret[]) => void;
  const store = new SecretStore(env, () => new Promise(done => { resolve = done; }));
  const pending = store.reload(".");
  store.clear();
  resolve(entries);
  await assert.rejects(pending, /cancelled/);
  assert.equal(env.API_KEY, undefined);
  const loaded = store.reload(".");
  resolve(entries);
  await loaded;
  env.API_KEY = "someone-else";
  store.clear();
  store.clear();
  assert.equal(env.API_KEY, "someone-else");
});
