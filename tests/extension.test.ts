import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import type { BashOperations, ExtensionAPI, ExtensionToolContext, ToolDefinition, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { install } from "../extensions/index.ts";
import { SecretStore } from "../lib/secrets.ts";

function harness(local: BashOperations, store: SecretStore) {
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const commands = new Map<string, { handler: (...args: unknown[]) => unknown }>();
  let tool: ToolDefinition | undefined;
  const api = {
    on: (name: string, handler: (...args: unknown[]) => unknown) => hooks.set(name, handler),
    registerTool: (definition: ToolDefinition) => { tool = definition; },
    registerCommand: (name: string, command: { handler: (...args: unknown[]) => unknown }) => commands.set(name, command),
  } as unknown as ExtensionAPI;
  install(api, store, local);
  assert.ok(tool);
  return { hooks, commands, tool };
}

const context = {
  cwd: process.cwd(),
  sessionManager: { getSessionId: () => "current-session", getSessionFile: () => undefined },
} as unknown as ExtensionToolContext;

test("await startup; keep hooks focused, prompt/list names-only and reload failure safe", async () => {
  let loaded = false;
  let fail = false;
  const notices: string[] = [];
  const store = new SecretStore({}, async () => {
    if (fail) throw new Error("never show provider-secret");
    await new Promise(done => setTimeout(done, 5));
    loaded = true;
    return [{ name: "TOKEN", value: "private-value" }];
  });
  const { hooks, commands } = harness({ exec: async () => ({ exitCode: 0 }) }, store);
  const ctx = { cwd: ".", ui: { notify: (text: string) => notices.push(text) } };
  await hooks.get("session_start")!({}, ctx);
  assert.equal(loaded, true);
  assert.deepEqual([...hooks.keys()].sort(), ["before_agent_start", "session_shutdown", "session_start", "tool_result", "user_bash"]);
  const prompt = hooks.get("before_agent_start")!({ systemPrompt: "base" }) as { systemPrompt: string };
  assert.match(prompt.systemPrompt, /TOKEN/);
  assert.ok(!prompt.systemPrompt.includes("private-value"));
  await commands.get("fnox-list")!.handler("", ctx);
  assert.equal(notices.at(-1), "TOKEN");
  fail = true;
  await commands.get("fnox-reload")!.handler("", ctx);
  assert.match(notices.at(-1)!, /previous secrets remain loaded/);
  assert.ok(!JSON.stringify(notices).includes("provider-secret"));
  hooks.get("session_shutdown")!();
  assert.deepEqual(store.names(), []);
});

test("tool result redacts text, nested metadata and structured content; keeps output shape", async () => {
  const store = new SecretStore({}, async () => [{ name: "TOKEN", value: "private-value" }]);
  await store.reload(".");
  const { hooks } = harness({ exec: async () => ({ exitCode: 0 }) }, store);
  const event = {
    content: [{ type: "text", text: "private-value" }],
    details: { extra: "private-value" },
    structuredContent: { output: "private-value", exit_code: 0 },
  };
  const result = hooks.get("tool_result")!(event) as ToolResultEventResult;
  assert.ok(!JSON.stringify(result).includes("private-value"));
  assert.equal((result.structuredContent as { exit_code: number }).exit_code, 0);
  assert.equal(event.content[0].text, "private-value");
});

test("short secrets preserve Bash truncation schema and enum, but not arbitrary metadata keys", async () => {
  const store = new SecretStore({}, async () => [{ name: "TOKEN", value: "t" }]);
  await store.reload(".");
  const { hooks } = harness({ exec: async () => ({ exitCode: 0 }) }, store);
  const truncation = {
    content: "t", truncated: true, truncatedBy: "bytes", totalLines: 3000, totalBytes: 60000,
    outputLines: 2000, outputBytes: 50000, lastLinePartial: true, firstLineExceedsLimit: false,
    maxLines: 2000, maxBytes: 51200, misc: { t: "t" },
  };
  const result = hooks.get("tool_result")!({
    toolName: "bash", content: [], details: { truncation, aux: { truncated: "t" } },
  }) as ToolResultEventResult;
  const details = result.details as { truncation: typeof truncation; aux: Record<string, string> };
  for (const [key, value] of Object.entries(truncation)) {
    if (key !== "content" && key !== "misc") assert.equal(details.truncation[key as keyof typeof truncation], value);
  }
  assert.equal(details.truncation.content, "[REDACTED]");
  assert.ok(!JSON.stringify(details.truncation.misc).includes('"t"'));
  assert.ok(!Object.hasOwn(details.aux, "truncated"));
  assert.equal(truncation.content, "t");
  const invalid = hooks.get("tool_result")!({
    toolName: "bash", content: [], details: { truncation: { truncatedBy: "private-t" } },
  }) as ToolResultEventResult;
  assert.equal((invalid.details as { truncation: { truncatedBy: string } }).truncation.truncatedBy,
    "priva[REDACTED]e-[REDACTED]");
});

test("Bash stream and overflow file are scrubbed before accumulation; preserve native structured output", async () => {
  const secret = "sensitive-🔑-token";
  const store = new SecretStore({}, async () => [{ name: "TOKEN", value: secret }]);
  await store.reload(".");
  let seenEnv: NodeJS.ProcessEnv | undefined;
  const output = `${secret}\n`.repeat(120_000);
  const { tool } = harness({
    exec: async (_command, _cwd, options) => {
      seenEnv = options.env;
      const data = Buffer.from(output);
      for (let start = 0; start < data.length; start += 31) options.onData(data.subarray(start, start + 31));
      return { exitCode: 0 };
    },
  }, store);
  const updates: unknown[] = [];
  const result = await tool.execute("test", { command: "example", timeout: 5 }, undefined,
    update => updates.push(update), context);
  assert.equal(seenEnv?.TOKEN, secret);
  assert.equal(seenEnv?.PI_SESSION_ID, "current-session");
  assert.ok(!JSON.stringify(updates).includes(secret));
  assert.ok(!JSON.stringify(result).includes(secret));
  const structured = result.structuredContent as { output: string; exit_code: number; full_output_path?: string };
  assert.equal(structured.exit_code, 0);
  assert.ok(structured.output.includes("[REDACTED]"));
  assert.ok(structured.full_output_path);
  try {
    const saved = await readFile(structured.full_output_path, "utf8");
    assert.ok(saved.includes("[REDACTED]"));
    assert.ok(!saved.includes(secret));
  } finally { await rm(structured.full_output_path, { force: true }); }
});

test("user ! commands preserve env/timeout/abort and flush scrubbed output on errors", async () => {
  const store = new SecretStore({}, async () => [{ name: "TOKEN", value: "private-value" }]);
  await store.reload(".");
  const signal = new AbortController().signal;
  const { hooks } = harness({
    exec: async (_command, cwd, options) => {
      assert.equal(cwd, "/requested-cwd");
      assert.equal(options.env?.PI_SESSION_ID, "already-set");
      assert.equal(options.env?.TOKEN, "private-value");
      assert.equal(options.timeout, 9);
      assert.equal(options.signal, signal);
      options.onData(Buffer.from("prefix private-"));
      options.onData(Buffer.from("value tail"));
      throw new Error("timeout:9");
    },
  }, store);
  const { operations } = hooks.get("user_bash")!() as { operations: BashOperations };
  const chunks: Buffer[] = [];
  await assert.rejects(operations.exec("command", "/requested-cwd", {
    env: { PI_SESSION_ID: "already-set" }, signal, timeout: 9,
    onData: chunk => chunks.push(chunk),
  }), /timeout:9/);
  assert.equal(Buffer.concat(chunks).toString(), "prefix [REDACTED] tail");
});
