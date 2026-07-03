/**
 * pi-fnox — fnox secrets injected into Pi.
 *
 * - Decrypts fnox vault at startup, injects into `process.env` so runline
 *   plugin env: fallbacks (and anything else reading process.env) work in-process.
 * - Injects same secrets into bash subprocess env (built-in tool + user !).
 * - Scrubs secret values from all tool output.
 * - Adds available secret names to the system prompt.
 * - Provides /fnox-list and /fnox-reload commands.
 *
 * Config:
 *   FNOX_CONFIG  — path to fnox.toml (default: ~/.config/fnox/config.toml)
 *   FNOX_PROFILE — fnox profile to use (default: unset = top-level secrets)
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	createBashTool,
	createLocalBashOperations,
} from "@mariozechner/pi-coding-agent";

interface SecretEntry {
	name: string;
	value: string;
}

const FNOX_CONFIG_PATH =
	process.env.FNOX_CONFIG ??
	`${process.env.HOME ?? "/root"}/.config/fnox/config.toml`;

let cachedSecrets: SecretEntry[] | null = null;
const activeProfile: string | undefined = process.env.FNOX_PROFILE || undefined;

async function loadSecrets(profile: string | undefined): Promise<SecretEntry[]> {
	return new Promise((resolve) => {
		const args = [
			"-c",
			FNOX_CONFIG_PATH,
			"export",
			"-f",
			"json",
			"--no-daemon",
		];
		if (profile) args.push("-P", profile);

		const proc = spawn("fnox", args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";

		proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
		proc.stderr.on("data", (d: Buffer) => (err += d.toString()));

		proc.on("error", (e) => {
			console.error(`[pi-fnox] failed to spawn fnox: ${e.message}`);
			resolve([]);
		});

		proc.on("close", (code) => {
			if (code !== 0) {
				console.error(
					`[pi-fnox] fnox export failed (${code}): ${err.slice(0, 200)}`,
				);
				resolve([]);
				return;
			}
			try {
				const data = JSON.parse(out);
				const secrets: SecretEntry[] = [];
				for (const [name, value] of Object.entries(data.secrets ?? {})) {
					if (value !== null && value !== undefined) {
						secrets.push({ name, value: String(value) });
					}
				}
				resolve(secrets);
			} catch (e) {
				console.error(`[pi-fnox] JSON parse failed: ${(e as Error).message}`);
				resolve([]);
			}
		});
	});
}

function injectIntoEnv(target: Record<string, string>, secrets: SecretEntry[]): void {
	for (const s of secrets) {
		target[s.name] = s.value;
	}
}

function scrubOutput(text: string, secrets: SecretEntry[]): string {
	if (secrets.length === 0) return text;
	let result = text;
	const sorted = [...secrets].sort((a, b) => b.value.length - a.value.length);
	for (const s of sorted) {
		if (s.value.length < 4) continue;
		result = result.split(s.value).join(`[REDACTED:${s.name}]`);
	}
	return result;
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const getSecrets = (): SecretEntry[] => cachedSecrets ?? [];

	// Load at startup and inject into process.env.
	// This is what makes runline plugins work in-process (they read process.env
	// via applyEnvOverrides at connection-resolution time).
	loadSecrets(activeProfile)
		.then((secrets) => {
			cachedSecrets = secrets;
			injectIntoEnv(process.env as Record<string, string>, secrets);
			console.error(
				`[pi-fnox] loaded ${secrets.length} secrets from ${FNOX_CONFIG_PATH} (profile: ${activeProfile ?? "default"})`,
			);
		})
		.catch((e: unknown) => {
			console.error(`[pi-fnox] initial load failed: ${String(e)}`);
		});

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

	// Override built-in bash to inject secrets as env vars into spawned subprocesses
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

	// Inject secrets into user ! commands too
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
					return localOps.exec(command, execCwd, {
						...options,
						env: injectedEnv,
					});
				},
			},
		};
	});

	// Inject secret names into system prompt so the LLM knows what's available
	pi.on("before_agent_start", async (event) => {
		const secrets = getSecrets();
		if (secrets.length === 0) return;
		const names = secrets.map((s) => s.name).join(", ");
		const profileNote = activeProfile ? ` (profile: ${activeProfile})` : "";
		const instruction = [
			"\n## fnox — Secret Management",
			`Available secrets (injected as env vars in process.env + bash)${profileNote}: ${names}`,
			"Use $SECRET_NAME in bash commands to reference secrets. Never ask the user for secret values.",
			"Secret values are automatically scrubbed from command output.",
		].join("\n");
		return { systemPrompt: event.systemPrompt + instruction };
	});

	// /fnox-list — show available secret names (never values)
	pi.registerCommand("fnox-list", {
		description: "Show fnox secrets (names only)",
		handler: async (_args, ctx) => {
			const secrets = getSecrets();
			if (secrets.length === 0) {
				ctx.ui.notify("No fnox secrets loaded.", "info");
				return;
			}
			const profileNote = activeProfile
				? ` (profile: ${activeProfile})`
				: "";
			const list = secrets.map((s) => `  • ${s.name}`).join("\n");
			ctx.ui.notify(`fnox secrets${profileNote}:\n${list}`, "info");
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

	// /fnox-reload — re-read fnox after fnox set/remove
	pi.registerCommand("fnox-reload", {
		description: "Reload fnox secrets from disk",
		handler: async (_args, ctx) => {
			cachedSecrets = null;
			const secrets = await loadSecrets(activeProfile);
			cachedSecrets = secrets;
			injectIntoEnv(process.env as Record<string, string>, secrets);
			ctx.ui.notify(`[pi-fnox] reloaded ${secrets.length} secrets`, "info");
		},
	});
}