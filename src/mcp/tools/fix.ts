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
import { resolve as resolvePath, dirname, sep, join } from "node:path";
import {
  COMMIT_TYPES,
  type CommitType,
  validateCommit,
  formatCommitMessage,
} from "./snap.js";
import {
  SignalSchema,
  HttpMethodSchema,
  PayloadCategorySchema,
  SeveritySchema,
  type Signal,
  type PayloadCategory,
  type Severity,
} from "./payload-schema.js";
import { probeEndpoint } from "./probe.js";

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
/*  verify_clean                                                              */
/* -------------------------------------------------------------------------- */

interface VerifyFindingInput {
  id: string;
  request: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";
    path: string;
    headers?: Record<string, string>;
    body?: string;
  };
  success_signal: Signal;
}

interface VerifyCleanInput {
  url: string;
  findings: VerifyFindingInput[];
  timeoutMs?: number;
}

interface VerifyOneResult {
  id: string;
  /** true = bug is STILL present (signal matched again). */
  stillVulnerable: boolean;
  /** alias of stillVulnerable for callers thinking in 'matched' terms. */
  matched: boolean;
  explanation?: string;
  responseStatus?: number;
  error?: string;
}

interface VerifyCleanResult {
  ok: boolean;
  url: string;
  results: VerifyOneResult[];
  cleaned: string[];
  stillVulnerable: string[];
  error?: string;
}

async function verifyClean(input: VerifyCleanInput): Promise<VerifyCleanResult> {
  if (!Array.isArray(input.findings) || input.findings.length === 0) {
    return {
      ok: false,
      url: input.url,
      results: [],
      cleaned: [],
      stillVulnerable: [],
      error: "findings[] must contain at least one entry",
    };
  }

  const results: VerifyOneResult[] = [];
  const cleaned: string[] = [];
  const stillVulnerable: string[] = [];

  for (const f of input.findings) {
    const probe = await probeEndpoint({
      url: input.url,
      path: f.request.path,
      method: f.request.method,
      headers: f.request.headers,
      body: f.request.body,
      timeoutMs: input.timeoutMs,
      evaluateSignal: f.success_signal,
    });

    if (!probe.ok) {
      // network error / connection refused → can't verify either way. report
      // it explicitly and DON'T mark it cleaned. callers can decide what to
      // do (treat as "needs retry" or "needs manual check").
      results.push({
        id: f.id,
        stillVulnerable: false,
        matched: false,
        error: probe.error ?? "probe failed",
      });
      continue;
    }

    const matched = probe.signal?.matched === true;
    const one: VerifyOneResult = {
      id: f.id,
      stillVulnerable: matched,
      matched,
      explanation: probe.signal?.explanation,
      responseStatus: probe.response?.status,
    };
    results.push(one);
    if (matched) stillVulnerable.push(f.id);
    else cleaned.push(f.id);
  }

  return {
    ok: true,
    url: input.url,
    results,
    cleaned,
    stillVulnerable,
  };
}

/* -------------------------------------------------------------------------- */
/*  freeze_test                                                               */
/* -------------------------------------------------------------------------- */

const FROZEN_TEST_SCHEMA_VERSION = 1;

interface FreezeTestInput {
  cwd?: string;
  finding: {
    payload_id: string;
    category: PayloadCategory;
    severity: Severity;
    name?: string;
    description?: string;
    request: {
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";
      path: string;
      headers?: Record<string, string>;
      body?: string;
    };
    success_signal: Signal;
    evidence?: string;
  };
}

interface FreezeTestResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/** Filesystem-safe-ish slug of an endpoint (METHOD + path) for use in filenames. */
function slugifyEndpoint(method: string, path: string): string {
  const cleaned = path.replace(/[^A-Za-z0-9._-]/g, "_").replace(/_+/g, "_");
  return `${method.toUpperCase()}_${cleaned}`.replace(/^_|_$/g, "");
}

