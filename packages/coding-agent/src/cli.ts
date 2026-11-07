#!/usr/bin/env node
import * as path from "node:path";
import { setupCli } from "./cli/setup.ts";
import { main } from "./main.ts";

setupCli();

// Only the `euler` entry point (package bin or linked binary) selects the modal interaction
// layer. Running `pi` stays stock Pi: no environment variable can change what the binary is.
const invokedAs = path.basename(process.argv[1] ?? "").replace(/\.(?:js|mjs|cjs|ts)$/, "");
const wantsEuler = invokedAs === "euler";

main(process.argv.slice(2), wantsEuler ? { ui: "euler" } : undefined);
