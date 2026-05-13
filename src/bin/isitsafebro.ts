#!/usr/bin/env node
/**
 * isitsafebro CLI.
 *
 * Three subcommands manage the install:
 *
 *   register    set up the four things Claude Code needs to discover and
 *               enable the plugin:
 *                 1. a local "marketplace" directory at
 *                    <claude_home>/plugins/marketplaces/local-isitsafebro/
 *                    with a marketplace.json listing the plugin and a
 *                    plugins/isitsafebro symlink pointing at the installed
 *                    package
 *                 2. a cache entry at
 *                    <claude_home>/plugins/cache/local-isitsafebro/isitsafebro/<version>
 *                    (the installPath that Claude Code reads commands/agents/
 *                    .mcp.json from at runtime)
 *                 3. an entry in <claude_home>/plugins/installed_plugins.json
 *                    under the key "isitsafebro@local-isitsafebro"
 *                 4. an entry in <claude_home>/plugins/known_marketplaces.json
 *                    plus enabledPlugins["isitsafebro@local-isitsafebro"]=true
 *                    in <claude_home>/settings.json
 *
 *   unregister  undo all of the above; preserves the installed-package
 *               directory itself (only Claude Code's records of it)
 *
 *   status      report what's currently registered and where, plus whether
 *               every file Claude Code expects to find through the cache
 *               path resolves cleanly
 *
 * Honors $CLAUDE_HOME for users with non-default Claude Code installs.
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  lstatSync,
  symlinkSync,
  unlinkSync,
  readlinkSync,
  renameSync,
  rmSync,
} from "node:fs";
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
/*  Paths                                                                     */
/* -------------------------------------------------------------------------- */

const MARKETPLACE_NAME = `local-${pkg.name}`;
const PLUGIN_KEY = `${pkg.name}@${MARKETPLACE_NAME}`;

