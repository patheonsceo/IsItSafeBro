/**
 * Fix-loop tools: apply_fix, verify_clean, freeze_test, merge_fix_branch.
 *
 * These tools run AFTER the attack loop produces findings. They are what
 * turns isitsafebro from a scanner into a feedback loop:
 *
 *   apply_fix         — write a patch (file replacements) into the scan
 *                       worktree and commit it on the scan branch
 *   verify_clean      — replay one or more confirmed exploits against
 *                       the (presumably-fixed) running worktree, return
 *                       per-finding matched bool
 *   freeze_test       — serialize a verified-and-now-fixed exploit as
 *                       a regression test under .isitsafebro/tests/
 *   merge_fix_branch  — git merge --no-ff the scan branch into the
 *                       user's target branch
 *
 * verify_clean is the keystone — it uses the SAME structured signal that
 * detected the bug to confirm the fix actually closed it. one source of
 * truth across detect → fix → verify → freeze.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { simpleGit, type SimpleGit } from "simple-git";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve as resolvePath, dirname, sep } from "node:path";
import {
  COMMIT_TYPES,
  type CommitType,
  validateCommit,
  formatCommitMessage,
} from "./snap.js";

function asContent<T>(payload: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload as unknown as { [key: string]: unknown },
  };
}

/* -------------------------------------------------------------------------- */
/*  apply_fix                                                                 */
/* -------------------------------------------------------------------------- */

interface ApplyFixInput {
  worktreePath: string;
  files: { path: string; content: string }[];
  commitType?: CommitType;
  commitSubject: string;
  commitBody?: string | null;
}

interface ApplyFixResult {
  ok: boolean;
  sha?: string;
  branch?: string;
  message?: string;
  filesWritten?: string[];
  error?: string;
}

async function applyFix(input: ApplyFixInput): Promise<ApplyFixResult> {
  const worktreePath = resolvePath(input.worktreePath);
  if (!existsSync(worktreePath)) {
    return { ok: false, error: `worktreePath does not exist: ${worktreePath}` };
  }
  const git: SimpleGit = simpleGit({ baseDir: worktreePath });
  if (!(await git.checkIsRepo())) {
    return { ok: false, error: `${worktreePath} is not a git repository` };
  }
  if (!Array.isArray(input.files) || input.files.length === 0) {
    return { ok: false, error: "files[] must contain at least one file" };
  }

  const commitType: CommitType = input.commitType ?? "fix";
  const validation = validateCommit({
    type: commitType,
    subject: input.commitSubject,
    body: input.commitBody ?? null,
  });
  if (!validation.ok) {
    return { ok: false, error: validation.reason };
  }

  // Resolve each file path and verify it stays inside the worktree —
  // path-traversal protection. ".." sequences in input.files[].path are
  // rejected unless the resolved result is still inside worktreePath.
  const writtenRel: string[] = [];
  const writtenAbs: string[] = [];
  for (const f of input.files) {
    if (typeof f.path !== "string" || f.path.length === 0) {
      return { ok: false, error: "file.path must be a non-empty string" };
    }
    if (typeof f.content !== "string") {
      return { ok: false, error: `file.content for ${f.path} must be a string` };
    }
    const abs = resolvePath(worktreePath, f.path);
    if (abs !== worktreePath && !abs.startsWith(worktreePath + sep)) {
      return {
        ok: false,
        error: `file path escapes the worktree: ${f.path}`,
      };
    }
    try {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.content);
    } catch (err) {
      return { ok: false, error: `write failed for ${f.path}: ${(err as Error).message}` };
    }
    writtenRel.push(f.path);
    writtenAbs.push(abs);
  }

  // Stage exactly the listed files.
  try {
    await git.add(writtenAbs);
  } catch (err) {
    return { ok: false, error: `git add failed: ${(err as Error).message}` };
  }

  const stagedSummary = await git.diff(["--cached", "--name-only"]);
  const stagedFiles = stagedSummary.split("\n").map((s) => s.trim()).filter(Boolean);
  if (stagedFiles.length === 0) {
    return {
      ok: false,
      error: "after staging, no changes were queued (files identical to HEAD?)",
    };
  }

  const message = formatCommitMessage(commitType, validation.subject, validation.body);
  let commitSha: string;
  try {
    const commit = await git.commit(message);
    commitSha = commit.commit;
  } catch (err) {
    return { ok: false, error: `git commit failed: ${(err as Error).message}` };
  }

  const status = await git.status();
  return {
    ok: true,
    sha: commitSha,
    branch: status.current ?? undefined,
    message,
    filesWritten: writtenRel,
  };
}

/* -------------------------------------------------------------------------- */
/*  MCP wiring (apply_fix only for now; the others come in following commits) */
/* -------------------------------------------------------------------------- */

export function registerFixTools(server: McpServer): void {
  server.registerTool(
    "apply_fix",
    {
      title: "Apply a fix to the scan worktree and commit it",
      description:
        "Write one or more files into the scan worktree (full file replacement, not a unified diff) and commit them on the scan branch with a conventional-commit message. The same subject rules as snap_commit apply (lowercase, single line, ≤ 60 chars, no trailing period). File paths are resolved relative to worktreePath and rejected if they escape the worktree. Default commit type is 'fix'.",
      inputSchema: z.object({
        worktreePath: z.string(),
        files: z
          .array(
            z.object({
              path: z.string().min(1),
              content: z.string(),
            }),
          )
          .min(1),
        commitType: z.enum(COMMIT_TYPES).optional(),
        commitSubject: z.string(),
        commitBody: z.string().nullable().optional(),
      }),
    },
    async (args) => {
      const result = await applyFix({
        worktreePath: args.worktreePath,
        files: args.files,
        commitType: args.commitType,
        commitSubject: args.commitSubject,
        commitBody: args.commitBody ?? null,
      });
      return asContent(result);
    },
  );
}

// The remaining tools (verify_clean, freeze_test, merge_fix_branch) are
// added by subsequent commits.
