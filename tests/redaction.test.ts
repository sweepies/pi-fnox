import assert from "node:assert/strict";
import test from "node:test";
import { Redactor } from "../lib/redaction.ts";

test("literal, longest-first masking includes short values and does not recursively mask markers", () => {
  const redactor = new Redactor();
  redactor.add(["abc", "abcdef", "a.b+[c]$", "xy", "", "REDACTED"]);
  assert.equal(redactor.text("abcdef abc a.b+[c]$ xy REDACTED"), "[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED]");
});

test("mask nested structured payloads/details without mutating inputs or looping on cycles", () => {
  const redactor = new Redactor();
  redactor.add(["private-token"]);
  const value = { content: [{ type: "text", text: "private-token" }], details: { nested: ["private-token", 42] } };
  const result = redactor.value(value);
  assert.equal(result.content[0].text, "[REDACTED]");
  assert.deepEqual(result.details.nested, ["[REDACTED]", 42]);
  assert.equal(value.content[0].text, "private-token");
  const cycle: { self?: unknown; value: string } = { value: "private-token" };
  cycle.self = cycle;
  const copy = redactor.value(cycle);
  assert.equal(copy.self, copy);
  assert.equal(copy.value, "[REDACTED]");
});

for (const secret of ["abcdef", "α🔑秘密", "x", "abc.def+ghi", "abcdefabcdef"]) {
  test(`stream masks every byte split, including UTF-8: ${secret}`, () => {
    const redactor = new Redactor();
    redactor.add([secret]);
    const data = Buffer.from(`before ${secret} after ${secret}\n`);
    const expected = redactor.text(data.toString());
    for (let split = 0; split <= data.length; split++) {
      const chunks: Buffer[] = [];
      const stream = redactor.stream(chunk => chunks.push(chunk));
      stream.write(data.subarray(0, split));
      stream.write(data.subarray(split));
      stream.end();
      assert.equal(Buffer.concat(chunks).toString(), expected, `split ${split}`);
    }
    const chunks: Buffer[] = [];
    const stream = redactor.stream(chunk => chunks.push(chunk));
    for (const byte of data) stream.write(Buffer.from([byte]));
    stream.end();
    assert.equal(Buffer.concat(chunks).toString(), expected);
  });
}

test("no secrets passes through and incomplete trailing prefixes are preserved", () => {
  const redactor = new Redactor();
  const chunks: Buffer[] = [];
  const stream = redactor.stream(chunk => chunks.push(chunk));
  stream.write(Buffer.from("plain text"));
  stream.end();
  assert.equal(Buffer.concat(chunks).toString(), "plain text");
  redactor.add(["abcde"]);
  const tail: Buffer[] = [];
  const masked = redactor.stream(chunk => tail.push(chunk));
  masked.write(Buffer.from("a partial abc"));
  masked.end();
  assert.equal(Buffer.concat(tail).toString(), "a partial abc");
});
