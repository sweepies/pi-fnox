/**
 * pi-fnox — fnox secrets injected into Pi.
 *
 * - Decrypts fnox vault at startup, injects into `process.env` so runline
 *   plugin env: fallbacks (and anything else reading process.env) work in-process.
 * - Injects same secrets into bash subprocess env (built-in tool + user !).
 * - Scrubs secret values from all tool output.
 * - Adds available secret names (grouped by provider) to the system prompt.
 * - Status bar line shows load summary.
 * - fs.watch on fnox.toml auto-reloads on edit (debounced).
 * - Commands: /fnox-list, /fnox-reload, /fnox-doctor, /fnox-providers,
 *             /fnox-get <name>, /fnox-profile [NAME].
 *
 * Config:
 *   FNOX_CONFIG  — path to fnox.toml (default: ~/.config/fnox/config.toml)
 *   FNOX_PROFILE — fnox profile to use (default: unset = top-level secrets)
 */

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	createBashTool,
	createLocalBashOperations,
} from "@mariozechner/pi-coding-agent";

interface SecretEntry {
	name: string;
	value: string;
	description: string;
	provider: string; // "age" | "onepass" | "plain" | unknown
	providerKey: string; // op://... | encrypted blob | ""
	sourceFile: string; // path to fnox.toml where defined
	hasValue: boolean;
}

type SecretMetadata = Omit<SecretEntry, "value" | "hasValue">;
type StatusCtx = {
	hasUI?: boolean;
	ui?: { setStatus?: (key: string, value: string) => void };
} | null;

const FNOX_CONFIG_PATH =
	process.env.FNOX_CONFIG ??
	`${process.env.HOME ?? "/root"}/.config/fnox/config.toml`;

let cachedSecrets: SecretEntry[] | null = null;
let activeProfile: string | undefined = process.env.FNOX_PROFILE || undefined;
let statusCtx: StatusCtx = null;

// ── Metadata-only load (no decryption) ────────────────────────
// Parses `fnox list -s` table output. Columns are whitespace-aligned;
// wrapped description lines (fewer fields) get appended to the previous row.
function parseFnoxList(output: string): Map<string, SecretMetadata> {
	const out = new Map<string, SecretMetadata>();
	const lines = output.split("\n");
	if (lines.length < 2) return out;
	let currentKey: string | null = null;
	let current: SecretMetadata | null = null;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;
		const parts = line.trim().split(/\s{2,}/);
		if (parts.length >= 5) {
			const key = parts[0];
			const type = parts[1];
			const sourceFile = parts[2];
			const providerKey = parts[3];
			const description = parts.slice(4).join(" ");
			const providerMatch = type.match(/provider\s*\(([^)]+)\)/);
			const provider = providerMatch
				? providerMatch[1]
				: type === "stored value"
					? "plain"
					: type;
			currentKey = key;
			current = { name: key, description, provider, providerKey, sourceFile };
			out.set(key, current);
		} else if (current && currentKey && parts.length > 0) {
			current.description += " " + parts.join(" ");
			out.set(currentKey, current);
		}
	}
	return out;
}

