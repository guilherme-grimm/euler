# euler performance notes

Euler is meant to feel like pi, not like a heavier pi. This file records what was measured, what
was fixed, and the npm-vs-bun evaluation.

Measurements are from this machine (AMD/Linux, Node 22.23.4, Bun 1.4.4) with the author's real
`~/.pi/agent` config: 14 extensions, MCP servers, skills, codemode. Numbers move with the config;
re-run the commands below to get your own.

## Startup (`PI_STARTUP_BENCHMARK=1 PI_TIMING=1`)

Cold boot through `interactiveMode.init()`:

| runtime | euler | pi | note |
|---|---|---|---|
| node | 620 / 623 / 665 ms | 628 / 650 / 610 ms | euler ≈ pi, within noise |
| bun | 251 / 251 / 254 ms | 252 / 246 / 240 ms | ~2.5x faster than node |

`node cli.js --version` (module graph only) is 0.22–0.28 s on both runtimes; bun's first run was
1.19 s (cold cache), then 0.26–0.33 s.

Where the time goes on node: the interactive TUI itself is small; **TypeScript extensions** are
the bulk (`pi-hermes-memory` module import alone: 560 ms through `jiti`). Bun compiles those
natively, which is where the 2.5x comes from. A stock pi config with no TS extensions would see a
much smaller gap.

Reproduce:

```bash
PI_TIMING=1 PI_STARTUP_BENCHMARK=1 script -qec "node packages/coding-agent/dist/bundle/cli.js --ui euler --no-session" /dev/null | grep TOTAL
PI_TIMING=1 PI_STARTUP_BENCHMARK=1 script -qec "bun  packages/coding-agent/dist/bundle/cli.js --ui euler --no-session" /dev/null | grep TOTAL
```

## Memory

Idle TUI, same session, sampled after 13 s:

| process | RSS |
|---|---|
| node euler | 182.8 MB |
| node pi | 183.2 MB |
| bun euler | 171.3 MB |

Euler adds no measurable memory over pi; the footprint is extensions/MCP/model data.

## Keystroke cost (the one real hot spot, fixed)

Before: every key press called `stripTerminalSequences` on **every transcript row** to build the
motion document. Measured on 5 000 styled rows: **8.24 ms per keystroke** — visible jank on long
sessions.

After: `MotionDoc` keeps the raw rows and strips (and measures) a row the first time a motion
touches it. Same benchmark: construction is free, ~2.3 µs per row actually touched.

Guard: `packages/coding-agent/test/euler-mode.test.ts` asserts a 20 000-row document builds in
under 2 ms and reading one row stays fast, so the eager path can't come back silently.

## npm vs bun (evaluation, not switched)

**Runtime: switch-able today.** `bun packages/coding-agent/dist/bundle/cli.js --ui euler` works
with the same bundle, same sessions, same extensions. Gains ~370 ms of startup on this config and
~12 MB of RSS. Upstream also ships a `bun build --compile` binary path (`npm run build:binary`),
so a standalone `euler` binary is a supported direction rather than a fork.

**Package manager: later, and only with a trial.** Reasons not to flip `npm` → `bun install` yet:

- the repo's hooks run `npm run check:*` scripts, `npm --prefix ...` calls, and a generated
  `packages/coding-agent/install-lock` (checked in CI) that assumes npm's lockfile layout;
- native modules in the dependency graph (`@silvia-odwyer/photon-node`, `canvas`, `ssh2`,
  `cpu-features`) rely on prebuilt binaries/postinstall scripts;
- `package-lock.json` is the tested install path for `npm ci` in CI and for users installing the
  published packages.

Suggested order if we pursue it:

1. Ship the bun **runtime** by default for euler (wrapper script or compiled binary), keep node
   as the fallback. Zero risk to the build.
2. Trial `bun install` on a branch, diff the resulting tree, keep `vitest` (it runs fine under
   `bun run`), and validate `install-lock` regeneration.
3. Only then decide on the lockfile. If it happens, do it as its own `chore:` commit — never
   mixed with feature work, same rule as upstream updates.

Until then: `npm run build` + `bun .../cli.js` is the fast path, and it is measured, not assumed.

## Budget rules for new work

- Startup must not grow: anything added at boot needs a benchmark in the PR.
- No per-keystroke work proportional to transcript length. Motions stay lazy and cached.
- No background timers or polling loops; render on demand.
- Prefer reusing pi-tui components over new abstractions.
