# pi-fnox

A focused [fnox](https://fnox.jdx.dev) extension for [Pi](https://pi.dev). Loads a secret snapshot into `process.env` for in-process tools, including codemode, makes it available to Bash and user `!` commands, and redacts known values from tool results. Only secret **names** are added to the prompt.

Fork of [Bucurenciu-Cristian/pi-fnox](https://github.com/Bucurenciu-Cristian/pi-fnox), originally by Kicky. MIT licensed; original attribution retained.

## Install from Git

Requires Pi 1.0.4+ and `fnox` on `PATH`, with a working vault.

```sh
pi remove npm:@kickythrust/pi-fnox
pi install git:github.com/sweepies/pi-fnox
```

Restart Pi or `/reload`. This fork is Git-only, not published to npm.

- `FNOX_CONFIG`: explicit vault path; defaults to `~/.config/fnox/config.toml`. Project vaults are opt-in, never discovered automatically.
- `FNOX_PROFILE`: optional fnox profile.
- `/fnox-list`: loaded names only, no transcript message.
- `/fnox-reload`: refresh the snapshot after changing secrets.

Enable fnox's own daemon/cache if desired. The extension respects it rather than forcing `--no-daemon`; it does not start or configure the daemon. An export has a 30-second timeout and a 4 MiB output limit. Failed startup reports a warning and leaves tools usable without newly loaded secrets; failed refresh keeps the previous snapshot.

## Improvements over upstream

- Awaited startup: tools cannot race an unfinished secret load.
- One export per session or refresh, coalescing concurrent refreshes; no per-command vault calls.
- Atomic refresh, removed-secret cleanup, and restoration of inherited environment values on shutdown.
- Compiled, longest-first literal redaction, including short and rotated values; no repeated sorting per output.
- Bash and `!` output is scrubbed **before** streaming updates, truncation and overflow files, including secrets split across UTF-8 chunks.
- Text, structured tool output and string-valued metadata are scrubbed without dropping codemode's structured results.
- Native Pi Bash schemas, rendering, session metadata, timeout and cancellation retained; bounded exports and sanitized failure messages.
- No Runline-specific behavior, no new tools, no runtime dependencies beyond Pi and fnox.

## Boundaries

This is hygiene, not a security sandbox. Secrets intentionally live in Pi's process environment and can be read by in-process tools or inherited by subprocesses.

Redaction only covers exact known string values—not encodings, partial values, images, arbitrary files written by commands, or another tool's raw streaming updates. Do not print secrets. Very short secrets can make output noisy. Decrypted values are never deliberately written to disk by this extension; this is not a secure-memory guarantee.

## Development

```sh
mise install
mise run setup
mise run ci
```

Tests use a fake vault/CLI, exercise native Pi Bash and an isolated installed-Pi RPC process, and make no model requests or real vault reads. The installed-CLI test skips if Pi is unavailable.
