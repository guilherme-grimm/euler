# Building euler inside euler

Euler is ready to develop itself. The binary runs from this repo, shares `~/.pi/agent` with Pi,
and its bash tool executes here, so a session in `~/projects/euler` is a full dev environment.

Verified: boot in the repo (title `euler - euler`), `:q` exits cleanly, `--continue` resumes.

## The loop

```bash
cd ~/projects/euler
./bin/euler                      # or: euler, if ~/.local/bin/euler points at bin/euler
```

Inside that session you have the usual tools (`read`, `edit`, `bash`, tests). When you change the
UI, the running process keeps the bundle it booted with — rebuild and resume:

```bash
# in a tool shell, or a second terminal
npm run build:ui                 # tui + coding-agent only (what UI work needs)
```

then `:q` and:

```bash
euler --continue                 # same conversation, new bundle
```

`npm run dev` does both in one step from outside the running session (`build:ui` + `--continue`).
For non-UI work (agent, tools, providers) use the full `npm run build`.

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

- No hot reload. Every UI change costs a rebuild and a session resume.
- No in-app "restart" command; `:q` + `--continue` is the loop. A restart key would need a wrapper
  process, which is a deliberate non-goal for now.
- Editing the code that hosts you is fine, but the process in memory is the old code until you
  resume — do not debug a fix you have not rebuilt.
