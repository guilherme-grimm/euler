# euler

Euler is a fork of [pi](https://github.com/earendil-works/pi) that adds a modal, vim-flavoured
interaction layer over the fullscreen transcript. It is a drop-in replacement: same
`~/.pi/agent` directory, same sessions, auth, models, skills, extensions, MCP and codemode.

Status: **MVP**. Modal navigation, visual selection, persistent quotes and thread forking work.
The input editor is still plain insert mode (see [Roadmap](#roadmap)).

## Run it

```bash
npm install
npm run build                       # builds every package and the CLI bundle
node packages/coding-agent/dist/bundle/cli.js --ui euler
```

Link the launcher, which prefers `bun` and falls back to `node`:

```bash
ln -s "$PWD/bin/euler" ~/.local/bin/euler
euler                    # equivalent to: pi --ui euler, run under bun when available
EULER_RUNTIME=node euler # force node
EULER=1 pi               # same thing without the launcher
pi --ui euler            # explicit
```

Bun starts this configuration in ~250 ms vs ~620 ms on node (TypeScript extensions compile
natively instead of going through `jiti`); see [PERFORMANCE.md](PERFORMANCE.md). The bundle is
identical, so this is a runtime choice, not a build change.

Euler always uses the alternate-screen viewport. `--tui-mode regular` is rejected because the
cursor and selection model need the fullscreen layout.

## Keys

Euler starts in **insert** mode so typing into the editor works exactly like pi. `Esc` enters
normal mode; `i` returns to insert.

| Mode | Key | Action |
|---|---|---|
| normal | `h` `j` `k` `l` | move the transcript cursor |
| both | `w` `b` `e` | word motions (punctuation counts as a word) |
| both | `W` `B` `E` | WORD motions (whitespace-delimited) |
| both | `0` `^` `$` | line start / first non-blank / line end |
| both | `gg` `G` | first line / last content line (`3G` → line 3) |
| both | `{` `}` | paragraph jumps (blank-line blocks) |
| both | `H` `M` `L` | top / middle / bottom of the screen |
| both | `Ctrl-d` `Ctrl-u` | half page down/up |
| both | `Ctrl-f` `Ctrl-b` | full page down/up |
| both | `3j`, `2W`, … | counts |
| both | `v` / `V` | character-wise / line-wise visual selection |
| visual | `y` | yank the selection |
| normal | `yy` `Y` | yank the current line |
| both | `"` or `q` | **quote** the selection into the session |
| both | `f` | **fork the thread** at the leaf (same context, new session file) |
| both | `F` | **rewind-fork** before the prompt at/under the cursor |
| both | `/` `n` `N` | search the transcript, next/previous match |
| normal | `<space>e` | toggle the thread sidebar |
| normal | `Ctrl-h` / `Ctrl-l` | focus the sidebar / back to the transcript |
| normal | `<space>s` | session picker (previous conversations) |
| normal | `<space>t` | session tree navigator |
| normal | `<space>f` | fork |
| normal | `<space>h` or `?` | cheatsheet (vim-style float) |
| normal | `i` / `A` | back to insert (editor) |
| normal | `:` | command line (`:q`, `:help`) |
| normal | `Esc` | clear pending prefix/count, or abort a streaming turn |

### Sidebar

`<space>e` (or `Ctrl-h`) opens a persistent rail on the left listing every session for this
workspace, with forks nested under the thread they came from. Rows sort by activity, so a fork you
just used lifts its parent to the top, and the live session appears immediately even before its
first turn is written to disk.

| glyph | meaning |
|---|---|
| `◉` | current session with a turn in flight |
| `●` | current session (idle) |
| `◆` | changed since you last opened it (recent only; never-opened threads are plain history) |
| `·` | never used (no messages yet) |
| `○` | read |

The default view is the working set: threads touched in the **last week**; the header shows
`· +N older` for the rest. `/` switches to search, which covers all history and filters as you
type (`↑`/`↓` move, `Enter` opens, `Esc` clears then leaves). Read state is persisted in
`~/.pi/agent/euler-seen.json` (path → last opened). The rail is not polled: it refreshes on open,
after forks, and after switching.

| key (rail focused) | action |
|---|---|
| `j` `k`, `Ctrl-d` `Ctrl-u`, `gg` `G` | move the selection |
| `/` | search all history (type to filter) |
| `Enter` | open that thread (or hide the rail when it is already current) |
| `n` / `r` | new session / reload the list |
| `Ctrl-l` | back to the transcript, rail stays open (`Ctrl-h` returns) |
| `e` `q` `Esc` | hide the rail |

The rail is refreshed when it opens, after forking, and after switching threads. Yank, quote and
fork also raise a transient flash (`Quoted into the thread`, `Forked thread`, …) so actions have
feedback beyond the statusline text.

Prefixes show which-key hints in the statusline (`<space>` → `s previous conversations · t session
tree · f fork thread · h this cheatsheet`), and `?` opens a grouped cheatsheet generated from the
same table that dispatches keys — `packages/coding-agent/src/modes/euler/keymap.ts`.

`Esc` in normal mode never types: it clears a pending operator or count, and otherwise does
nothing unless a turn is streaming, in which case it reaches pi's abort handler.

Keys are decoded through pi's `decodePrintableKey`, so terminals in the Kitty keyboard protocol
(space arrives as `\x1b[32u`, `?` as `\x1b[47:63;2u`) work the same as plain-byte terminals.
Key **release** events (`\x1b[32;1:3u`) are filtered before decoding — input listeners run before
pi's own release filter, and decoding a release would fire every binding twice, turning `<space>`
into `<space><space>`. Euler also hides pi's "↓ Jump to latest message" pill: `G` already goes to
the end.

Pi's selectors (session tree, session picker, model/settings pickers) are not overlays: they take
over the editor dock and receive focus. Euler yields every key while a component other than the
editor is focused, so those panels keep their own keys (typing filters, arrows move).

## Model

### Quotes

`"` on a selection appends a persistent `custom_message` entry with `customType: "quote"`:

- it is part of the session file, so it survives reload and forks
- it is part of model context, so "compare this with option B" sees the quoted text
- `details` carries `{ kind, line, rows, source, createdAt }` for provenance
- it renders inline in the transcript as a `[quote]` block, not as a user turn

One cell of transcript padding is stripped so quotes read as Markdown blockquotes.

### Forks

`f` calls `AgentSessionRuntime.fork(leafId, { position: "at" })`: a new session file with a
`parentSession` link, the full branch (including compaction entries) copied over. That is the
"discuss two implementations side by side without conflating them" flow: both threads keep the
same history, nothing is rewritten, and the statusline shows `forked from <id>`.

`F` calls `fork(entryId, { position: "before" })` on the user prompt at or under the cursor,
which rewinds the context and puts that prompt's text back in the editor.

## Architecture

Euler lives in new files, with small seams in upstream code:

| Path | Role |
|---|---|
| `packages/coding-agent/src/modes/euler/keymap.ts` | key table: dispatch, which-key hints, cheatsheet |
| `packages/coding-agent/src/modes/euler/euler-mode.ts` | modal state machine, actions, overlays |
| `packages/coding-agent/src/modes/euler/motions.ts` | pure, cell-aware motions with lazy row stripping |
| `packages/coding-agent/src/modes/euler/euler-sidebar.ts` | thread rail (sessions + fork nesting) |
| `packages/coding-agent/src/modes/euler/euler-status.ts` | one-line vim statusline |
| `packages/tui/src/tui-alt-screen.ts` | `setKeyboardState`, `getViewportSnapshot` (seam) |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | `attachEulerMode()` host wiring, rail layout (seam) |

The layer never rewrites transcript components. It keeps a cursor in *content* space, paints it
through the alt screen, and consumes keys only in normal/visual mode, so insert mode is plain pi.

Tests: `packages/coding-agent/test/euler-{mode,motions,sidebar}.test.ts` and
`packages/tui/test/keyboard-selection.test.ts` (33 vitest + 5 node:test cases).

Performance (startup, memory, keystroke budget, npm-vs-bun evaluation):
[PERFORMANCE.md](PERFORMANCE.md). Code review, known issues and the next-session plan:
[CODE-REVIEW.md](CODE-REVIEW.md).

## Updating upstream pi

Never merge a pi release straight into the working tree. The gate tells you what will break:

```bash
npm run euler:gate        # fetch upstream, classify drift, write .artifacts/upstream-gate.json
```

| status | meaning |
|---|---|
| `SAFE` (0) | nothing euler relies on moved; merge and run the contract tests |
| `REVIEW` (1) | upstream edited a file euler patches; port by hand |
| `BLOCKED` (2) | a signature or export euler imports disappeared |

The contract lives in [`tools/euler/seams.json`](../../tools/euler/seams.json): patched files,
required signatures, required exports, and the tests that assert behaviour we depend on
(fork inherits context, quotes round-trip, keyboard selection geometry, input-listener order).

Procedure:

1. `npm run euler:gate` and read `.artifacts/upstream-gate.json`.
2. Merge upstream into a throwaway branch, port the flagged seams.
3. `npm run euler:test` and `npm --prefix packages/tui run test`.
4. Rebuild, smoke-test in a terminal, update `upstream.baseTag` in `seams.json`.
5. Merge to `main` in a dedicated `chore: upstream vX.Y.Z` commit — never mixed with features.

`.github/workflows/euler-upstream.yml` runs the gate weekly, merges upstream in a scratch job,
runs the contract tests, and opens/updates a single `upstream drift` issue when either fails.

## Roadmap

- **Editor normal mode**: motions, text objects (`ci"`, `da(`), counts and registers inside the
  input editor. Today the editor is insert-only, so it is not in the critical path.
- Sidebar pane with the session/branch tree instead of the modal session picker (`<space>s`).
- Context pane for the tool call/diff under the cursor (t3-style right rail).
- Per-entry branch tree in the rail (today it shows threads, not every entry).
- Relative-number gutter for the transcript, scrollbar marks for quotes/forks.
- Register list (`"a`–`"z`) for accumulating several excerpts before quoting.
