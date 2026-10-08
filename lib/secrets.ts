import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Redactor } from "./redaction.ts";

const exec = promisify(execFile);
export type Secret = { name: string; value: string };
export type LoadRequest = { cwd: string; config: string; profile?: string; signal: AbortSignal };
export type Loader = (request: LoadRequest) => Promise<Secret[]>;

export function parseExport(text: string): Secret[] {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error("fnox returned invalid JSON."); }
  if (!data || typeof data !== "object" || !("secrets" in data) ||
      !data.secrets || typeof data.secrets !== "object" || Array.isArray(data.secrets)) {
    throw new Error("fnox returned an invalid secret export.");
  }
  const secrets: Secret[] = [];
  for (const [name, value] of Object.entries(data.secrets)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || (value !== null && typeof value !== "string")) {
      throw new Error("fnox returned an invalid environment variable.");
    }
    if (value !== null) secrets.push({ name, value });
  }
  return secrets;
}

export const exportSecrets: Loader = async ({ cwd, config, profile, signal }) => {
  const args = ["--config", config];
  if (profile) args.push("--profile", profile);
  args.push("export", "--format", "json");
  let stdout: string;
  try {
    ({ stdout } = await exec("fnox", args, {
      cwd, signal, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8", windowsHide: true,
    }));
  } catch {
    // Child errors include stdout/stderr and sometimes decrypted values. Never forward them.
    throw new Error("fnox export failed or timed out; check fnox configuration and daemon.");
  }
  return parseExport(stdout);
};

/** Session-local snapshot; refreshes are single-flight and commit atomically. */
export class SecretStore {
  readonly redactor = new Redactor();
  private secrets: Secret[] = [];
  private previous = new Map<string, string | undefined>();
  private pending?: Promise<void>;
  private controller?: AbortController;

  private env: NodeJS.ProcessEnv;
  private loader: Loader;

  constructor(env: NodeJS.ProcessEnv, loader: Loader = exportSecrets) {
    this.env = env;
    this.loader = loader;
  }

  names(): string[] { return this.secrets.map(secret => secret.name).sort(); }
  environment(): Record<string, string> {
    return Object.fromEntries(this.secrets.map(({ name, value }) => [name, value]));
  }

  reload(cwd: string): Promise<void> {
    if (this.pending) return this.pending;
    const controller = new AbortController();
    this.controller = controller;
    const request: LoadRequest = {
      cwd,
      config: this.env.FNOX_CONFIG || join(homedir(), ".config", "fnox", "config.toml"),
      profile: this.env.FNOX_PROFILE || undefined,
      signal: controller.signal,
    };
    const pending = this.loader(request).then(secrets => {
      if (controller.signal.aborted) throw new Error("fnox load cancelled.");
      this.redactor.add(secrets.map(secret => secret.value));
      this.restoreEnvironment();
      for (const { name, value } of secrets) {
        this.previous.set(name, this.env[name]);
        this.env[name] = value;
      }
      this.secrets = secrets;
    }).finally(() => {
      if (this.pending === pending) this.pending = undefined;
      if (this.controller === controller) this.controller = undefined;
    });
    this.pending = pending;
    return pending;
  }

  clear(): void {
    this.controller?.abort();
    this.controller = undefined;
    this.pending = undefined;
    this.restoreEnvironment();
    this.secrets = [];
  }

  private restoreEnvironment(): void {
    for (const { name, value } of this.secrets) {
      // Don't clobber an environment change made by another extension after our injection.
      if (this.env[name] !== value) continue;
      const previous = this.previous.get(name);
      if (previous === undefined) delete this.env[name];
      else this.env[name] = previous;
    }
    this.previous.clear();
  }
}