function freezeTest(input: FreezeTestInput): FreezeTestResult {
  const cwd = resolvePath(input.cwd ?? process.cwd());
  if (!existsSync(cwd)) {
    return { ok: false, error: `cwd does not exist: ${cwd}` };
  }
  const { finding } = input;
  const categoryDir = join(cwd, ".isitsafebro", "tests", finding.category);
  try {
    mkdirSync(categoryDir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `mkdir ${categoryDir} failed: ${(err as Error).message}` };
  }

  const endpointSlug = slugifyEndpoint(finding.request.method, finding.request.path);
  const filename = `${finding.payload_id}--${endpointSlug}.json`;
  const outPath = join(categoryDir, filename);

  const record = {
    schema_version: FROZEN_TEST_SCHEMA_VERSION,
    payload_id: finding.payload_id,
    category: finding.category,
    severity: finding.severity,
    ...(finding.name ? { name: finding.name } : {}),
    ...(finding.description ? { description: finding.description } : {}),
    frozen_at: new Date().toISOString(),
    request: finding.request,
    success_signal: finding.success_signal,
    ...(finding.evidence ? { evidence: finding.evidence } : {}),
  };

  try {
    writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n");
  } catch (err) {
    return { ok: false, error: `write ${outPath} failed: ${(err as Error).message}` };
  }
  return { ok: true, path: outPath };
}

/* -------------------------------------------------------------------------- */
/*  merge_fix_branch                                                          */
/* -------------------------------------------------------------------------- */

interface MergeFixBranchInput {
  cwd?: string;
  scanBranch: string;
  target?: string;
  commitMessage?: string;
}

interface MergeFixBranchResult {
  ok: boolean;
  mergedInto?: string;
  scanBranch?: string;
  mergeSha?: string;
  conflicts?: string[];
  error?: string;
}

async function mergeFixBranch(input: MergeFixBranchInput): Promise<MergeFixBranchResult> {
  const cwd = resolvePath(input.cwd ?? process.cwd());
  const git: SimpleGit = simpleGit({ baseDir: cwd });
  if (!(await git.checkIsRepo())) {
    return { ok: false, error: `${cwd} is not a git repository` };
  }
  const status = await git.status();
  const currentBranch = status.current ?? "(detached)";
  const target = input.target ?? currentBranch;

  if (target !== currentBranch) {
    return {
      ok: false,
      error: `target branch is '${target}' but you're currently on '${currentBranch}'. checkout '${target}' first.`,
    };
  }

  // refuse to merge if there are uncommitted modifications that could
  // collide with the merge. UNTRACKED files (status.not_added) are fine —
  // git itself allows merging into a tree with untracked files as long as
  // the merge doesn't try to overwrite them, and we don't want to block
  // legitimate cases like frozen-test files that haven't been committed
  // yet.
  const blockingDirty = [
    ...status.modified.map((f) => `M ${f}`),
    ...status.deleted.map((f) => `D ${f}`),
    ...status.staged.map((f) => `S ${f}`),
    ...status.renamed.map((r) => `R ${r.from} -> ${r.to}`),
  ];
  if (blockingDirty.length > 0) {
    return {
      ok: false,
      mergedInto: target,
      scanBranch: input.scanBranch,
      error: `working tree has uncommitted modifications; commit or stash before merging.\n  ${blockingDirty.join("\n  ")}`,
    };
  }

  // verify scanBranch exists
  try {
    const branches = await git.branchLocal();
    if (!branches.all.includes(input.scanBranch)) {
      return {
        ok: false,
        error: `scan branch '${input.scanBranch}' not found locally`,
      };
    }
  } catch (err) {
    return { ok: false, error: `failed to list branches: ${(err as Error).message}` };
  }

  const commitMessage =
    input.commitMessage ?? `chore: merge isitsafebro fixes from ${input.scanBranch}`;

  try {
    await git.raw(["merge", "--no-ff", input.scanBranch, "-m", commitMessage]);
  } catch (err) {
    // check whether the failure was a conflict
    const postStatus = await git.status();
    if (postStatus.conflicted.length > 0) {
      return {
        ok: false,
        mergedInto: target,
        scanBranch: input.scanBranch,
        conflicts: postStatus.conflicted,
        error:
          `merge produced ${postStatus.conflicted.length} conflict(s). resolve them and 'git commit', or run 'git merge --abort' to roll back.`,
      };
    }
    return {
      ok: false,
      mergedInto: target,
      scanBranch: input.scanBranch,
      error: `git merge failed: ${(err as Error).message}`,
    };
  }

  const head = (await git.revparse(["HEAD"])).trim();
  return {
    ok: true,
    mergedInto: target,
    scanBranch: input.scanBranch,
    mergeSha: head,
  };
}

