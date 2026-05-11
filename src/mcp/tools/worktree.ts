/**
 * Worktree tools.
 *
 * Three MCP tools used by /isitsafe to spin up an isolated copy of the
 * user's project for red-team scanning:
 *
 *   create_scan_worktree  — git worktree add on a fresh branch, with a
 *                           node_modules symlink optimization.
 *   install_and_start     — boot the dev server inside the worktree on a
 *                           free port, wait for it to respond.   (next commit)
 *   cleanup_worktree      — kill the spawned server, remove the worktree
 *                           directory; branch is left intact.   (next commit)
 *
 * Why one module: install_and_start tracks spawned child processes so
 * cleanup_worktree can stop them. A shared module-level registry keeps
 * that state local and not exposed to other tools.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { simpleGit, type SimpleGit } from "simple-git";
import { resolve as resolvePath, dirname, basename, join } from "node:path";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { execa } from "execa";

/** Whatever execa() returns — a child-process-shaped Promise. */
type Subprocess = ReturnType<typeof execa>;
import getPort from "get-port";
import net from "node:net";

// ---------------------------------------------------------------------------
// Shared content helper (matches the style of snap.ts).
// ---------------------------------------------------------------------------

function asContent<T>(payload: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload as unknown as { [key: string]: unknown },
  };
}

// ---------------------------------------------------------------------------
// create_scan_worktree
// ---------------------------------------------------------------------------

interface CreateWorktreeInput {
  cwd?: string;
  branchPrefix?: string;
}

export interface CreateWorktreeResult {
  ok: boolean;
  cwd?: string;
  worktreePath?: string;
  branch?: string;
  nodeModules?: "symlinked" | "installed" | "skipped" | "failed";
  nodeModulesNote?: string;
  error?: string;
}

async function createScanWorktree(input: CreateWorktreeInput): Promise<CreateWorktreeResult> {
  const cwd = resolvePath(input.cwd ?? process.cwd());
  const git: SimpleGit = simpleGit({ baseDir: cwd });

  if (!(await git.checkIsRepo())) {
    return { ok: false, error: `${cwd} is not inside a git repository` };
  }

  // Need at least one commit; `git worktree add -b` derives from HEAD.
  let hasHead = true;
  try {
    await git.revparse(["HEAD"]);
  } catch {
    hasHead = false;
  }
  if (!hasHead) {
    return {
      ok: false,
      error: "no commits yet; make at least one commit before running an isitsafebro scan",
    };
  }

  const prefix = input.branchPrefix ?? "isitsafebro/scan-";
  const ts = Math.floor(Date.now() / 1000);
  const branch = `${prefix}${ts}`;
  const parent = dirname(cwd);
  const projectName = basename(cwd);
  const worktreePath = join(parent, `${projectName}-isitsafebro-${ts}`);

  if (existsSync(worktreePath)) {
    return {
      ok: false,
      error: `worktree path already exists: ${worktreePath}. retry in a second or pass a different branchPrefix`,
    };
  }

  try {
    await git.raw(["worktree", "add", worktreePath, "-b", branch]);
  } catch (err) {
    return {
      ok: false,
      error: `git worktree add failed: ${(err as Error).message}`,
    };
  }

  // Optimize: symlink node_modules from the source checkout so the worktree
  // doesn't need a fresh install. If symlinking fails (Windows w/o developer
  // mode, cross-device link, etc.) fall back to npm install in the worktree.
  // If the source has no node_modules, skip both.
  const sourceNodeModules = join(cwd, "node_modules");
  const worktreeNodeModules = join(worktreePath, "node_modules");
  let nodeModules: NonNullable<CreateWorktreeResult["nodeModules"]> = "skipped";
  let nodeModulesNote: string | undefined;

  if (existsSync(sourceNodeModules) && !existsSync(worktreeNodeModules)) {
    try {
      symlinkSync(sourceNodeModules, worktreeNodeModules, "dir");
      nodeModules = "symlinked";
    } catch (err) {
      nodeModulesNote = `symlink failed: ${(err as Error).message}; falling back to npm install`;
      try {
        await execa("npm", ["install"], { cwd: worktreePath, timeout: 5 * 60 * 1000 });
        nodeModules = "installed";
      } catch (installErr) {
        nodeModules = "failed";
        nodeModulesNote = `${nodeModulesNote}; npm install also failed: ${(installErr as Error).message}`;
      }
    }
  }

  return {
    ok: true,
    cwd,
    worktreePath,
    branch,
    nodeModules,
    ...(nodeModulesNote ? { nodeModulesNote } : {}),
  };
}

