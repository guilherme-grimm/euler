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

The `euler` name comes from the binary or from the environment:

```bash
ln -s "$PWD/packages/coding-agent/dist/bundle/cli.js" ~/.local/bin/euler
euler                    # equivalent to: pi --ui euler
EULER=1 pi               # same thing without the symlink
pi --ui euler            # explicit
```

Euler always uses the alternate-screen viewport. `--tui-mode regular` is rejected because the
cursor and selection model need the fullscreen layout.

## Keys

Euler starts in **insert** mode so typing into the editor works exactly like pi. `Esc` enters
normal mode; `i` returns to insert.

| Mode | Key | Action |
|---|---|---|
| normal | `h` `j` `k` `l` | move the transcript cursor |
| normal | `w` `b` `e` | word motions (punctuation counts as a word) |
| normal | `0` `^` `$` | line start / first non-blank / line end |
| normal | `gg` `G` | top / last content line |
| normal | `{` `}` | paragraph jumps (blank-line blocks) |
| normal | `3j`, `2w`, … | counts |
| normal | `Ctrl-d` `Ctrl-u` | half page down/up |
| normal | `v` / `V` | character-wise / line-wise visual selection |
| visual | `y` | yank to the clipboard |
| normal | `yy` | yank the current line |
| both | `"` or `q` | **quote** the selection into the session |
| normal | `f` | **fork the thread** at the leaf (same context, new session file) |
| normal/visual | `F` | **rewind-fork** before the prompt at/under the cursor |
| normal | `/` `n` `N` | search the transcript, next/previous match |
| normal | `<space>s` | session picker (previous conversations) |
| normal | `<space>t` | session tree navigator |
| normal | `<space>f` | fork |
| normal | `?` | keymap help |
| normal | `Esc` | clear pending count/prefix, or abort a streaming turn |

`Esc` in normal mode never types: it clears a pending operator or count, and otherwise does
nothing unless a turn is streaming, in which case it reaches pi's abort handler.

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
| `packages/coding-agent/src/modes/euler/euler-mode.ts` | modal state machine, key handling, actions |
| `packages/coding-agent/src/modes/euler/motions.ts` | pure, cell-aware text motions |
| `packages/coding-agent/src/modes/euler/euler-status.ts` | one-line vim statusline |
| `packages/tui/src/tui-alt-screen.ts` | `setKeyboardState`, `getViewportSnapshot` (seam) |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | `attachEulerMode()` host wiring (seam) |

The layer never rewrites transcript components. It keeps a cursor in *content* space, paints it
through the alt screen, and consumes keys only in normal/visual mode, so insert mode is plain pi.

Tests: `packages/coding-agent/test/euler-{mode,motions}.test.ts` and
`packages/tui/test/keyboard-selection.test.ts`.

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

- **Phase 2 — editor normal mode**: motions, text objects (`ci"`, `da(`), counts and registers
  inside the input editor. Today the editor is insert-only.
- Sidebar pane with the session/branch tree instead of the modal session picker (`<space>s`).
- Context pane for the tool call/diff under the cursor (t3-style right rail).
- Relative-number gutter for the transcript, scrollbar marks for quotes/forks.
- Register list (`"a`–`"z`) for accumulating several excerpts before quoting.
