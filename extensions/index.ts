import {
  createBashToolDefinition,
  createLocalBashOperations,
  type BashOperations,
  type ExtensionAPI,
  type ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { SecretStore } from "../lib/secrets.ts";

const BASH_OUTPUT_KEYS = new Set(["output", "truncated", "full_output_path", "exit_code", "wall_time_seconds"]);
const BASH_DETAIL_KEYS = new Set(["truncation", "fullOutputPath"]);
const BASH_TRUNCATION_KEYS = new Set([
  "content", "truncated", "truncatedBy", "totalLines", "totalBytes", "outputLines", "outputBytes",
  "lastLinePartial", "firstLineExceedsLimit", "maxLines", "maxBytes",
]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export function install(pi: ExtensionAPI, store: SecretStore, local: BashOperations): void {
  const redactDetails = (details: unknown, bash: boolean): unknown => {
    const masked = store.redactor.value(details, bash ? BASH_DETAIL_KEYS : undefined);
    if (!bash || !isRecord(details) || !isRecord(details.truncation) || !isRecord(masked)) return masked;
    const truncation = store.redactor.value(details.truncation, BASH_TRUNCATION_KEYS);
    // Keep the SDK enum, not arbitrary string metadata; content and unknown keys still get masked.
    const limit = details.truncation.truncatedBy;
    if (limit === "lines" || limit === "bytes" || limit === null) truncation.truncatedBy = limit;
    return { ...masked, truncation };
  };
  const redact = <T extends ToolResultEventResult>(result: T, bash = false): T => ({
    ...result,
    content: result.content && store.redactor.content(result.content),
    details: redactDetails(result.details, bash),
    structuredContent: store.redactor.value(result.structuredContent, bash ? BASH_OUTPUT_KEYS : undefined),
  });
  const operations: BashOperations = {
    async exec(command, cwd, options) {
      const stream = store.redactor.stream(options.onData);
      try {
        return await local.exec(command, cwd, {
          ...options,
          env: { ...(options.env ?? process.env), ...store.environment() },
          onData: data => stream.write(data),
        });
      } catch (error) {
        throw new Error(store.redactor.text(error instanceof Error ? error.message : "Bash execution failed."));
      } finally {
        // Flush even on cancellation/timeout; only scrubbed bytes reach Pi's accumulator.
        stream.end();
      }
    },
  };

  // Keep Pi's schema, structured output, rendering, session metadata, timeout and cancellation.
  const bash = createBashToolDefinition(process.cwd(), { operations });
  pi.registerTool({
    ...bash,
    description: `${bash.description}\n\nfnox secrets are available as environment variables; output is redacted.`,
    async execute(id, params, signal, onUpdate, ctx) {
      try {
        const result = await bash.execute(id, params, signal, onUpdate, ctx);
        return redact(result, true);
      } catch (error) {
        throw new Error(store.redactor.text(error instanceof Error ? error.message : "Bash execution failed."));
      }
    },
  });

  pi.on("user_bash", () => ({ operations }));
  pi.on("tool_result", event => redact({
    content: event.content, details: event.details, structuredContent: event.structuredContent,
  }, event.toolName === "bash"));
  pi.on("session_start", async (_event, ctx) => {
    try { await store.reload(ctx.cwd); }
    catch { ctx.ui.notify("fnox could not load secrets. Check fnox, then use /fnox-reload.", "warning"); }
  });
  pi.on("session_shutdown", () => store.clear());
  pi.on("before_agent_start", event => {
    const names = store.names();
    if (!names.length) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n## fnox\nSecret environment variables: ${names.join(", ")}.\nUse $NAME in Bash; values are also available in process.env. Never print secrets or ask for their values. Exact known values are redacted from tool results.`,
    };
  });
  pi.registerCommand("fnox-list", {
    description: "List loaded fnox secret names (never values)",
    handler: async (_args, ctx) => {
      const names = store.names();
      ctx.ui.notify(names.length ? names.join(", ") : "No fnox secrets loaded.", "info");
    },
  });
  pi.registerCommand("fnox-reload", {
    description: "Refresh fnox secrets atomically",
    handler: async (_args, ctx) => {
      try {
        await store.reload(ctx.cwd);
        ctx.ui.notify(`fnox: loaded ${store.names().length} secrets.`, "info");
      } catch {
        ctx.ui.notify("fnox refresh failed; previous secrets remain loaded. Check fnox configuration and daemon.", "warning");
      }
    },
  });
}

export default function (pi: ExtensionAPI): void {
  install(pi, new SecretStore(process.env), createLocalBashOperations());
}
