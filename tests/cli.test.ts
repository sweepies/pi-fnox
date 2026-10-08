import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { exportSecrets } from "../lib/secrets.ts";

const exec = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/fnox.mjs", import.meta.url));
const extension = fileURLToPath(new URL("../extensions/index.ts", import.meta.url));

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "pi-fnox-"));
  await chmod(fixture, 0o755);
  await symlink(fixture, join(dir, "fnox"));
  return { dir, path: `${dir}${delimiter}${process.env.PATH}` };
}

test("real subprocess loader uses daemon-compatible args and never forwards child secrets/errors", async () => {
  const { dir, path } = await setup();
  const previous = process.env.PATH;
  process.env.PATH = path;
  try {
    const request = { cwd: dir, config: "/config with spaces/vault.toml", signal: new AbortController().signal };
    const secrets = await exportSecrets(request);
    assert.deepEqual(secrets, [{ name: "FNOX_TEST_TOKEN", value: "fixture-secret-token" }]);
    for (const profile of ["fail", "overflow"]) {
      await assert.rejects(exportSecrets({ ...request, profile }), error => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes("fixture-secret-token"));
        return true;
      });
    }
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(exportSecrets({ ...request, signal: controller.signal }));
  } finally {
    process.env.PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("installed Pi loads Git-style extension and awaits injection before user Bash (no model/vault calls)", { timeout: 20_000 }, async t => {
  try { await exec("pi", ["--no-extensions", "--version"]); }
  catch { t.skip("Pi CLI unavailable; SDK integration remains covered"); return; }
  const { dir, path } = await setup();
  const agent = join(dir, "agent");
  await mkdir(agent);
  await writeFile(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-6.1-sol" }));
  const log = join(dir, "calls.jsonl");
  const child = spawn("pi", ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", extension,
    "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp", "--offline"], {
    cwd: dir,
    env: { ...process.env, PATH: path, PI_CODING_AGENT_DIR: agent,
      FNOX_CONFIG: "/config with spaces/vault.toml", FNOX_PROFILE: "work", FNOX_TEST_LOG: log },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Pi RPC timeout: ${err}`)); }, 15_000);
      child.on("error", reject);
      child.stderr.on("data", data => { err += data.toString(); });
      child.stdout.on("data", data => {
        out += data.toString();
        if (out.includes('"id":"bash-test"') && out.includes('"type":"response"')) child.stdin.end();
      });
      child.on("close", code => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Pi exited ${code}: ${err}`));
      });
      child.stdin.write(`${JSON.stringify({ id: "bash-test", type: "bash", command: 'printf "%s" "$FNOX_TEST_TOKEN"' })}\n`);
    });
    assert.ok(!out.includes("fixture-secret-token"));
    const records = out.trim().split("\n").map(line => JSON.parse(line));
    const response = records.find(record => record.type === "response" && record.id === "bash-test");
    assert.equal(response?.success, true, err);
    assert.equal(response.data.output, "[REDACTED]");
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(calls, [["--config", "/config with spaces/vault.toml", "--profile", "work", "export", "--format", "json"]]);
  } finally {
    child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});
