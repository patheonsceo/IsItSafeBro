#!/usr/bin/env node
/**
 * isitsafebro MCP server.
 *
 * Registers every tool listed in the spec (table under "MCP server tools").
 * Implementation lands incrementally; each tool is one commit. Tools without
 * an implementation yet return {ok: true, stub: true} as a placeholder.
 *
 * Currently implemented: snap_inspect, snap_commit (via ./tools/snap.ts).
 *
 * TODO open question: spec places source at `mcp/server.ts`; we keep it
 * under `src/mcp/server.ts` so the tsc build flows cleanly into `dist/`
 * and matches the rootDir convention. The compiled artifact at
 * `dist/mcp/server.js` is what `.mcp.json` registers with Claude Code.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { registerSnapTools } from "./tools/snap.js";
import { registerWorktreeTools } from "./tools/worktree.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "..", "package.json"), "utf8"),
) as { name: string; version: string };

const server = new McpServer(
  { name: pkg.name, version: pkg.version },
  {
    instructions:
      "isitsafebro mcp server. snap_inspect + snap_commit are real; remaining tools are stubs returning {ok: true, stub: true} pending later days of the build.",
  },
);

/** Helper: standard placeholder response while tools are stubs. */
function stub(tool: string) {
  const body = { ok: true, stub: true, tool };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

// ---------------------------------------------------------------------------
// /snap support — implemented in ./tools/snap.ts. Exposes snap_inspect and
// snap_commit; the calling Claude session plans the commit split, the tools
// execute it mechanically with server-side validation.
// ---------------------------------------------------------------------------

registerSnapTools(server);

// ---------------------------------------------------------------------------
// Worktree lifecycle — implemented in ./tools/worktree.ts. create_scan_worktree
// is real; install_and_start and cleanup_worktree are still stubs pending the
// next commits.
// ---------------------------------------------------------------------------

registerWorktreeTools(server);

server.registerTool(
  "install_and_start",
  {
    title: "Install (if needed) and start the dev server in a worktree",
    description:
      "Detect the dev server command (next/vite/express/etc.), allocate a free port via get-port, start the server, and wait for the port to respond. 60s timeout; surfaces a clear error if the app fails to start.",
    inputSchema: z.object({
      worktreePath: z.string(),
      preferredPort: z.number().int().optional(),
    }),
  },
  async () => stub("install_and_start"),
);

server.registerTool(
  "restart_dev_server",
  {
    title: "Restart the dev server in the scan worktree",
    description:
      "Kill the currently-running dev server for the scan worktree, restart it, and wait for the port to respond again. Used between the fix pass and the verification re-attack.",
    inputSchema: z.object({
      worktreePath: z.string(),
    }),
  },
  async () => stub("restart_dev_server"),
);

server.registerTool(
  "cleanup_worktree",
  {
    title: "Tear down the scan worktree directory",
    description:
      "Remove the worktree directory and prune git's worktree registry. The fix branch is left intact so the user can review or cherry-pick.",
    inputSchema: z.object({
      worktreePath: z.string(),
    }),
  },
  async () => stub("cleanup_worktree"),
);

// ---------------------------------------------------------------------------
// Reconnaissance
// ---------------------------------------------------------------------------

server.registerTool(
  "list_endpoints",
  {
    title: "Enumerate HTTP endpoints on the target app",
    description:
      "Crawl the running app to find routes. Parses framework routing (Next.js app/pages router, Express, etc.) where possible; falls back to live HTTP crawling. Returns an array of {method, path} entries.",
    inputSchema: z.object({
      url: z.string().describe("Base URL of the running dev server."),
      worktreePath: z
        .string()
        .optional()
        .describe("If provided, parse framework routing from the codebase as well."),
    }),
  },
  async () => stub("list_endpoints"),
);

server.registerTool(
  "load_payloads",
  {
    title: "Load attack payloads by category",
    description:
      "Read payload JSON files under `payloads/` by category (auth | api | prompt | secrets | idor). Returns the parsed payload list ready for use by the attacker subagent.",
    inputSchema: z.object({
      category: z.enum(["auth", "api", "prompt", "secrets", "idor", "all"]),
    }),
  },
  async () => stub("load_payloads"),
);

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

server.registerTool(
  "probe_endpoint",
  {
    title: "Send a single HTTP probe to the target app",
    description:
      "Issue an HTTP request to the dev server with the given method, path, headers, and body. Rate-limited per host. Returns the response status, headers, and body excerpt. Never destructive without explicit confirmation.",
    inputSchema: z.object({
      url: z.string(),
      method: z
        .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
        .default("GET"),
      path: z.string(),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.string().optional(),
    }),
  },
  async () => stub("probe_endpoint"),
);

// ---------------------------------------------------------------------------
// Fixing
// ---------------------------------------------------------------------------

server.registerTool(
  "apply_fix",
  {
    title: "Apply a patch to the scan worktree and commit it",
    description:
      "Write the supplied patch into the scan worktree, run any required formatter, and commit it on the scan branch with a descriptive conventional-commit message. One fix = one commit.",
    inputSchema: z.object({
      worktreePath: z.string(),
      file: z.string(),
      patch: z.string().describe("Unified diff or full file replacement."),
      commitMessage: z.string(),
    }),
  },
  async () => stub("apply_fix"),
);

// ---------------------------------------------------------------------------
// Verification & regression
// ---------------------------------------------------------------------------

server.registerTool(
  "verify_clean",
  {
    title: "Re-run confirmed exploits as a regression check",
    description:
      "Replay only the exploits that the attacker found previously, against the fixed worktree. Returns a per-finding pass/fail map; a fail means the fix didn't actually close the hole.",
    inputSchema: z.object({
      url: z.string(),
      findings: z.array(
        z.object({
          id: z.string(),
          payload: z.record(z.string(), z.unknown()),
        }),
      ),
    }),
  },
  async () => stub("verify_clean"),
);

server.registerTool(
  "freeze_test",
  {
    title: "Save a confirmed exploit as a permanent regression test",
    description:
      "Persist a verified, now-patched exploit under `.isitsafebro/tests/<category>/<id>.json` so future scans always re-run it and catch silent regressions.",
    inputSchema: z.object({
      cwd: z.string().optional(),
      finding: z.object({
        id: z.string(),
        category: z.enum(["auth", "api", "prompt", "secrets", "idor", "other"]),
        endpoint: z.string(),
        payload: z.record(z.string(), z.unknown()),
        evidence: z.string(),
      }),
    }),
  },
  async () => stub("freeze_test"),
);

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

server.registerTool(
  "merge_fix_branch",
  {
    title: "Merge the scan's fix branch into the user's main branch",
    description:
      "Run `git merge --no-ff <scan-branch>` into the user's working branch, surfacing conflicts cleanly. Only invoked when the user opts into --auto or accepts the merge prompt at the end of /isitsafe.",
    inputSchema: z.object({
      cwd: z.string().optional(),
      scanBranch: z.string(),
      target: z.string().optional().describe("Target branch; defaults to current."),
    }),
  },
  async () => stub("merge_fix_branch"),
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio is reserved for protocol traffic; logs go to stderr only.
  console.error(`isitsafebro mcp server v${pkg.version} ready on stdio`);
}

main().catch((err: unknown) => {
  console.error("isitsafebro mcp server failed to start:", err);
  process.exit(1);
});
