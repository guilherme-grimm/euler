#!/usr/bin/env node
import * as path from "node:path";
import { setupCli } from "./cli/setup.ts";
import { main } from "./main.ts";

setupCli();

// The `euler` entry point (package bin, linked binary, or `EULER=1`) selects the modal
// interaction layer without requiring a flag on every invocation.
const invokedAs = path.basename(process.argv[1] ?? "").replace(/\.(?:js|mjs|cjs|ts)$/, "");
const wantsEuler = invokedAs === "euler" || process.env.EULER === "1";

main(process.argv.slice(2), wantsEuler ? { ui: "euler" } : undefined);
