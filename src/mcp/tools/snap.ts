/**
 * snap — AI-powered logical commit splitter.
 *
 * Exposes two MCP tools used by the /snap slash command:
 *
 *   snap_inspect — read git status and per-file diff, hand the raw material
 *                  back to the calling Claude session for clustering.
 *   snap_commit  — stage a listed set of files and commit them with a
 *                  validated conventional-commit message. Server-side
 *                  validation rejects malformed messages.
 *
 * Planning (clustering hunks into logical commits) happens in the user's
 * main Claude session, not in this tool — per the spec ("Pass the diff to
 * Claude (main session, not a subagent)..."). This module is the safe,
 * mechanical executor.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { simpleGit, type SimpleGit } from "simple-git";
import { resolve as resolvePath } from "node:path";

// ---------------------------------------------------------------------------
// Conventional-commit validation (pure, unit-testable)
// ---------------------------------------------------------------------------

export const COMMIT_TYPES = [
  "feat",
  "fix",
  "refactor",
  "chore",
  "docs",
  "test",
  "style",
  "perf",
] as const;
export type CommitType = (typeof COMMIT_TYPES)[number];

export const SUBJECT_MAX_LEN = 60;

export type ValidationResult =
  | { ok: true; subject: string; body: string | null }
  | { ok: false; reason: string };

/**
 * Validate a commit subject against the spec rules:
 *   - non-empty after trim
 *   - <= 60 chars
 *   - no ASCII uppercase letters (lowercase by convention)
 *   - no trailing period
 *   - single line
 */
export function validateSubject(raw: string): { ok: true; subject: string } | { ok: false; reason: string } {
  if (typeof raw !== "string") {
    return { ok: false, reason: "subject must be a string" };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "subject is empty" };
  }
  if (trimmed.length > SUBJECT_MAX_LEN) {
    return { ok: false, reason: `subject exceeds ${SUBJECT_MAX_LEN} chars (was ${trimmed.length})` };
  }
  if (/\n|\r/.test(trimmed)) {
    return { ok: false, reason: "subject must be a single line" };
  }
  if (/[A-Z]/.test(trimmed)) {
    return { ok: false, reason: "subject must be lowercase (no uppercase ASCII letters)" };
  }
  if (trimmed.endsWith(".")) {
    return { ok: false, reason: "subject must not end with a period" };
  }
  return { ok: true, subject: trimmed };
}

/**
 * Validate a full commit input (type + subject + optional body).
 */
export function validateCommit(input: {
  type: string;
  subject: string;
  body?: string | null;
}): ValidationResult {
  if (!(COMMIT_TYPES as readonly string[]).includes(input.type)) {
    return {
      ok: false,
      reason: `invalid type '${input.type}'. allowed: ${COMMIT_TYPES.join(", ")}`,
    };
  }
  const subjectResult = validateSubject(input.subject);
  if (!subjectResult.ok) return subjectResult;

  let body: string | null = null;
  if (input.body !== undefined && input.body !== null) {
    const trimmed = input.body.trim();
    if (trimmed.length > 0) body = trimmed;
  }

  return { ok: true, subject: subjectResult.subject, body };
}

/**
 * Format a validated commit input into a final message.
 */
export function formatCommitMessage(type: CommitType, subject: string, body: string | null): string {
  return body === null ? `${type}: ${subject}` : `${type}: ${subject}\n\n${body}`;
}

// ---------------------------------------------------------------------------
// Git plumbing
// ---------------------------------------------------------------------------

interface SnapInspectInput {
  cwd?: string;
}

interface SnapInspectResult {
  ok: boolean;
  cwd: string;
  isRepo: boolean;
  branch: string | null;
  clean: boolean;
  summary: {
    modified: string[];
    added: string[];
    deleted: string[];
    renamed: { from: string; to: string }[];
    untracked: string[];
    conflicted: string[];
  };
  files: { path: string; status: string; diff: string }[];
  error?: string;
}

