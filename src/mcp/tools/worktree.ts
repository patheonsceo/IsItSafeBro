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
import { existsSync, symlinkSync } from "node:fs";
import { execa } from "execa";

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
}
