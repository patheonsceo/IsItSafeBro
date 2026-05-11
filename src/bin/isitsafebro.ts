#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(here, "..", "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
  name: string;
  version: string;
};

const args = process.argv.slice(2);
const cmd = args[0];

function printVersion(): void {
  console.log(pkg.version);
}

function printHelp(): void {
  console.log(`isitsafebro v${pkg.version}`);
  console.log("");
  console.log("is it safe, bro? red-team your vibe-coded app before you ship.");
  console.log("");
  console.log("this is a claude code plugin. install it once, then use these slash");
  console.log("commands inside claude code:");
  console.log("");
  console.log("  /isitsafe        run the red-team scan on your localhost app");
  console.log("  /snap            split uncommitted work into clean commits");
  console.log("");
  console.log("commands:");
  console.log("  register         register the plugin with claude code (coming soon)");
  console.log("  --version, -v    print version");
  console.log("  --help, -h       this help");
}

if (cmd === "--version" || cmd === "-v" || cmd === "version") {
  printVersion();
  process.exit(0);
}

if (cmd === undefined || cmd === "--help" || cmd === "-h" || cmd === "help") {
  printHelp();
  process.exit(0);
}

if (cmd === "register") {
  console.log("plugin registration not implemented yet. coming on day 2.");
  process.exit(1);
}

console.log(`unknown command: ${cmd}`);
console.log(`try 'isitsafebro --help'.`);
process.exit(1);
