# pi-fnox

A [pi](https://github.com/badlogic/pi) extension for [fnox](https://github.com/jdx/fnox) — automatic secret injection and scrubbing for AI agents.

## What it does

- **Injects** fnox vault secrets into **`process.env`** at startup — so anything reading env vars in-process (runline plugin `env:` fallbacks, custom scripts, etc.) finds them. This is the main reason this extension exists.
- **Injects** the same secrets into **bash subprocesses** spawned by Pi's built-in tool and user `!` commands.
- **Scrubs** secret values from all tool output — bash, read, grep, everything the LLM sees — as a safety net.
- **Tells** the LLM which secrets are available via the system prompt (names only, never values).

```
You: "deploy using the stripe key"

Agent runs: env | grep STRIPE_SECRET_KEY
            → STRIPE_SECRET_KEY=sk_live_…
Agent sees: STRIPE_SECRET_KEY=[REDACTED:STRIPE_SECRET_KEY]
```

The agent orchestrates. **fnox** holds the secrets (age-encrypted at rest in `~/.config/fnox/config.toml`). The values never touch the context window.

## Install

```bash
# Requires fnox on PATH
#   mise use -g fnox      # OR: brew install fnox, scoop install fnox, etc.

# Install the extension
pi install npm:@kickythrust/pi-fnox
```

Restart Pi. You should see `[pi-fnox] loaded N secrets from …` in stderr.

## Setup

```bash
# Initialize fnox and add secrets (fnox's age provider is what we expect)
fnox init
fnox set STRIPE_KEY
fnox set DATABASE_URL

# Start pi — secrets automatically injected into every bash + process.env
pi
```

To scope to a subset of secrets, filter by fnox profile (the extension honors `FNOX_PROFILE`).

## Commands

| Command | Description |
| --- | --- |
| `/fnox-list` | Show loaded secret names (never values) |
| `/fnox-reload` | Re-read fnox from disk (use after `fnox set` / `fnox remove`) |

## Config (env vars)

| Env var | Default | Effect |
| --- | --- | --- |
| `FNOX_CONFIG` | `~/.config/fnox/config.toml` | Path to the fnox.toml to load from |
| `FNOX_PROFILE` | _unset_ | fnox profile name to select (e.g. `prod`, `staging`) |

## Why this exists

**Runline's plugin loader resolves connection config via `applyEnvOverrides`, which reads `process.env`** at connection-resolution time. Plugins whose schema fields declare `env: "FOO_TOKEN"` (github, cloudflareAccess, supabase, bugsink, etc.) need the parent Pi process to have the env loaded *before* `Runline.fromProject()` runs. Without this extension, those secrets would only reach bash subprocesses, leaving runline's in-process sandbox unauthenticated.

This extension hydrates `process.env` at Pi startup so runline plugins (and any other in-process tool) see the same env that bash subprocesses do.

## How it works

1. On startup, the extension runs `fnox -c ~/.config/fnox/config.toml export -f json` and decrypts the result with the local age key.
2. Secrets are merged into `process.env`.
3. The same secrets are injected into every bash invocation via `spawnHook` (built-in tool) and `user_bash` exec (user `!` commands).
4. After any tool completes, `tool_result` scrubs any leaked secret value out of the returned text.
5. `before_agent_start` adds the list of loaded secret names to the system prompt so the LLM knows to use `$SECRET_NAME` in bash.

## Why fnox

- **No biometric prompt.** fnox decrypts locally with age — sub-100ms, no UI prompts, no human in the loop.
- **Committed to git.** fnox.toml stores only age-encrypted blobs. Audit-friendly, review-friendly, reproducible.
- **One tool.** fnox is the secret bus.

## License

MIT