function loadMetadata(): Promise<Map<string, SecretMetadata>> {
	return new Promise((resolve) => {
		const args = ["-c", FNOX_CONFIG_PATH, "list", "-s", "--no-color", "--no-daemon"];
		if (activeProfile) args.push("-P", activeProfile);
		const proc = spawn("fnox", args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
		proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
		proc.on("error", (e) => {
			console.error(`[pi-fnox] failed to spawn fnox (list): ${e.message}`);
			resolve(new Map());
		});
		proc.on("close", (code) => {
			if (code !== 0) {
				console.error(`[pi-fnox] fnox list failed (${code}): ${err.slice(0, 200)}`);
				resolve(new Map());
				return;
			}
			resolve(parseFnoxList(out));
		});
	});
}

function loadValues(): Promise<Record<string, string>> {
	return new Promise((resolve) => {
		const args = ["-c", FNOX_CONFIG_PATH, "export", "-f", "json", "--no-daemon"];
		if (activeProfile) args.push("-P", activeProfile);
		const proc = spawn("fnox", args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
		proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
		proc.on("error", (e) => {
			console.error(`[pi-fnox] failed to spawn fnox: ${e.message}`);
			resolve({});
		});
		proc.on("close", (code) => {
			if (code !== 0) {
				console.error(`[pi-fnox] fnox export failed (${code}): ${err.slice(0, 200)}`);
				resolve({});
				return;
			}
			try {
				const data = JSON.parse(out);
				const r: Record<string, string> = {};
				for (const [name, value] of Object.entries(data.secrets ?? {})) {
					if (value !== null && value !== undefined) r[name] = String(value);
				}
				resolve(r);
			} catch (e) {
				console.error(`[pi-fnox] JSON parse failed: ${(e as Error).message}`);
				resolve({});
			}
		});
	});
}

async function loadSecrets(profile: string | undefined): Promise<SecretEntry[]> {
	const [meta, exported] = await Promise.all([loadMetadata(), loadValues()]);
	const result: SecretEntry[] = [];
	const allNames = new Set<string>([...meta.keys(), ...Object.keys(exported)]);
	for (const name of allNames) {
		const m = meta.get(name);
		const value = exported[name];
		result.push({
			name,
			value: value ?? "",
			description: m?.description ?? "",
			provider: m?.provider ?? "unknown",
			providerKey: m?.providerKey ?? "",
			sourceFile: m?.sourceFile ?? FNOX_CONFIG_PATH,
			hasValue: value !== undefined,
		});
	}
	result.sort((a, b) => a.name.localeCompare(b.name));
	return result;
}

function injectIntoEnv(target: Record<string, string>, secrets: SecretEntry[]): void {
	for (const s of secrets) {
		if (s.hasValue) target[s.name] = s.value;
	}
}

function scrubOutput(text: string, secrets: SecretEntry[]): string {
	if (secrets.length === 0) return text;
	let result = text;
	const sorted = [...secrets].sort((a, b) => b.value.length - a.value.length);
	for (const s of sorted) {
		if (!s.hasValue || s.value.length < 4) continue;
		result = result.split(s.value).join(`[REDACTED:${s.name}]`);
	}
	return result;
}

async function reload(): Promise<SecretEntry[]> {
	const secrets = await loadSecrets(activeProfile);
	cachedSecrets = secrets;
	injectIntoEnv(process.env as Record<string, string>, secrets);
	if (statusCtx) setStatusBar(statusCtx);
	return secrets;
}

// Debounced auto-reload: editors often emit several events per save
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleAutoReload(): void {
	if (reloadTimer) clearTimeout(reloadTimer);
	reloadTimer = setTimeout(async () => {
		reloadTimer = null;
		try {
			const n = (await reload()).length;
			console.error(`[pi-fnox] auto-reloaded ${n} secrets`);
		} catch (e) {
			console.error(`[pi-fnox] auto-reload failed: ${String(e)}`);
		}
	}, 300);
}

function groupByProvider(secrets: SecretEntry[]): Map<string, SecretEntry[]> {
	const by = new Map<string, SecretEntry[]>();
	for (const s of secrets) {
		if (!by.has(s.provider)) by.set(s.provider, []);
		by.get(s.provider)!.push(s);
	}
	return by;
}

function setStatusBar(ctx: StatusCtx): void {
	if (!ctx?.hasUI || !ctx.ui?.setStatus) return;
	const secrets = cachedSecrets ?? [];
	if (secrets.length === 0) {
		ctx.ui.setStatus("fnox", "🔐 fnox: 0");
		return;
	}
	const by = groupByProvider(secrets);
	const counts = Array.from(by.entries())
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([p, list]) => `${p}×${list.length}`)
		.join("+");
	const profileBit = activeProfile ? ` [${activeProfile}]` : "";
	ctx.ui.setStatus("fnox", `🔐 fnox: ${secrets.length}${profileBit} (${counts})`);
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const getSecrets = (): SecretEntry[] => cachedSecrets ?? [];
	const getSecret = (name: string): SecretEntry | undefined =>
		getSecrets().find((s) => s.name === name);

	// Initial load
	reload()
		.then((secrets) => {
			console.error(
				`[pi-fnox] loaded ${secrets.length} secrets from ${FNOX_CONFIG_PATH} (profile: ${activeProfile ?? "default"})`,
			);
		})
		.catch((e: unknown) => {
			console.error(`[pi-fnox] initial load failed: ${String(e)}`);
		});

	// Auto-reload on fnox.toml changes
	try {
		watch(FNOX_CONFIG_PATH, { persistent: false }, () => scheduleAutoReload());
	} catch (e) {
		console.error(`[pi-fnox] fs.watch failed on ${FNOX_CONFIG_PATH}: ${(e as Error).message}`);
	}

	// Scrub secret values from all tool results
	pi.on("tool_result", async (event) => {
		const secrets = getSecrets();
		if (secrets.length === 0) return;
		const content = event.content as Array<{ type: string; text?: string }>;
		const scrubbed = content.map((c) =>
			c.type === "text" && typeof c.text === "string"
				? { ...c, text: scrubOutput(c.text, secrets) }
				: c,
		);
		return { content: scrubbed };
	});

	// Override built-in bash to inject secrets as env vars
	const baseBash = createBashTool(cwd);
	pi.registerTool({
		...baseBash,
		description:
			baseBash.description +
			"\n\nSecrets from fnox vault are automatically injected as environment variables.",
		async execute(id, params, signal, onUpdate, ctx) {
			const secrets = getSecrets();
			const wrapped = createBashTool(cwd, {
				spawnHook: ({ command, cwd: spawnCwd, env }) => {
					const injectedEnv: Record<string, string> = {
						...(env ?? {}),
						...process.env,
					};
					injectIntoEnv(injectedEnv, secrets);
					return { command, cwd: spawnCwd, env: injectedEnv };
				},
			});
			return wrapped.execute(id, params, signal, onUpdate, ctx);
		},
	});

	// Inject secrets into user ! commands
	pi.on("user_bash", () => {
		const localOps = createLocalBashOperations();
		return {
			operations: {
				exec: async (command: string, execCwd: string, options: any) => {
					const secrets = getSecrets();
					const injectedEnv: Record<string, string> = {
						...(options?.env ?? {}),
						...process.env,
					};
					injectIntoEnv(injectedEnv, secrets);
					return localOps.exec(command, execCwd, { ...options, env: injectedEnv });
				},
			},
		};
	});

	// Grouped secret summary in system prompt
	pi.on("before_agent_start", async (event) => {
		const secrets = getSecrets();
		if (secrets.length === 0) return;
		const profileNote = activeProfile ? ` (profile: ${activeProfile})` : "";
		const by = groupByProvider(secrets);
		const grouped = Array.from(by.entries())
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([provider, list]) => {
				const items = list
					.map((s) => `  • ${s.name}${s.description ? ` — ${s.description}` : ""}`)
					.join("\n");
				return `${provider} (${list.length}):\n${items}`;
			})
			.join("\n");
		const instruction = [
			"\n## fnox — Secret Management",
			`Available secrets (injected as env vars in process.env + bash)${profileNote}, grouped by provider:\n${grouped}`,
			"Use $SECRET_NAME in bash commands to reference secrets. Never ask the user for secret values.",
			"Secret values are automatically scrubbed from command output.",
		].join("\n");
		return { systemPrompt: event.systemPrompt + instruction };
	});

	// Status bar at session start
	pi.on("session_start", async (_event, ctx) => {
		statusCtx = ctx as StatusCtx;
		setStatusBar(statusCtx);
	});

	// ── Commands ────────────────────────────────────────────────────

	pi.registerCommand("fnox-list", {
		description: "List fnox secrets with provider + description (never values)",
		handler: async (_args, ctx) => {
			const secrets = getSecrets();
			if (secrets.length === 0) {
				ctx.ui.notify("No fnox secrets loaded.", "info");
				return;
			}
			const profileNote = activeProfile ? ` (profile: ${activeProfile})` : "";
			const by = groupByProvider(secrets);
			const sections = Array.from(by.entries())
				.sort((a, b) => a[0].localeCompare(b[0]))
				.map(([provider, list]) => {
					const lines = list.map((s) =>
						`  • ${s.name}${s.description ? ` — ${s.description}` : ""}`,
					);
					return `${provider} (${list.length}):\n${lines.join("\n")}`;
				});
			ctx.ui.notify(`fnox secrets${profileNote}:\n${sections.join("\n\n")}`, "info");
			pi.sendMessage(
				{
					customType: "fnox-event",
					content: `User listed fnox secrets${profileNote}: ${secrets.map((s) => s.name).join(", ")}.`,
					display: true,
				},
				{ deliverAs: "nextTurn" },
			);
		},
	});

	pi.registerCommand("fnox-reload", {
		description: "Reload fnox secrets from disk",
		handler: async (_args, ctx) => {
			const n = (await reload()).length;
			ctx.ui.notify(`[pi-fnox] reloaded ${n} secrets`, "info");
		},
	});

	pi.registerCommand("fnox-doctor", {
		description: "Run fnox health diagnostics + extension summary",
		handler: async (_args, ctx) => {
			const doctorOut = await new Promise<string>((resolve) => {
				const args = ["-c", FNOX_CONFIG_PATH, "doctor", "--no-color"];
				if (activeProfile) args.push("-P", activeProfile);
				const proc = spawn("fnox", args, { stdio: ["ignore", "pipe", "pipe"] });
				let out = "";
				proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
				proc.stderr.on("data", (d: Buffer) => (out += d.toString()));
				proc.on("close", () => resolve(out));
				proc.on("error", () => resolve("[pi-fnox] failed to spawn fnox doctor"));
			});
			const secrets = getSecrets();
			const withValue = secrets.filter((s) => s.hasValue).length;
			const noValue = secrets.filter((s) => !s.hasValue).map((s) => s.name);
			const tail = `\n\n[pi-fnox] extension sees ${secrets.length} secrets (${withValue} decrypted${noValue.length ? `, ${noValue.length} unresolved: ${noValue.join(", ")}` : ""})`;
			ctx.ui.notify(doctorOut + tail, "info");
		},
	});

	pi.registerCommand("fnox-providers", {
		description: "Show per-provider summary (counts + sample provider-key)",
		handler: async (_args, ctx) => {
			const secrets = getSecrets();
			const by = groupByProvider(secrets);
			if (by.size === 0) {
				ctx.ui.notify("No providers configured.", "info");
				return;
			}
			const lines = Array.from(by.entries())
				.sort((a, b) => a[0].localeCompare(b[0]))
				.map(([provider, list]) => {
					const sample = (list[0]?.providerKey ?? "").slice(0, 50);
					const source = list[0]?.sourceFile ?? FNOX_CONFIG_PATH;
					return `  • ${provider} (${list.length} secrets)\n      source: ${source}\n      sample: ${sample}${sample.length === 50 ? "..." : ""}`;
				});
			ctx.ui.notify(`fnox providers:\n${lines.join("\n")}`, "info");
		},
	});

	pi.registerCommand("fnox-get", {
		description: "Show a fnox secret value masked. Usage: /fnox-get <NAME>",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				ctx.ui.notify("usage: /fnox-get <NAME>", "info");
				return;
			}
			const secret = getSecret(name);
			if (!secret) {
				ctx.ui.notify(`[pi-fnox] no secret named "${name}"`, "error");
				return;
			}
			if (!secret.hasValue) {
				ctx.ui.notify(
					`[pi-fnox] "${name}" found in metadata but no decrypted value (provider: ${secret.provider})`,
					"error",
				);
				return;
			}
			const v = secret.value;
			const masked =
				v.length <= 8
					? "•".repeat(v.length)
					: `${v.slice(0, 4)}…${v.slice(-4)} (len=${v.length})`;
			ctx.ui.notify(
				`${name} [${secret.provider}] ${secret.description ? `— ${secret.description}` : ""}\n  ${masked}\n\nTip: use 'echo $${name}' in bash for the full value.`,
				"info",
			);
		},
	});

	pi.registerCommand("fnox-profile", {
		description: "Show or switch fnox profile. Usage: /fnox-profile [NAME]",
		handler: async (args, ctx) => {
			const newProfile = args.trim();
			if (!newProfile) {
				ctx.ui.notify(
					`current profile: ${activeProfile ?? "(default)"}  —  config: ${FNOX_CONFIG_PATH}`,
					"info",
				);
				return;
			}
			activeProfile = newProfile;
			process.env.FNOX_PROFILE = newProfile;
			const n = (await reload()).length;
			ctx.ui.notify(`[pi-fnox] switched to profile '${newProfile}' (${n} secrets)`, "info");
		},
	});
}