// ---------------------------------------------------------------------------
// install_and_start
// ---------------------------------------------------------------------------

/**
 * Order to try when the user (or /isitsafe) doesn't override the script.
 * Most vibe-coded apps use `dev`; fall through covers older / lighter setups.
 */
const DEFAULT_SCRIPT_ORDER = ["dev", "start", "serve"] as const;

interface RunningServer {
  child: Subprocess;
  port: number;
  script: string;
  startedAt: number;
}

/** Worktree path → live child process. cleanup_worktree reads from this. */
const runningServers = new Map<string, RunningServer>();

interface InstallAndStartInput {
  worktreePath: string;
  preferredPort?: number;
  devCommand?: string;
  readyTimeoutMs?: number;
}

export interface InstallAndStartResult {
  ok: boolean;
  url?: string;
  port?: number;
  pid?: number;
  script?: string;
  worktreePath?: string;
  error?: string;
}

/** TCP connect probe — true iff something is listening on the port. */
function isPortListening(port: number, host = "127.0.0.1", timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

/** Pick a dev script out of package.json. */
function detectDevScript(worktreePath: string, override?: string): { script: string } | { error: string } {
  const pkgPath = join(worktreePath, "package.json");
  if (!existsSync(pkgPath)) {
    return { error: `no package.json found at ${pkgPath}` };
  }
  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch (err) {
    return { error: `package.json is not valid JSON: ${(err as Error).message}` };
  }
  const scripts = pkg.scripts ?? {};
  if (override) {
    if (!scripts[override]) {
      return { error: `requested devCommand '${override}' is not a script in package.json` };
    }
    return { script: override };
  }
  for (const candidate of DEFAULT_SCRIPT_ORDER) {
    if (scripts[candidate]) return { script: candidate };
  }
  return {
    error: `package.json has no dev/start/serve script; pass devCommand explicitly. available: ${Object.keys(scripts).join(", ") || "(none)"}`,
  };
}

async function installAndStart(input: InstallAndStartInput): Promise<InstallAndStartResult> {
  const worktreePath = resolvePath(input.worktreePath);
  if (!existsSync(worktreePath)) {
    return { ok: false, error: `worktreePath does not exist: ${worktreePath}` };
  }
  if (runningServers.has(worktreePath)) {
    return { ok: false, error: `a dev server is already running for ${worktreePath}; call cleanup_worktree first` };
  }

  const detection = detectDevScript(worktreePath, input.devCommand);
  if ("error" in detection) {
    return { ok: false, error: detection.error };
  }
  const { script } = detection;

  let port: number;
  try {
    port = await getPort({
      port: input.preferredPort !== undefined ? [input.preferredPort] : undefined,
    });
  } catch (err) {
    return { ok: false, error: `port allocation failed: ${(err as Error).message}` };
  }

  // Inherit the user's env so framework flags / .env vars still resolve, but
  // override PORT/HOST so the spawned server binds where we expect it.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    HOSTNAME: "127.0.0.1",
    NODE_ENV: process.env.NODE_ENV ?? "development",
  };

  // detached:true puts the child in its own process group so cleanup_worktree
  // can kill the whole tree (npm + its node grandchild) with one group-kill,
  // not just the npm wrapper.
  const child = execa("npm", ["run", script], {
    cwd: worktreePath,
    env,
    stdio: "pipe",
    reject: false,
    detached: true,
  });

  // If the child dies before we see the port, surface it.
  let childExited = false;
  let exitInfo: string | null = null;
  child.then(
    (result) => {
      childExited = true;
      exitInfo = `exited (code ${result.exitCode ?? "?"})`;
      runningServers.delete(worktreePath);
    },
    (err) => {
      childExited = true;
      exitInfo = `errored: ${(err as Error).message}`;
      runningServers.delete(worktreePath);
    },
  );

  const readyTimeout = input.readyTimeoutMs ?? 60_000;
  const deadline = Date.now() + readyTimeout;
  while (Date.now() < deadline) {
    if (childExited) {
      return {
        ok: false,
        error: `dev server '${script}' ${exitInfo ?? "exited"} before the port responded`,
      };
    }
    if (await isPortListening(port)) {
      runningServers.set(worktreePath, { child, port, script, startedAt: Date.now() });
      return {
        ok: true,
        url: `http://127.0.0.1:${port}`,
        port,
        pid: child.pid,
        script,
        worktreePath,
      };
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  // Timed out; kill the child if it's still alive.
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
  return {
    ok: false,
    error: `dev server '${script}' did not respond on port ${port} within ${readyTimeout}ms`,
  };
}

// ---------------------------------------------------------------------------
// cleanup_worktree
// ---------------------------------------------------------------------------

interface CleanupWorktreeInput {
  worktreePath: string;
  /** If true, also delete the scan branch. Spec default is false (keep it). */
  deleteBranch?: boolean;
}

export interface CleanupWorktreeResult {
  ok: boolean;
  worktreePath?: string;
  killed?: "process_group" | "none" | "force";
  removed?: boolean;
  branchKept?: string;
  branchDeleted?: string;
  error?: string;
}

/** SIGTERM the whole process group, then SIGKILL after `graceMs` if still alive. */
async function killProcessGroup(pid: number, graceMs = 3000): Promise<"process_group" | "force"> {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Group doesn't exist (already exited) or wasn't created — try the
    // direct child as a fallback.
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return "process_group";
    }
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch {
      // group gone
      return "process_group";
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already dead
    }
  }
  return "force";
}

