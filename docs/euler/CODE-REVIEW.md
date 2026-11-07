# euler — code review and handoff

State as of `d7c5094` (2026-11-07). Everything below was produced from a read-only scan: file
reads, typecheck, lint, test runs, and the upstream gate. Nothing was changed while reviewing.

## What exists today

A fork of `earendil-works/pi` adding a modal, vim-flavoured interaction layer. Drop-in with
`~/.pi/agent` (sessions, auth, models, skills, extensions, MCP, codemode). Fullscreen only.

| piece | path | lines |
|---|---|---|
| key table: dispatch + which-key + cheatsheet | `packages/coding-agent/src/modes/euler/keymap.ts` | 240 |
| modal engine, actions, overlays | `packages/coding-agent/src/modes/euler/euler-mode.ts` | 858 |
| motions (cell-aware, lazy row stripping) | `packages/coding-agent/src/modes/euler/motions.ts` | 360 |
| thread rail | `packages/coding-agent/src/modes/euler/euler-sidebar.ts` | 321 |
| statusline (lualine-style) | `packages/coding-agent/src/modes/euler/euler-status.ts` | 86 |
| pi-tui seam (keyboard cursor/selection) | `packages/tui/src/tui-alt-screen.ts` | +134 |
| pi-tui seam (renderer options, exports) | `packages/tui/src/index.ts`, `tui-renderer.ts` | +24 |
| host wiring + rail layout | `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | +385 |
| entry points | `cli.ts`, `cli/args.ts`, `main.ts`, `package.json` | +33 |
| update gate | `tools/euler/{seams.json,upstream-gate.mjs}`, `.github/workflows/euler-upstream.yml` | 249 |

Total fork diff vs upstream: **28 files, ~3.9k insertions, 15 deletions** (9 new files).
Run: `bin/euler` (bun when available, `EULER_RUNTIME=node` to force) or `pi --ui euler`.

### Behaviour worth knowing before changing anything

- Keys are decoded with `decodePrintableKey` and **releases are dropped first** (`isKeyRelease`).
  Input listeners run before pi's own release filter; without this, every binding fired twice.
- The layer **yields whenever a component other than the editor has focus** (`hasForeignFocus`),
  because pi selectors live in the editor dock, not in overlays.
- `Esc` in insert → normal; in normal it clears pending/count, and only reaches pi's abort when a
  turn is streaming.
- Unread = *seen and changed since*, inside a one-week window. Never-opened threads are plain.
- The rail's default view is the last week; `/` searches all history.
- Forks use `AgentSessionRuntime.fork(entryId, { position })`: new session file, `parentSession`
  link, full branch including compaction.

## Verification

| check | result |
|---|---|
| `npm run build` (all packages) | pass |
| `tsc --noEmit` via pre-commit | pass |
| biome (`node scripts/biome-check.mjs`) | clean, 0 warnings |
| `packages/tui` suite (`node --test`) | **1134 tests, 1132 pass, 0 fail, 2 skipped** |
| euler suites (`npm run euler:test`) | **38 pass** (mode 24, motions 6, sidebar 10 — approx. split) |
| `npm run euler:gate --no-fetch` | `SAFE`, 0 commits behind |
| `packages/coding-agent` full vitest suite | **not finished** — the run was cut off with no summary, so this is the one unverified gate. Command: `cd packages/coding-agent && npx vitest run` |

## Findings

### P1 — correctness / leaks

1. **Stale cheatsheet listener survives `dispose()`.**
   `euler-mode.ts:131` (`dispose`) hides overlays but does not remove the one-shot listener added
   at `euler-mode.ts:847`. After a mode switch or shutdown, that listener is still registered and
   holds `this`. It consumes exactly one future key, whichever comes first.
   *Fix:* keep the listener in a field (`this.overlayListener`), remove it in `closeOverlay()` and
   `dispose()`; `showHelp`/`openSearch` set it.

2. **Rail width is frozen at boot.** `interactive-mode.ts:7368` passes `basis: width` computed once
   in `buildEulerRoot` from the terminal width at init. Resize the terminal and the rail keeps the
   old width, wasting or starving columns.
   *Fix:* `basis: "auto", minSize: 24, maxSize: 40` and let the sidebar render lines of exactly
   `clamp(terminalWidth * 0.28, 26, 38)` cells; `HStack` then allocates the intrinsic width and it
   tracks resizes for free.

3. **Verification gap:** the coding-agent suite never completed in this session (see table). It is
   the only signal that the `interactive-mode.ts` / `chat-viewport.ts` seams did not regress
   upstream behaviour.

### P2 — performance and clarity

4. **The rail sorts twice per frame.** `euler-sidebar.ts:259-260` calls `rows()` (which calls
   `allRows()` → `orderThreads`) and then `allRows()` again for the hidden count. `render()` runs
   on every streamed token while the rail is open; with 126 threads that is two `O(n log n)` walks
   plus two subtree recursions per frame.
   *Fix:* compute `all` once in `render` and derive the visible subset from it; optionally memoise
   `orderThreads` keyed by the `snapshot.threads` array reference and current path.

5. **Two `EulerModeName` types.** `keymap.ts:10` defines `"normal" | "visual" | "insert" |
   "search"` (no `"command"`), `euler-status.ts:12` defines the real one including `"command"`.
   The keymap copy is not used by the engine. *Fix:* delete the keymap copy, import the status one
   (or move the type to `keymap.ts` and re-export from status).

6. **Two one-week constants.** `interactive-mode.ts:289` (`EULER_UNREAD_WINDOW_MS`) and
   `euler-sidebar.ts:58` (`RECENT_WINDOW_MS`) encode the same policy. Changing one silently
   desynchronises "unread" from "visible in the rail". *Fix:* keep `RECENT_WINDOW_MS` in the
   sidebar module and import it in the host.

7. **`"<current>"` sentinel duplicated as a bare string** (`interactive-mode.ts:7486` and `:7529`).
   Typo-prone. *Fix:* export `CURRENT_THREAD_KEY` from `euler-sidebar.ts` and use it in both spots.

8. **`MODE_FG` is a dead abstraction** (`euler-status.ts:45`): every entry maps to `"text"`.
   *Fix:* delete the map, hardcode `"text"`.

9. **Four `getViewportSnapshot()` calls per keystroke** — `doc()` (`:158`), `viewport()` (`:165`),
   `syncCursor()` (`:351`), `statusData()` (`:139`). Each is cheap (returns references) but the
   repetition makes it hard to reason about how many times the layout is read. *Fix:* take one
   snapshot per input event and pass it down, or memoise for the duration of a handler.

10. **`runAction`'s doc-free guard is a growing boolean chain** (`euler-mode.ts:397`): `action !==
    "help" && action !== "sessions" && ...`. Every new host action must remember to extend it.
    *Fix:* `const DOC_FREE = new Set<EulerAction>(["help", "sessions", "tree", "sidebar",
    "focusSidebar", "focusTranscript", "insert", "command"])` and check membership.

### P3 — hygiene

11. **Unused exports:** `GROUP_TITLES` (`keymap.ts:73`, internal only) and `KeymapMatch`
    (`keymap.ts:185`, no external use). Either use them or stop exporting.
12. **`getKeyboardSelectionText()`** in `tui-alt-screen.ts` returns the *cursor character* when
    nothing is selected — surprising for a "selection" name, and only tests call it. Rename to
    `getKeyboardCursorText()` or fold the cursor case into the tests.
13. **`--ui` is missing from `--help`** (`cli/args.ts:355` documents `--tui-mode` only). Users have
    to guess the flag exists.
14. **`euler-seen.json` grows without bound** — one entry per session ever opened, never pruned.
    At a few hundred sessions it is irrelevant (a few kB), at thousands it is garbage. Prune
    entries not present in the last session list, or cap the file.
15. **`euler-mode.ts` is 858 lines**, the biggest unit in the fork. `showHelp` (~85 lines) and
    `runAction` (~150) are the natural splits if it grows further. Not urgent.
16. **`refreshEulerThreads()` marks the current session seen on every refresh**, i.e. a synchronous
    `writeFileSync` on each open/switch. Rare enough today; worth a cheap "skip if written < 5 s
    ago" guard if it ever shows up in profiles.

## Suggested next session, in order

Each item is deliberately small; upstream-fork rules still say keep code PRs under ~500 lines.

1. P1.1 stale listener + P1.2 responsive rail width (one commit, ~40 lines).
2. P2.4 single-pass rail render + P2.5/P2.6/P2.7 consolidate duplicated types/constants/keys
   (~60 lines, no behaviour change).
3. Finish the coding-agent suite; fix anything it flags. **This is the gate I would run first.**
4. P2.10 doc-free action set + P3.11/12 unused exports and the misleading name.
5. P3.13 `--ui` help text, P3.14 seen-file pruning.
6. Only then new features (editor normal mode, context/diff pane, per-entry tree in the rail).

## How to work on it

```bash
cd ~/projects/euler
npm run build                     # all packages + bundle
npm run euler:test                # euler contract tests (38)
npm --prefix packages/tui run test
npm run euler:gate                # upstream drift: SAFE / REVIEW / BLOCKED
~/projects/euler/bin/euler        # run (bun when present)
```

Remotes: `origin` = `github.com/guilherme-grimm/euler`, `upstream` = `earendil-works/pi`.
Upstream updates: gate → merge on a scratch branch → port seams → contract tests → bump
`upstream.baseTag` in `tools/euler/seams.json` → merge as a dedicated `chore: upstream vX.Y.Z`.
Never mix it with features.

Budget rules that have held so far: no boot-time growth (measured at 620 ms node / 250 ms bun on
this config), no per-keystroke work proportional to transcript length (rows strip lazily), no
background timers or polling, reuse pi-tui components instead of inventing abstractions.

## Open questions

- Rail default view: currently *last week*, with `/` for everything. Alternative: show all and
  only use `/` as a filter. One-line policy change.
- `Enter` on the current thread hides the rail; maybe it should just blur instead.
- Fork glyph in the rail is a `└` connector with the state glyph after it; a dedicated branch glyph
  may read better with deep nesting.
