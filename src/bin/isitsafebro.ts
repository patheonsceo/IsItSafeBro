#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, lstatSync, symlinkSync, unlinkSync, readlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..", "..");
const pkgPath = join(packageRoot, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
  name: string;
  version: string;
};

const args = process.argv.slice(2);
const cmd = args[0];

/* -------------------------------------------------------------------------- */
/*  Plugin install paths                                                      */
/* -------------------------------------------------------------------------- */

/** Resolve Claude Code's plugin home. Honors $CLAUDE_HOME if set. */
function claudePluginsDir(): string {
  const claudeHome = process.env.CLAUDE_HOME ?? join(homedir(), ".claude");
  return join(claudeHome, "plugins");
}

function targetSymlinkPath(): string {
  return join(claudePluginsDir(), pkg.name);
}

function verifyPluginRoot(): void {
  const manifest = join(packageRoot, ".claude-plugin", "plugin.json");
  if (!existsSync(manifest)) {
    console.error(`isitsafebro: plugin manifest missing at ${manifest}.`);
    console.error("the package install looks incomplete. try reinstalling:");
    console.error("  npm install -g isitsafebro");
    process.exit(1);
  }
}

/* -------------------------------------------------------------------------- */
/*  Subcommands                                                               */
/* -------------------------------------------------------------------------- */

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
  console.log("setup:");
  console.log("  isitsafebro register       link this plugin into ~/.claude/plugins/");
  console.log("  isitsafebro unregister     remove the link");
  console.log("  isitsafebro status         show where the plugin is (or isn't) installed");
  console.log("");
  console.log("other:");
  console.log("  --version, -v              print version");
  console.log("  --help, -h                 this help");
  console.log("");
  console.log("plugin layout: " + packageRoot);
  console.log("claude plugins dir: " + claudePluginsDir());
}

function register(): void {
  verifyPluginRoot();
  const pluginsDir = claudePluginsDir();
  const target = targetSymlinkPath();

  try {
    mkdirSync(pluginsDir, { recursive: true });
  } catch (err) {
    console.error(`isitsafebro: could not create ${pluginsDir}: ${(err as Error).message}`);
    process.exit(1);
  }

  if (existsSync(target)) {
    let info;
    try {
      info = lstatSync(target);
    } catch {
      console.error(`isitsafebro: ${target} exists but cannot stat it. remove it manually.`);
      process.exit(1);
    }
    if (info.isSymbolicLink()) {
      const linkTarget = resolve(target, "..", readlinkSync(target));
      if (linkTarget === packageRoot) {
        console.log(`already registered: ${target} -> ${packageRoot}`);
        console.log("restart claude code (or open a new session) to pick up changes.");
        return;
      }
      console.error(`isitsafebro: ${target} links to a different location:`);
      console.error(`  current:  ${linkTarget}`);
      console.error(`  expected: ${packageRoot}`);
      console.error(`run 'isitsafebro unregister' first, then try again.`);
      process.exit(1);
    }
    console.error(`isitsafebro: ${target} already exists and is not a symlink to this install.`);
    console.error("remove it manually or run 'isitsafebro unregister' if you trust the target.");
    process.exit(1);
  }

  try {
    symlinkSync(packageRoot, target, "dir");
  } catch (err) {
    console.error(`isitsafebro: failed to create symlink at ${target}: ${(err as Error).message}`);
    console.error("if you're on windows without developer mode, the symlink call needs admin rights.");
    console.error("fall back to: cp -r " + packageRoot + " " + target);
    process.exit(1);
  }

  console.log("registered isitsafebro plugin");
  console.log("  source:  " + packageRoot);
  console.log("  link:    " + target);
  console.log("");
  console.log("restart claude code (or open a new session). /isitsafe and /snap should appear.");
}

function unregister(): void {
  const target = targetSymlinkPath();
  if (!existsSync(target)) {
    console.log(`isitsafebro is not registered (no ${target}).`);
    return;
  }
  let info;
  try {
    info = lstatSync(target);
  } catch {
    console.error(`isitsafebro: cannot stat ${target}. remove it manually if needed.`);
    process.exit(1);
  }
  if (!info.isSymbolicLink()) {
    console.error(`isitsafebro: ${target} exists but is not a symlink.`);
    console.error("refusing to delete a non-symlink. inspect and remove it yourself.");
    process.exit(1);
  }
  try {
    unlinkSync(target);
  } catch (err) {
    console.error(`isitsafebro: could not remove ${target}: ${(err as Error).message}`);
    process.exit(1);
  }
  console.log("unregistered isitsafebro from " + target);
}

function status(): void {
  const target = targetSymlinkPath();
  console.log("plugin package:        " + packageRoot);
  console.log("claude plugins dir:    " + claudePluginsDir());
  console.log("expected symlink:      " + target);

  if (!existsSync(target)) {
    console.log("status:                NOT REGISTERED");
    console.log("");
    console.log("to install: isitsafebro register");
    return;
  }
  let info;
  try {
    info = lstatSync(target);
  } catch (err) {
    console.log("status:                ERROR (" + (err as Error).message + ")");
    return;
  }
  if (info.isSymbolicLink()) {
    const linkTarget = resolve(target, "..", readlinkSync(target));
    if (linkTarget === packageRoot) {
      console.log("status:                REGISTERED (matches this install)");
    } else {
      console.log("status:                REGISTERED to a different install");
      console.log("  symlink points to:   " + linkTarget);
    }
    return;
  }
  console.log("status:                a non-symlink exists at the target");
}

/* -------------------------------------------------------------------------- */
/*  Dispatch                                                                  */
/* -------------------------------------------------------------------------- */

if (cmd === "--version" || cmd === "-v" || cmd === "version") {
  printVersion();
  process.exit(0);
}

if (cmd === undefined || cmd === "--help" || cmd === "-h" || cmd === "help") {
  printHelp();
  process.exit(0);
}

if (cmd === "register") {
  register();
  process.exit(0);
}

if (cmd === "unregister") {
  unregister();
  process.exit(0);
}

if (cmd === "status") {
  status();
  process.exit(0);
}

console.log(`unknown command: ${cmd}`);
console.log(`try 'isitsafebro --help'.`);
process.exit(1);