async function cleanupWorktree(input: CleanupWorktreeInput): Promise<CleanupWorktreeResult> {
  const worktreePath = resolvePath(input.worktreePath);
  if (!existsSync(worktreePath)) {
    return { ok: false, worktreePath, error: `worktreePath does not exist: ${worktreePath}` };
  }

  // 1. Stop the dev server if we're tracking one.
  let killed: NonNullable<CleanupWorktreeResult["killed"]> = "none";
  const running = runningServers.get(worktreePath);
  if (running) {
    const { child } = running;
    if (typeof child.pid === "number") {
      killed = await killProcessGroup(child.pid);
    }
    runningServers.delete(worktreePath);
  }

  // 2. Discover the source repo (common git dir) so we can issue the worktree
  // remove from there. Running it from inside the worktree itself works on
  // modern git, but the common-dir route is more portable.
  let sourceRepo: string | null = null;
  try {
    const wtGit = simpleGit({ baseDir: worktreePath });
    const commonDir = (await wtGit.raw(["rev-parse", "--git-common-dir"])).trim();
    // common-dir is typically <source>/.git; strip the trailing /.git.
    const absCommon = resolvePath(worktreePath, commonDir);
    sourceRepo = absCommon.endsWith(`${join(".git")}`)
      ? dirname(absCommon)
      : absCommon;
  } catch {
    sourceRepo = null;
  }

  // 3. Find the branch that this worktree is on, so we can keep it
  // by name and (optionally) delete it.
  let branchOnWorktree: string | null = null;
  try {
    const wtGit = simpleGit({ baseDir: worktreePath });
    branchOnWorktree = (await wtGit.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (branchOnWorktree === "HEAD") branchOnWorktree = null; // detached
  } catch {
    branchOnWorktree = null;
  }

  // 4. Remove the worktree. If sourceRepo lookup failed, try from inside.
  let removed = false;
  const tryRemove = async (baseDir: string): Promise<string | null> => {
    try {
      await simpleGit({ baseDir }).raw(["worktree", "remove", "--force", worktreePath]);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  };
  let removeError: string | null = null;
  if (sourceRepo) {
    removeError = await tryRemove(sourceRepo);
  }
  if (removeError !== null && !sourceRepo) {
    removeError = await tryRemove(dirname(worktreePath));
  }
  if (existsSync(worktreePath)) {
    // worktree remove didn't actually delete the dir; do it manually.
    try {
      const { rmSync } = await import("node:fs");
      rmSync(worktreePath, { recursive: true, force: true });
    } catch (err) {
      return {
        ok: false,
        worktreePath,
        killed,
        removed: false,
        error: `worktree remove failed: ${removeError ?? "(no git error)"}; manual rm also failed: ${(err as Error).message}`,
      };
    }
  }
  removed = true;
  // Prune the git registry so 'git worktree list' is clean.
  if (sourceRepo) {
    try {
      await simpleGit({ baseDir: sourceRepo }).raw(["worktree", "prune"]);
    } catch {
      // best effort
    }
  }

  // 5. Optionally delete the branch.
  let branchDeleted: string | undefined;
  let branchKept: string | undefined;
  if (branchOnWorktree) {
    if (input.deleteBranch && sourceRepo) {
      try {
        await simpleGit({ baseDir: sourceRepo }).raw(["branch", "-D", branchOnWorktree]);
        branchDeleted = branchOnWorktree;
      } catch {
        branchKept = branchOnWorktree;
      }
    } else {
      branchKept = branchOnWorktree;
    }
  }

  return {
    ok: true,
    worktreePath,
    killed,
    removed,
    ...(branchKept ? { branchKept } : {}),
    ...(branchDeleted ? { branchDeleted } : {}),
  };
}

// ---------------------------------------------------------------------------
// MCP wiring
// ---------------------------------------------------------------------------

export function registerWorktreeTools(server: McpServer): void {
  server.registerTool(
    "create_scan_worktree",
    {
      title: "Create an isolated git worktree for an isitsafebro scan",
      description:
        "Run `git worktree add` on a fresh branch (default name: isitsafebro/scan-<unix-ts>) and place the new working tree alongside the source repo as <project>-isitsafebro-<ts>. Symlinks node_modules from the source into the worktree to skip a fresh install; falls back to `npm install` inside the worktree if symlinking fails. Refuses if the source isn't a git repo or has no commits yet.",
      inputSchema: z.object({
        cwd: z
          .string()
          .optional()
          .describe("Path to the user's project (the source git repo). Defaults to the MCP server's cwd."),
        branchPrefix: z
          .string()
          .optional()
          .describe("Branch prefix; defaults to 'isitsafebro/scan-'."),
      }),
    },
    async (args) => {
      const result = await createScanWorktree({
        cwd: args.cwd,
        branchPrefix: args.branchPrefix,
      });
      return asContent(result);
    },
  );

  server.registerTool(
    "install_and_start",
    {
      title: "Start the dev server in a scan worktree",
      description:
        "Detect the dev script in the worktree's package.json (defaults: dev > start > serve), allocate a free localhost port via get-port, spawn the script with PORT/HOST env vars overridden, and poll the port until it responds. 60s timeout by default. Tracks the spawned process so cleanup_worktree can stop it. Refuses if no suitable script is found or if a server is already running for this worktree.",
      inputSchema: z.object({
        worktreePath: z.string(),
        preferredPort: z
          .number()
          .int()
          .optional()
          .describe("Try this port first; falls back to any free port if it's taken."),
        devCommand: z
          .string()
          .optional()
          .describe("Override script name from package.json (e.g., 'dev:secure'). Defaults to scanning dev → start → serve."),
        readyTimeoutMs: z
          .number()
          .int()
          .optional()
          .describe("Max wait for the port to respond. Defaults to 60000."),
      }),
    },
    async (args) => {
      const result = await installAndStart({
        worktreePath: args.worktreePath,
        preferredPort: args.preferredPort,
        devCommand: args.devCommand,
        readyTimeoutMs: args.readyTimeoutMs,
      });
      return asContent(result);
    },
  );

  server.registerTool(
    "cleanup_worktree",
    {
      title: "Tear down a scan worktree",
      description:
        "Kill the dev server running for this worktree (graceful SIGTERM to the process group, SIGKILL after 3s if still alive), then `git worktree remove --force` the directory. The scan branch is kept by default so the user can review or cherry-pick; pass deleteBranch=true to drop it too. Idempotent: returns ok:true even if no server was tracked, as long as the worktree directory ends up removed.",
      inputSchema: z.object({
        worktreePath: z.string(),
        deleteBranch: z
          .boolean()
          .optional()
          .describe("Also delete the scan branch. Default false (spec default keeps the branch)."),
      }),
    },
    async (args) => {
      const result = await cleanupWorktree({
        worktreePath: args.worktreePath,
        deleteBranch: args.deleteBranch,
      });
      return asContent(result);
    },
  );
}