/* -------------------------------------------------------------------------- */
/*  MCP wiring                                                                */
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

  server.registerTool(
    "verify_clean",
    {
      title: "Replay confirmed exploits to confirm fixes worked",
      description:
        "Re-runs each captured (request, success_signal) pair against the (presumably-fixed) running server. Returns per-finding {stillVulnerable, explanation, responseStatus}. cleaned[] lists ids whose signal no longer matches (the fix worked); stillVulnerable[] lists ids whose signal STILL matches (the fix did not close the hole). Network errors on the probe are reported per-finding and do NOT mark a finding cleaned — they need manual triage. Uses the same structured signal evaluator as probe_endpoint, so 'cleaned' here is the same source of truth as 'found' was during the scan.",
      inputSchema: z.object({
        url: z.string().describe("Base URL of the (restarted) dev server."),
        findings: z
          .array(
            z.object({
              id: z.string(),
              request: z.object({
                method: HttpMethodSchema,
                path: z.string(),
                headers: z.record(z.string(), z.string()).optional(),
                body: z.string().optional(),
              }),
              success_signal: SignalSchema,
            }),
          )
          .min(1),
        timeoutMs: z.number().int().positive().optional(),
      }),
    },
    async (args) => {
      const result = await verifyClean({
        url: args.url,
        findings: args.findings.map((f) => ({
          id: f.id,
          request: f.request,
          success_signal: f.success_signal,
        })),
        timeoutMs: args.timeoutMs,
      });
      return asContent(result);
    },
  );

  server.registerTool(
    "freeze_test",
    {
      title: "Save a verified-and-now-fixed exploit as a regression test",
      description:
        "Persist a fixed finding as a self-contained regression test under <cwd>/.isitsafebro/tests/<category>/<payload_id>--<endpoint-slug>.json. The file contains everything needed to replay the exploit on a future scan (request + success_signal) plus metadata (severity, name, evidence excerpt, frozen-at timestamp). Future /isitsafe runs can replay every frozen test first; if any signal matches again, that's a regression — flagged loudly. Idempotent: re-freezing the same payload_id + endpoint overwrites the existing file with a fresh frozen_at.",
      inputSchema: z.object({
        cwd: z
          .string()
          .optional()
          .describe("Project root (the user's repo, not the scan worktree). Defaults to process.cwd()."),
        finding: z.object({
          payload_id: z.string(),
          category: PayloadCategorySchema,
          severity: SeveritySchema,
          name: z.string().optional(),
          description: z.string().optional(),
          request: z.object({
            method: HttpMethodSchema,
            path: z.string(),
            headers: z.record(z.string(), z.string()).optional(),
            body: z.string().optional(),
          }),
          success_signal: SignalSchema,
          evidence: z.string().optional(),
        }),
      }),
    },
    async (args) => {
      const result = freezeTest({
        cwd: args.cwd,
        finding: {
          payload_id: args.finding.payload_id,
          category: args.finding.category,
          severity: args.finding.severity,
          name: args.finding.name,
          description: args.finding.description,
          request: args.finding.request,
          success_signal: args.finding.success_signal,
          evidence: args.finding.evidence,
        },
      });
      return asContent(result);
    },
  );

  server.registerTool(
    "merge_fix_branch",
    {
      title: "Merge the scan branch into the user's target branch (--no-ff)",
      description:
        "Run `git merge --no-ff <scanBranch>` to land the isitsafebro-applied fixes into the user's working branch. Refuses if (a) the target is different from the current branch (asks the user to checkout first), (b) the working tree is dirty (might cause conflicts), or (c) the scan branch doesn't exist locally. On conflict, leaves the merge state in place (caller can decide to `git merge --abort` or resolve manually) and returns the list of conflicted files so the orchestrator can surface them clearly.",
      inputSchema: z.object({
        cwd: z.string().optional(),
        scanBranch: z.string(),
        target: z
          .string()
          .optional()
          .describe("Target branch. If different from current, returns an error asking the user to checkout first."),
        commitMessage: z
          .string()
          .optional()
          .describe("Merge commit message. Defaults to a 'chore: merge isitsafebro fixes from <branch>'."),
      }),
    },
    async (args) => {
      const result = await mergeFixBranch({
        cwd: args.cwd,
        scanBranch: args.scanBranch,
        target: args.target,
        commitMessage: args.commitMessage,
      });
      return asContent(result);
    },
  );
}
