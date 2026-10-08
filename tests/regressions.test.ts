import assert from "node:assert/strict";
import test from "node:test";
import { Redactor } from "../lib/redaction.ts";
import { SecretStore, type Secret } from "../lib/secrets.ts";

test("non-secret astral characters survive every stream split and delayed emission boundary", () => {
  const redactor = new Redactor();
  redactor.add(["abc"]);
  for (const text of ["😀X", "😀😀abcX", "X😀X😀X", "α😀😀XabcY"]) {
    const data = Buffer.from(text);
    for (let split = 0; split <= data.length; split++) {
      const chunks: Buffer[] = [];
      const stream = redactor.stream(chunk => chunks.push(chunk));
      stream.write(data.subarray(0, split));
      stream.write(data.subarray(split));
      stream.end();
      assert.equal(Buffer.concat(chunks).toString(), redactor.text(text));
    }
  }
});

test("arbitrary data keys are masked, colliding redactions retain both entries", () => {
  const redactor = new Redactor();
  redactor.add(["token-one", "token-two"]);
  const result = redactor.value({ "token-one": "one", "token-two": { "nested-token-one": "two" } });
  assert.ok(!JSON.stringify(result).includes("token-one"));
  assert.ok(!JSON.stringify(result).includes("token-two"));
  assert.equal(Object.keys(result).length, 2);
});

test("short secrets don't corrupt content discriminators, image bytes or protected Bash schema keys", () => {
  const redactor = new Redactor();
  redactor.add(["x"]);
  const blocks = redactor.content([
    { type: "text", text: "xyz" },
    { type: "image", data: "xxx", mimeType: "image/png" },
  ]);
  assert.equal(blocks[0].type, "text");
  assert.equal(blocks[0].text, "[REDACTED]yz");
  assert.equal(blocks[1].data, "xxx");
  const structured = redactor.value({ output: "xyz", exit_code: 0 }, new Set(["output", "exit_code"]));
  assert.equal(structured.exit_code, 0);
  assert.equal(structured.output, "[REDACTED]yz");
});

test("cancelled load A cannot clear or replace load B after clear/restart", async () => {
  const env: NodeJS.ProcessEnv = {};
  const resolves: ((secrets: Secret[]) => void)[] = [];
  const store = new SecretStore(env, () => new Promise(done => resolves.push(done)));
  const first = store.reload(".");
  store.clear();
  const second = store.reload(".");
  resolves[0]([{ name: "OLD", value: "old" }]);
  await assert.rejects(first, /cancelled/);
  assert.equal(store.reload("."), second);
  resolves[1]([{ name: "NEW", value: "new" }]);
  await second;
  assert.equal(env.OLD, undefined);
  assert.equal(env.NEW, "new");
  store.clear();
});