function claudeHome(): string {
  return process.env.CLAUDE_HOME ?? join(homedir(), ".claude");
}
function pluginsDir(): string {
  return join(claudeHome(), "plugins");
}
function marketplaceDir(): string {
  return join(pluginsDir(), "marketplaces", MARKETPLACE_NAME);
}
function marketplaceManifestPath(): string {
  return join(marketplaceDir(), ".claude-plugin", "marketplace.json");
}
function marketplacePluginLink(): string {
  return join(marketplaceDir(), "plugins", pkg.name);
}
function cacheDir(): string {
  return join(pluginsDir(), "cache", MARKETPLACE_NAME, pkg.name, pkg.version);
}
function installedJsonPath(): string {
  return join(pluginsDir(), "installed_plugins.json");
}
function knownMarketplacesJsonPath(): string {
  return join(pluginsDir(), "known_marketplaces.json");
}
function settingsJsonPath(): string {
  return join(claudeHome(), "settings.json");
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
/*  Safe symlink — replace if already pointing at the right place             */
/* -------------------------------------------------------------------------- */

/** Returns the absolute path a symlink resolves to (one hop). */
function readLinkAbsolute(link: string): string {
  const target = readlinkSync(link);
  if (target.startsWith("/")) return target;
  return resolve(dirname(link), target);
}

/** Replace whatever's at `link` with a symlink pointing at `target`. */
function ensureSymlink(target: string, link: string): "ok" | "exists" {
  mkdirSync(dirname(link), { recursive: true });
  if (existsSync(link) || isDanglingSymlink(link)) {
    try {
      const info = lstatSync(link);
      if (info.isSymbolicLink()) {
        const current = readLinkAbsolute(link);
        if (current === target) return "exists";
        // existing symlink points elsewhere — replace it.
        unlinkSync(link);
      } else {
        throw new Error(
          `refuses to overwrite non-symlink at ${link}. remove it manually.`,
        );
      }
    } catch (err) {
      throw new Error(`${(err as Error).message}`);
    }
  }
  try {
    symlinkSync(target, link, "dir");
  } catch (err) {
    throw new Error(
      `symlink ${link} -> ${target} failed: ${(err as Error).message}\n` +
        `on windows, symlink creation needs developer mode enabled or admin rights.`,
    );
  }
  return "ok";
}

function isDanglingSymlink(p: string): boolean {
  try {
    const info = lstatSync(p);
    return info.isSymbolicLink();
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*  JSON config helpers                                                       */
/* -------------------------------------------------------------------------- */

function readJsonOrDefault<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    throw new Error(`failed to parse ${path}: ${(err as Error).message}`);
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const serialized = JSON.stringify(value, null, 2) + "\n";
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, serialized);
  // rename is atomic on the same filesystem.
  renameSync(tmp, path);
}

/* -------------------------------------------------------------------------- */
/*  marketplace.json                                                          */
/* -------------------------------------------------------------------------- */

function writeMarketplaceManifest(): void {
  const manifest = {
    name: MARKETPLACE_NAME,
    description:
      "Local marketplace wrapping a single plugin — written by `isitsafebro register`.",
    owner: { name: "isitsafebro", url: "https://github.com/patheonsceo/IsItSafeBro" },
    plugins: [
      {
        name: pkg.name,
        description:
          "is it safe, bro? red-team your vibe-coded app from inside claude code, before you ship.",
        version: pkg.version,
        author: { name: "patheonsceo", url: "https://github.com/patheonsceo" },
        source: `./plugins/${pkg.name}`,
        homepage: "https://github.com/patheonsceo/IsItSafeBro",
        license: "MIT",
        category: "security",
        keywords: ["security", "red-team", "vibe-coding", "owasp", "ai-security"],
      },
    ],
  };
  writeJsonAtomic(marketplaceManifestPath(), manifest);
}

/* -------------------------------------------------------------------------- */
/*  register                                                                  */
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
  console.log("commands inside claude code (note the namespace prefix):");
  console.log("");
  console.log("  /isitsafebro:isitsafe    run the red-team scan on your localhost app");
  console.log("  /isitsafebro:snap        split uncommitted work into clean commits");
  console.log("");
  console.log("setup:");
  console.log("  isitsafebro register     install + enable the plugin in claude code");
  console.log("  isitsafebro unregister   remove it");
  console.log("  isitsafebro status       show where the plugin is (or isn't) installed");
  console.log("");
  console.log("other:");
  console.log("  --version, -v            print version");
  console.log("  --help, -h               this help");
  console.log("");
  console.log("paths:");
  console.log("  plugin package:    " + packageRoot);
  console.log("  claude home:       " + claudeHome());
}

function cleanupLegacyInstall(): string[] {
  // Pre-marketplace versions of `register` symlinked the package directly into
  // ~/.claude/plugins/<name>. That doesn't actually enable the plugin in
  // current Claude Code. If we find that artifact, remove it.
  const notes: string[] = [];
  const legacyLink = join(pluginsDir(), pkg.name);
  if (existsSync(legacyLink) || isDanglingSymlink(legacyLink)) {
    try {
      const info = lstatSync(legacyLink);
      if (info.isSymbolicLink()) {
        unlinkSync(legacyLink);
        notes.push(`removed legacy symlink at ${legacyLink}`);
      }
    } catch {
      /* ignore */
    }
  }
  return notes;
}