async function snapInspect(input: SnapInspectInput): Promise<SnapInspectResult> {
  const cwd = resolvePath(input.cwd ?? process.cwd());
  const git: SimpleGit = simpleGit({ baseDir: cwd });

  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    return {
      ok: false,
      cwd,
      isRepo: false,
      branch: null,
      clean: false,
      summary: { modified: [], added: [], deleted: [], renamed: [], untracked: [], conflicted: [] },
      files: [],
      error: `${cwd} is not inside a git repository`,
    };
  }

  const status = await git.status();
  const branch = status.current;

  const conflicted = status.conflicted;
  if (conflicted.length > 0) {
    return {
      ok: false,
      cwd,
      isRepo: true,
      branch,
      clean: false,
      summary: {
        modified: status.modified,
        added: status.created,
        deleted: status.deleted,
        renamed: status.renamed.map((r) => ({ from: r.from, to: r.to })),
        untracked: status.not_added,
        conflicted,
      },
      files: [],
      error: `unmerged conflicts present in: ${conflicted.join(", ")}. resolve before running snap.`,
    };
  }

  // Collect candidate file paths from every status bucket.
  const renamedPairs = status.renamed.map((r) => ({ from: r.from, to: r.to }));
  const renamedPaths = new Set(renamedPairs.flatMap((r) => [r.from, r.to]));
  const allPaths = new Set<string>([
    ...status.modified,
    ...status.created,
    ...status.deleted,
    ...status.not_added,
    ...renamedPaths,
  ]);

  // Per-file unified diff. Combine working-tree diff with index diff so
  // already-staged changes show up too.
  const files: SnapInspectResult["files"] = [];
  for (const path of allPaths) {
    let status_label = "modified";
    if (status.not_added.includes(path)) status_label = "untracked";
    else if (status.created.includes(path)) status_label = "added";
    else if (status.deleted.includes(path)) status_label = "deleted";
    else if (renamedPaths.has(path)) status_label = "renamed";

    let diff = "";
    try {
      if (status_label === "untracked") {
        // git diff doesn't show untracked files; use --no-index against /dev/null.
        diff = await git.raw(["diff", "--no-index", "--", "/dev/null", path]).catch(() => "");
      } else {
        const workingDiff = await git.raw(["diff", "--", path]).catch(() => "");
        const stagedDiff = await git.raw(["diff", "--cached", "--", path]).catch(() => "");
        diff = [stagedDiff, workingDiff].filter(Boolean).join("\n");
      }
    } catch {
      diff = "";
    }

    files.push({ path, status: status_label, diff });
  }

  // Clean = nothing in any bucket.
  const clean =
    status.modified.length === 0 &&
    status.created.length === 0 &&
    status.deleted.length === 0 &&
    status.not_added.length === 0 &&
    status.renamed.length === 0 &&
    status.staged.length === 0;

  return {
    ok: true,
    cwd,
    isRepo: true,
    branch,
    clean,
    summary: {
      modified: status.modified,
      added: status.created,
      deleted: status.deleted,
      renamed: renamedPairs,
      untracked: status.not_added,
      conflicted: [],
    },
    files,
  };
}

interface SnapCommitInput {
  cwd?: string;
  type: CommitType;
  subject: string;
  body?: string | null;
  files: string[];
}

interface SnapCommitResult {
  ok: boolean;
  sha?: string;
  branch?: string;
  message?: string;
  filesCommitted?: string[];
  error?: string;
}

async function snapCommit(input: SnapCommitInput): Promise<SnapCommitResult> {
  const validation = validateCommit(input);
  if (!validation.ok) {
    return { ok: false, error: validation.reason };
  }
  const subject = validation.subject;
  const body = validation.body;

  if (!Array.isArray(input.files) || input.files.length === 0) {
    return { ok: false, error: "files[] must contain at least one path" };
  }

  const cwd = resolvePath(input.cwd ?? process.cwd());
  const git: SimpleGit = simpleGit({ baseDir: cwd });

  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    return { ok: false, error: `${cwd} is not inside a git repository` };
  }

  // Reset staging so we commit exactly the listed files and nothing else.
  // Pre-staged changes by the user are reset to unstaged; the slash command
  // documents this so users aren't surprised.
  try {
    await git.reset(["HEAD"]);
  } catch (err) {
    // Fresh repo with no HEAD: skip reset, nothing to unstage.
    void err;
  }

  try {
    await git.add(input.files);
  } catch (err) {
    return { ok: false, error: `git add failed: ${(err as Error).message}` };
  }

  const stagedSummary = await git.diff(["--cached", "--name-only"]);
  const stagedFiles = stagedSummary
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (stagedFiles.length === 0) {
    return {
      ok: false,
      error: "after staging, no changes were actually queued (files may be unchanged or ignored)",
    };
  }

  const message = formatCommitMessage(input.type, subject, body);
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
    filesCommitted: stagedFiles,
  };
}

// ---------------------------------------------------------------------------
// MCP wiring
// ---------------------------------------------------------------------------

function asContent<T>(payload: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload as unknown as { [key: string]: unknown },
  };
}

export function registerSnapTools(server: McpServer): void {
  server.registerTool(
    "snap_inspect",
    {
      title: "Inspect uncommitted work for snap",
      description:
        "Read the target repo's git status and per-file unified diff. Returns the branch, a cleanliness flag, a path summary bucketed by change type, and a per-file diff. Use this to plan a /snap commit split. Refuses if not in a git repo or if unmerged conflicts are present.",
      inputSchema: z.object({
        cwd: z
          .string()
          .optional()
          .describe("Working directory of the target repo. Defaults to the MCP server's cwd."),
      }),
    },
    async (args) => {
      const result = await snapInspect({ cwd: args.cwd });
      return asContent(result);
    },
  );

  server.registerTool(
    "snap_commit",
    {
      title: "Commit a planned slice of changes with a conventional message",
      description:
        "Stage the listed files and commit them with a validated conventional-commit message. Resets the index first so only the listed files are committed. Subject must be lowercase, <= 60 chars, no trailing period, single line. Type must be one of: feat, fix, refactor, chore, docs, test, style, perf.",
      inputSchema: z.object({
        cwd: z.string().optional(),
        type: z.enum(COMMIT_TYPES),
        subject: z.string(),
        body: z.string().nullable().optional(),
        files: z
          .array(z.string())
          .min(1, "files[] must contain at least one path"),
      }),
    },
    async (args) => {
      const result = await snapCommit({
        cwd: args.cwd,
        type: args.type,
        subject: args.subject,
        body: args.body ?? null,
        files: args.files,
      });
      return asContent(result);
    },
  );
}
