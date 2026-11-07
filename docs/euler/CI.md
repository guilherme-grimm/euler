# CI policy

This fork runs **lint, types and tests. Nothing deploys, nothing publishes.**

One active workflow: `CI`. It has a read-only token (`permissions: contents: read`), so even a
future step that tried to publish would fail instead of shipping something.

## What CI does

| job | what it proves |
|---|---|
| `build-check` | `npm ci --ignore-scripts`, full `npm run build`, then `npm run check`: biome, pinned/runtime dependency guards, TS import rules, entry-graph budgets, install-lock freshness, `tsc --noEmit`, example typecheck, browser smoke |
| `test (coding-agent)` | full `packages/coding-agent` vitest suite, including the euler contract tests (`test/euler-*.test.ts`) |
| `test (durable)` | `packages/durable` suite |
| `test (other)` | every remaining workspace, including `packages/tui` (keyboard-selection tests) and the script tests |
| `mcp-conformance` | MCP client against the pinned conformance baseline |

Triggers: pushes to `main`, `v*.*.*` tags, and PRs to `main`.

## What is disabled, and why

Disabled at the repository level (`gh workflow list` shows them as `disabled_inactivity`/`disabled_manually`)
so no file differs from upstream and rebases stay clean.

| workflow | why |
|---|---|
| Preview packages | publishes to `pkg.earendil.com` (upstream registry) |
| Build Binaries | publishes npm packages and GitHub releases |
| Publish Model Catalog | uploads the catalog to upstream storage |
| p2 cloud bundle | uploads a bundle to upstream R2/S3 |
| Nix | packaging checks against upstream's pinned cache; not lint or tests |
| Environments | builds env daemons for upstream release packaging |
| pi-env daemons | called by the release workflows above |
| npm audit | scheduled security scan, not part of the gate (run locally: `npm audit`) |
| Issue Analysis · Issue Gate · Issue Triage Labels · Approve Contributor · PR Gate · Remove In Progress Label On Close | upstream maintainer automation; they verify `earendil-works/staff` membership and would close issues opened on this fork |
| euler upstream gate | weekly drift check, not a deploy. Disabled to keep a single active workflow; see below to restore |

## Restoring one

```bash
gh workflow enable "euler upstream gate" --repo guilherme-grimm/euler   # drift check, weekly
gh workflow enable "npm audit" --repo guilherme-grimm/euler
gh workflow list --repo guilherme-grimm/euler                         # verify
```

The drift check can also be run by hand, which is the usual way:

```bash
npm run euler:gate        # SAFE / REVIEW / BLOCKED
```

## If you ever do want to publish

Re-enable the specific workflow, restore its secrets, and remove the `contents: read` permission
from `ci.yml` first — the read-only token is the guard rail that keeps CI from shipping anything by
accident.