function register(): void {
  verifyPluginRoot();

  const notes: string[] = [];
  notes.push(...cleanupLegacyInstall());

  // 1. Marketplace dir + manifest + plugin symlink
  try {
    writeMarketplaceManifest();
    notes.push(`wrote ${marketplaceManifestPath()}`);

    const linkResult = ensureSymlink(packageRoot, marketplacePluginLink());
    notes.push(
      `${linkResult === "ok" ? "linked" : "already linked"} ${marketplacePluginLink()} -> ${packageRoot}`,
    );
  } catch (err) {
    console.error(`isitsafebro: ${(err as Error).message}`);
    process.exit(1);
  }

  // 2. Cache symlink (Claude Code reads commands/, agents/, .mcp.json from here)
  try {
    const cacheResult = ensureSymlink(packageRoot, cacheDir());
    notes.push(
      `${cacheResult === "ok" ? "linked" : "already linked"} ${cacheDir()} -> ${packageRoot}`,
    );
  } catch (err) {
    console.error(`isitsafebro: ${(err as Error).message}`);
    process.exit(1);
  }

  const nowIso = new Date().toISOString();

  // 3. installed_plugins.json: register the install
  try {
    type Installed = {
      version: number;
      plugins: Record<string, unknown[]>;
    };
    const installed = readJsonOrDefault<Installed>(installedJsonPath(), {
      version: 2,
      plugins: {},
    });
    if (typeof installed.version !== "number") installed.version = 2;
    if (!installed.plugins || typeof installed.plugins !== "object") {
      installed.plugins = {};
    }
    // Drop any stale entry for this plugin under the OLD marketplace key (the
    // pre-marketplace 'local' name we used in early attempts).
    delete installed.plugins[`${pkg.name}@local`];
    installed.plugins[PLUGIN_KEY] = [
      {
        scope: "user",
        installPath: cacheDir(),
        version: pkg.version,
        installedAt: nowIso,
        lastUpdated: nowIso,
      },
    ];
    writeJsonAtomic(installedJsonPath(), installed);
    notes.push(`updated ${installedJsonPath()}`);
  } catch (err) {
    console.error(`isitsafebro: ${(err as Error).message}`);
    process.exit(1);
  }

  // 4. known_marketplaces.json: register the marketplace itself
  try {
    type Known = Record<
      string,
      {
        source: { source: string; path?: string; repo?: string };
        installLocation?: string;
        lastUpdated?: string;
      }
    >;
    const known = readJsonOrDefault<Known>(knownMarketplacesJsonPath(), {});
    delete known.local; // legacy
    known[MARKETPLACE_NAME] = {
      source: { source: "local", path: marketplaceDir() },
      installLocation: marketplaceDir(),
      lastUpdated: nowIso,
    };
    writeJsonAtomic(knownMarketplacesJsonPath(), known);
    notes.push(`updated ${knownMarketplacesJsonPath()}`);
  } catch (err) {
    console.error(`isitsafebro: ${(err as Error).message}`);
    process.exit(1);
  }

  // 5. settings.json: enable the plugin
  try {
    type Settings = Record<string, unknown> & {
      enabledPlugins?: Record<string, boolean>;
    };
    const settings = readJsonOrDefault<Settings>(settingsJsonPath(), {});
    settings.enabledPlugins = settings.enabledPlugins ?? {};
    delete settings.enabledPlugins[`${pkg.name}@local`]; // legacy
    settings.enabledPlugins[PLUGIN_KEY] = true;
    writeJsonAtomic(settingsJsonPath(), settings);
    notes.push(`updated ${settingsJsonPath()}`);
  } catch (err) {
    console.error(`isitsafebro: ${(err as Error).message}`);
    process.exit(1);
  }

  // Done.
  console.log(`registered ${pkg.name} v${pkg.version} with claude code`);
  for (const n of notes) console.log(`  · ${n}`);
  console.log("");
  console.log("restart claude code (or open a new session). the slash commands will appear");
  console.log("under the plugin namespace:");
  console.log("");
  console.log("  /isitsafebro:isitsafe");
  console.log("  /isitsafebro:snap");
}

/* -------------------------------------------------------------------------- */
/*  unregister                                                                */
/* -------------------------------------------------------------------------- */

