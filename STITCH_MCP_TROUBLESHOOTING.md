# Stitch MCP — Troubleshooting Runbook

This documents everything hit while getting Google Stitch (AI UI design tool) working from Claude Code in this repo, and the exact fix for each. Read this before re-diagnosing from scratch.

## Quick diagnosis

| Symptom | Cause | Fix |
|---|---|---|
| `claude mcp get stitch` shows `Status: ! Connected · tools fetch failed`, error mentions `$defs`/`$ref`/`ScreenInstance` | Upstream bug — see [Issue 1](#issue-1-official-stitch-mcp-server-schema-bug) | Use the community proxy instead (see [Working config](#working-config)) |
| Tool search / `mcp__stitch__*` tools don't appear even though `claude mcp get stitch` says `Connected` | MCP servers only load at session start — see [Issue 2](#issue-2-mid-session-registration-doesnt-load-tools) | Start a new session, **or** skip the MCP tool-call layer entirely and drive the CLI directly (see [Direct-CLI method](#direct-cli-method-no-session-restart-needed)) |
| `npx @_davideast/stitch-mcp ...` fails with `npm warn cleanup` / `EPERM` / empty output | Windows npx temp-cache corruption — see [Issue 3](#issue-3-windows-npx-cache-corruption) | Install globally instead: `npm install -g @_davideast/stitch-mcp`, invoke `stitch-mcp` directly |
| Node script calling `execFileSync("stitch-mcp", ...)` fails with `ENOENT` | `execFileSync` doesn't resolve Windows `.cmd` npm shims — see [Issue 4](#issue-4-execfilesync-enoent-on-windows) | Pass `{ shell: true }` |
| With `shell: true`, `-d '<json>'` fails with `Expected property name or '}' in JSON` | `cmd.exe` mangles quoting on inline JSON args — see [Issue 5](#issue-5-cmdexe-mangles-inline-json) | Write the JSON to a temp file, pass `-f <file>` instead of `-d` |
| A `generate_screen_from_text` call fails with `Request contains an invalid argument` | Seen only on the first few calls right after creating a fresh design system — transient, not a prompt-content problem | Just retry (2–3 attempts) — every later call in the same project succeeds |

---

## Background

Google Stitch's real endpoint is `https://stitch.googleapis.com/mcp` (confirmed official — Google's own docs live at `stitch.withgoogle.com/docs/mcp/setup`). The API key lives in this repo's `.env.local` as `GOOGLE_STITCH_API_KEY`; the Stitch tooling itself expects it as the `STITCH_API_KEY` env var.

### Issue 1: Official Stitch MCP server schema bug

Connecting directly to `stitch.googleapis.com/mcp` (`claude mcp add stitch --transport http --header "X-Goog-Api-Key: $KEY" https://stitch.googleapis.com/mcp`) authenticates fine but tool listing fails:

```
Status: ! Connected · tools fetch failed
Issue: can't resolve reference #/$defs/ScreenInstance from id #
```

This is a real upstream bug, not a config mistake — Stitch's server emits tool schemas using `$defs`/`$ref`, and Claude Code's AJV-based schema resolver doesn't pre-register `$defs` before resolving `$ref`s, so it throws `MissingRefError`. Confirmed still present as of Claude Code 2.1.232 (latest at the time this was found). Documented independently:
- Google AI Developers Forum: "[Bug] MCP Server - Invalid JSON schema reference #/$defs/ScreenInstance" — https://discuss.ai.google.dev/t/bug-mcp-server-invalid-json-schema-reference-defs-screeninstance/144751
- opencode issue #26260: "MCP: failed to get tools from Stitch - can't resolve reference #/$defs/ScreenInstance"

**Do not keep re-trying the direct HTTP connection** — it won't start working until Google or Anthropic ships a fix on one side.

### Working config

Use the community proxy `davideast/stitch-mcp` (954★, Apache-2.0, maintained by a Google/Firebase developer advocate) instead. It wraps Google's own official `@google/stitch-sdk` npm package and only ever talks to `stitch.googleapis.com` — reviewed the source before trusting it with the API key (`src/services/stitch/connection.ts`, `src/commands/proxy/handler.ts`). It evidently normalizes the schema before handing tools to the MCP client.

```bash
npm install -g @_davideast/stitch-mcp    # see Issue 3 for why global install, not npx
claude mcp remove stitch -s local        # if the broken direct-HTTP entry exists
claude mcp add stitch -e STITCH_API_KEY=<key-from-.env.local> -- stitch-mcp proxy
claude mcp get stitch                    # should show Status: ✔ Connected, Type: stdio
```

### Issue 2: Mid-session registration doesn't load tools

Even with the above correctly configured and `claude mcp get stitch` reporting `Connected`, a session that was **already running** when `claude mcp add` was executed will not see `mcp__stitch__*` tools via tool search. MCP servers are wired into a session's tool registry once, at process startup — there is no tool exposed to the agent that can force a live re-scan. `claude mcp get`/`list` spin up their own fresh connection check from the CLI process, which is a different thing from the running conversation's tool registry, so they'll happily report "Connected" while the conversation still can't see the tools.

**Fix A**: start a new Claude Code session (or use this VS Code extension's own MCP reconnect UI/`/mcp` command if it has one) — the server will connect automatically on startup, no re-setup needed since the config is already correct.

**Fix B (no restart needed)**: skip the MCP tool-call layer entirely — see below.

### Direct-CLI method (no session restart needed)

`stitch-mcp` is a full CLI, not just an MCP proxy. Its `tool` subcommand invokes Stitch's real API tools directly from the shell, completely bypassing the need for the tools to be registered in Claude Code's session:

```bash
# List every available tool + its full JSON schema
STITCH_API_KEY=<key> stitch-mcp tool -f - -o json    # or just: stitch-mcp tool

# Invoke one tool
STITCH_API_KEY=<key> stitch-mcp tool <toolName> -f <request.json> -o json
```

Useful tools discovered this way (there are more — run `stitch-mcp tool` with no name to list everything):

| Tool | Purpose |
|---|---|
| `create_project` | Create a Stitch project (container for screens). Returns `name: "projects/{id}"`. |
| `upload_design_md` | Upload an existing `DESIGN.md` (base64) to a project. Returns `{id, sourceScreen}`. |
| `create_design_system_from_design_md` | Turn the uploaded DESIGN.md into a design system asset, using the `{id, sourceScreen}` from above as `selectedScreenInstance`. Returns `{assetId}`. |
| `generate_screen_from_text` | Generate a screen from a text prompt. Pass `designSystem: "assets/<assetId>"` for visual consistency. Response includes `htmlCode.downloadUrl` and `screenshot.downloadUrl` directly — no separate `get_screen_code`/`get_screen_image` call needed. |
| `list_screens` / `get_screen` | Look up screens already in a project. |

This repo's actual generation pipeline (used to populate `stitch_comprehensive_sis_portal_ecosystem/`) was: `create_project` → `upload_design_md` (fed the existing `academic_nexus/DESIGN.md`) → `create_design_system_from_design_md` → loop `generate_screen_from_text` per screen → download both URLs from each response with `curl`/`fetch`.

### Issue 3: Windows npx cache corruption

`npx -y @_davideast/stitch-mcp ...` intermittently fails with `npm warn cleanup ... EPERM: operation not permitted, rmdir ...` against `%LOCALAPPDATA%\npm-cache\_npx\...`, leaving a half-deleted package (missing `package.json`, missing `dist/`) that then fails silently on the next invocation. This is a Windows file-locking quirk in npx's post-run temp-directory cleanup, not anything wrong with the package. Repeated invocations make it worse (each run corrupts the cache further).

**Fix**: `npm install -g @_davideast/stitch-mcp` once, then invoke the installed `stitch-mcp` binary directly (found at `%APPDATA%\npm\stitch-mcp`) instead of going through `npx` at all.

### Issue 4: execFileSync ENOENT on Windows

Node's `child_process.execFileSync("stitch-mcp", [...])` fails with `spawnSync stitch-mcp ENOENT` even though `stitch-mcp` works fine from an interactive shell. On Windows, global npm binaries are `.cmd` shim files; `execFileSync` without `shell: true` doesn't go through the shell's PATH/extension resolution that makes `.cmd` files runnable, so it can't find the executable.

**Fix**: add `shell: true` to the `execFileSync` options.

### Issue 5: cmd.exe mangles inline JSON

Once `shell: true` is set (Issue 4's fix), passing a JSON payload inline via `-d '<json>'` breaks: the child process receives a mangled string and `stitch-mcp` fails with `Error: Expected property name or '}' in JSON at position 1`. `shell: true` on Windows routes the command through `cmd.exe`, whose argument-quoting rules for embedded double quotes are different from POSIX shells, and Node's automatic quoting for a `shell: true` + args-array call doesn't handle a large JSON string cleanly through that layer.

**Fix**: write the JSON payload to a temp file first, then invoke with the CLI's `-f, --data-file <path>` flag instead of `-d`. This avoids shell quoting entirely — the only remaining command-line argument is a plain file path.

```js
const reqFile = path.join(__dirname, `_req_${i}.json`);
fs.writeFileSync(reqFile, JSON.stringify(data));
execFileSync("stitch-mcp", ["tool", name, "-f", reqFile, "-o", "json"], {
  env: { ...process.env, STITCH_API_KEY: apiKey },
  shell: true,
  timeout: 9 * 60 * 1000, // generation can legitimately take a few minutes
});
fs.rmSync(reqFile, { force: true });
```

---

## Full working recipe (copy-paste starting point)

```bash
# One-time setup
npm install -g @_davideast/stitch-mcp
claude mcp remove stitch -s local 2>/dev/null
claude mcp add stitch -e STITCH_API_KEY=<key-from-.env.local GOOGLE_STITCH_API_KEY> -- stitch-mcp proxy

# Verify (should say Connected)
claude mcp get stitch

# If tools still don't show up in THIS conversation, either start a new
# session, or drive the CLI directly (see "Direct-CLI method" above) — no
# restart required for that path.
```
