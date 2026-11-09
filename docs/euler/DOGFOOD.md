# Building euler inside euler

Euler is ready to develop itself. The binary runs from this repo, shares `~/.pi/agent` with Pi,
and its bash tool executes here, so a session in `~/projects/euler` is a full dev environment.

Verified: boot in the repo (title `euler - euler`), `:q` exits cleanly, `--continue` resumes.

## The loop

```bash
cd ~/projects/euler
euler --dev                      # launcher shortcut, same supervisor
npm run dev                      # supervisor: source mode, reload on save
```

The supervisor runs euler straight from TypeScript — no build — and watches
`packages/coding-agent/src` and `packages/tui/src`. On save it restarts the process and resumes the
same session in about a second. `:q` stops both.

What "reload" means: **the process restarts**. The session lives on disk, so the conversation
survives; the editor buffer and any pending input are lost.

Reloads are **quiescent**: the app writes `{ busy }` to `/tmp/euler-dev-status.json` on turn and
compaction transitions, and the supervisor waits for the current turn to settle (plus a short grace)
before restarting. That matters when the agent itself edits `src/` — a naive watcher would kill the
turn doing the edit. If no status writer exists (an older app, or after a crash), automatic reloads
stay off and `touch /tmp/euler-reload` forces one. Override the paths with `EULER_DEV_STATUS` and
`EULER_DEV_RELOAD`.

```bash
npm run dev                                  # resume the most recent session for this directory
EULER_DEV_SESSION=euler-dev npm run dev      # pin one session id across reloads
npm run dev -- --session-dir /tmp/euler-dev  # pass extra args to euler
```

The watcher only decides *when* to restart; a restart re-reads everything, including extensions
under `~/.pi/agent` and `dist/` assets. It ignores `*.test.ts`, `dist/`, and `node_modules`, so
writing tests or docs does not interrupt you. If a reload produces a boot error, the supervisor
logs it once and waits for the next save instead of crash-looping.

You still need a build for the **built binary** (`bin/euler`), which is what you use outside the
dev loop:

```bash
npm run build:ui                 # tui + coding-agent only (UI work)
npm run build                    # everything (agent/tool/provider changes)
```

## Running the checks from inside

```bash
npm run euler:test               # 39 contract tests
npm --prefix packages/tui run test
npm run euler:gate               # upstream drift: SAFE / REVIEW / BLOCKED
```

Trials that should not pollute your session list:

```bash
./bin/euler --session-dir /tmp/euler-trial --approve
```

## Two things that will look like bugs but are not

**The repo's `AGENTS.md` applies to sessions started here.** It is upstream Pi's rulebook and it is
good (concise prose, erasable TypeScript, no `any`, ask before removing intentional code). One line
collides with euler on purpose:

> "Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to
> `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable."

Euler's `canonicalKey`/`SPECIAL_KEYS` in `modes/euler/keymap.ts` *does* name keys directly. That is
the design: the modal keymap table is euler's configuration surface, and routing transcript motions
through Pi's editor keybindings would make them configurable in the wrong place. Keep the keymap as
the single source; do not "fix" this into Pi's keybinding system.

**A broken rebuild cannot kill the session you are in,** but it can leave you without a working
euler to resume it. Keep the stock agent installed as a fallback:

```bash
pi --continue                    # stock Pi, same sessions, if euler's bundle is broken
```

Same for a wedged terminal: `pi --ui pi` is the escape hatch, and `reset` recovers a raw-mode tty.

## What dogfooding does not give you yet

- **Process-level reload, not in-place module reload.** A reload restarts the app; there is no
  state carried across it beyond the session on disk.
- No in-app restart command; the supervisor owns that. Adding one would need the app to re-exec
  itself, which conflicts with the terminal restore path.
- Editing the code that hosts you is fine, but the process in memory is the old code until you
  resume — do not debug a fix you have not rebuilt.
