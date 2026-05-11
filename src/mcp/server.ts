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
import { registerPayloadTools } from "./tools/payloads.js";
import { registerProbeTools } from "./tools/probe.js";
import { registerEndpointTools } from "./tools/endpoints.js";
import { registerFixTools } from "./tools/fix.js";

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
// Worktree lifecycle — implemented in ./tools/worktree.ts. All four tools
// (create_scan_worktree, install_and_start, cleanup_worktree, restart_dev_server)
// are real.
// ---------------------------------------------------------------------------

registerWorktreeTools(server);

// ---------------------------------------------------------------------------
// Reconnaissance — load_payloads is real (./tools/payloads.ts), list_endpoints
// is still a stub pending day 6.
// ---------------------------------------------------------------------------

registerPayloadTools(server);

registerEndpointTools(server);

// ---------------------------------------------------------------------------
// Probing — implemented in ./tools/probe.ts. Includes the structured signal
// evaluator built in so a single tool call returns both response and verdict.
// ---------------------------------------------------------------------------

registerProbeTools(server);

// ---------------------------------------------------------------------------
// Fix loop — implemented in ./tools/fix.ts. apply_fix is real; verify_clean,
// freeze_test, and merge_fix_branch are still stubs pending the next commits.
// ---------------------------------------------------------------------------

registerFixTools(server);

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