function unregister(): void {
  const notes: string[] = [];

  // Remove the marketplace dir (it's our own; safe to delete)
  if (existsSync(marketplaceDir())) {
    try {
      rmSync(marketplaceDir(), { recursive: true, force: true });
      notes.push(`removed ${marketplaceDir()}`);
    } catch (err) {
      console.error(
        `isitsafebro: failed to remove ${marketplaceDir()}: ${(err as Error).message}`,
      );
    }
  }

  // Remove the cache entry. The cache is `cache/<mp>/<plugin>/<version>` —
  // we own the whole `cache/<mp>` subtree for our local marketplace, so it's
  // safe to remove that root.
  const cacheRoot = join(pluginsDir(), "cache", MARKETPLACE_NAME);
  if (existsSync(cacheRoot)) {
    try {
      rmSync(cacheRoot, { recursive: true, force: true });
      notes.push(`removed ${cacheRoot}`);
    } catch (err) {
      console.error(
        `isitsafebro: failed to remove ${cacheRoot}: ${(err as Error).message}`,
      );
    }
  }

  // installed_plugins.json: drop our entry
  if (existsSync(installedJsonPath())) {
    try {
      const installed = readJsonOrDefault<{ plugins: Record<string, unknown> }>(
        installedJsonPath(),
        { plugins: {} },
      );
      if (installed.plugins && PLUGIN_KEY in installed.plugins) {
        delete installed.plugins[PLUGIN_KEY];
        writeJsonAtomic(installedJsonPath(), installed);
        notes.push(`removed entry from ${installedJsonPath()}`);
      }
    } catch (err) {
      console.error(`isitsafebro: ${(err as Error).message}`);
    }
  }

  // known_marketplaces.json: drop our marketplace
  if (existsSync(knownMarketplacesJsonPath())) {
    try {
      const known = readJsonOrDefault<Record<string, unknown>>(
        knownMarketplacesJsonPath(),
        {},
      );
      if (MARKETPLACE_NAME in known) {
        delete known[MARKETPLACE_NAME];
        writeJsonAtomic(knownMarketplacesJsonPath(), known);
        notes.push(`removed entry from ${knownMarketplacesJsonPath()}`);
      }
    } catch (err) {
      console.error(`isitsafebro: ${(err as Error).message}`);
    }
  }

  // settings.json: drop the enable
  if (existsSync(settingsJsonPath())) {
    try {
      const settings = readJsonOrDefault<{
        enabledPlugins?: Record<string, boolean>;
      }>(settingsJsonPath(), {});
      if (settings.enabledPlugins && PLUGIN_KEY in settings.enabledPlugins) {
        delete settings.enabledPlugins[PLUGIN_KEY];
        writeJsonAtomic(settingsJsonPath(), settings);
        notes.push(`removed enable from ${settingsJsonPath()}`);
      }
    } catch (err) {
      console.error(`isitsafebro: ${(err as Error).message}`);
    }
  }

  notes.push(...cleanupLegacyInstall());

  if (notes.length === 0) {
    console.log("isitsafebro was not registered (nothing to remove)");
  } else {
    console.log(`unregistered ${pkg.name} from claude code`);
    for (const n of notes) console.log(`  · ${n}`);
  }
}

/* -------------------------------------------------------------------------- */
/*  status                                                                    */
/* -------------------------------------------------------------------------- */

function status(): void {
  console.log(`isitsafebro v${pkg.version}`);
  console.log("");
  console.log("paths:");
  console.log("  package:         " + packageRoot);
  console.log("  claude home:     " + claudeHome());
  console.log("  marketplace:     " + marketplaceDir());
  console.log("  cache:           " + cacheDir());
  console.log("  plugin key:      " + PLUGIN_KEY);
  console.log("");

  const checks: { label: string; ok: boolean; note: string }[] = [];

  // marketplace manifest exists?
  const mfPath = marketplaceManifestPath();
  checks.push({
    label: "marketplace manifest",
    ok: existsSync(mfPath),
    note: existsSync(mfPath) ? mfPath : `missing: ${mfPath}`,
  });

  // marketplace plugin symlink resolves to this package?
  const mpLink = marketplacePluginLink();
  let mpLinkOk = false;
  let mpLinkNote = "";
  try {
    const info = lstatSync(mpLink);
    if (info.isSymbolicLink()) {
      const t = readLinkAbsolute(mpLink);
      mpLinkOk = t === packageRoot;
      mpLinkNote = mpLinkOk ? t : `points to a different install: ${t}`;
    } else {
      mpLinkNote = `not a symlink: ${mpLink}`;
    }
  } catch {
    mpLinkNote = `missing: ${mpLink}`;
  }
  checks.push({ label: "marketplace plugin link", ok: mpLinkOk, note: mpLinkNote });

  // cache link resolves?
  let cacheOk = false;
  let cacheNote = "";
  try {
    const info = lstatSync(cacheDir());
    if (info.isSymbolicLink()) {
      const t = readLinkAbsolute(cacheDir());
      cacheOk = t === packageRoot;
      cacheNote = cacheOk ? t : `points to a different install: ${t}`;
    } else {
      cacheNote = `not a symlink: ${cacheDir()}`;
    }
  } catch {
    cacheNote = `missing: ${cacheDir()}`;
  }
  checks.push({ label: "cache link", ok: cacheOk, note: cacheNote });

  // installed_plugins.json has the entry?
  let instOk = false;
  let instNote = "";
  try {
    const installed = readJsonOrDefault<{ plugins?: Record<string, unknown[]> }>(
      installedJsonPath(),
      { plugins: {} },
    );
    const entry = installed.plugins?.[PLUGIN_KEY] as
      | Array<{ installPath?: string; version?: string }>
      | undefined;
    if (entry && entry.length > 0 && entry[0]?.installPath === cacheDir()) {
      instOk = true;
      instNote = `version ${entry[0].version}, installPath ok`;
    } else {
      instNote = entry
        ? `entry present but installPath ${entry[0]?.installPath ?? "(none)"} != ${cacheDir()}`
        : `no entry for ${PLUGIN_KEY}`;
    }
  } catch (err) {
    instNote = `read failed: ${(err as Error).message}`;
  }
  checks.push({ label: "installed_plugins.json", ok: instOk, note: instNote });

  // settings.json has the enable?
  let setOk = false;
  let setNote = "";
  try {
    const settings = readJsonOrDefault<{
      enabledPlugins?: Record<string, boolean>;
    }>(settingsJsonPath(), {});
    setOk = settings.enabledPlugins?.[PLUGIN_KEY] === true;
    setNote = setOk ? `enabledPlugins[${PLUGIN_KEY}] = true` : `${PLUGIN_KEY} not enabled`;
  } catch (err) {
    setNote = `read failed: ${(err as Error).message}`;
  }
  checks.push({ label: "settings.json", ok: setOk, note: setNote });

  // known_marketplaces.json has our marketplace?
  let knownOk = false;
  let knownNote = "";
  try {
    const known = readJsonOrDefault<Record<string, unknown>>(
      knownMarketplacesJsonPath(),
      {},
    );
    knownOk = MARKETPLACE_NAME in known;
    knownNote = knownOk
      ? `${MARKETPLACE_NAME} registered`
      : `${MARKETPLACE_NAME} not in known_marketplaces`;
  } catch (err) {
    knownNote = `read failed: ${(err as Error).message}`;
  }
  checks.push({ label: "known_marketplaces.json", ok: knownOk, note: knownNote });

  const allOk = checks.every((c) => c.ok);
  console.log("checks:");
  for (const c of checks) {
    const mark = c.ok ? "✓" : "✗";
    console.log(`  ${mark} ${c.label.padEnd(28)} ${c.note}`);
  }
  console.log("");
  console.log(`status:  ${allOk ? "REGISTERED" : "NOT FULLY REGISTERED"}`);
  if (!allOk) {
    console.log("");
    console.log("to install or repair: isitsafebro register");
  }
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
