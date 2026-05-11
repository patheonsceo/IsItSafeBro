/**
 * load_payloads — load attack patterns by category.
 *
 * Locates the `payloads/<category>.json` file shipped with the plugin,
 * parses it, and validates against PayloadFileSchema. Schema violations
 * are reported as errors (not skipped) so a broken payload library can
 * never silently degrade a scan.
 *
 * Special category "all" merges every available file. Missing categories
 * are reported in `missing[]` rather than failing the whole call — useful
 * during the buildout phase when only auth.json exists.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath, join } from "node:path";
import {
  PAYLOAD_CATEGORIES,
  type PayloadCategory,
  PayloadFileSchema,
  type PayloadFile,
  type Payload,
} from "./payload-schema.js";

function asContent<T>(payload: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload as unknown as { [key: string]: unknown },
  };
}

/**
 * Resolve the directory shipped with the plugin that holds the JSON
 * payload files. We compile to dist/mcp/tools/payloads.js, so the payloads
 * directory is two levels up from this file's directory (../../payloads).
 *
 * Also honor an env override (ISITSAFEBRO_PAYLOADS_DIR) so tests and
 * future plugin layouts don't have to live with the relative path.
 */
function defaultPayloadsDir(): string {
  const override = process.env.ISITSAFEBRO_PAYLOADS_DIR;
  if (override) return resolvePath(override);
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/mcp/tools/payloads.js → ../../../payloads (dist/ + mcp/ + tools/)
  return resolvePath(here, "..", "..", "..", "payloads");
}

interface LoadPayloadsInput {
  category: PayloadCategory | "all";
  payloadsDir?: string;
}

export interface LoadedCategory {
  category: PayloadCategory;
  version: number;
  file: string;
  count: number;
  payloads: Payload[];
}

export interface LoadPayloadsResult {
  ok: boolean;
  payloadsDir: string;
  requested: PayloadCategory | "all";
  loaded: LoadedCategory[];
  missing: PayloadCategory[];
  total: number;
  error?: string;
}

function loadOneCategory(dir: string, category: PayloadCategory):
  | { ok: true; file: PayloadFile; path: string }
  | { ok: false; reason: "missing"; path: string }
  | { ok: false; reason: "bad_json"; path: string; error: string }
  | { ok: false; reason: "bad_schema"; path: string; error: string }
{
  const filePath = join(dir, `${category}.json`);
  if (!existsSync(filePath)) {
    return { ok: false, reason: "missing", path: filePath };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    return { ok: false, reason: "bad_json", path: filePath, error: (err as Error).message };
  }
  const result = PayloadFileSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      reason: "bad_schema",
      path: filePath,
      error: JSON.stringify(result.error.format(), null, 2),
    };
  }
  return { ok: true, file: result.data, path: filePath };
}

export function loadPayloads(input: LoadPayloadsInput): LoadPayloadsResult {
  const dir = resolvePath(input.payloadsDir ?? defaultPayloadsDir());
  const categories: PayloadCategory[] =
    input.category === "all" ? [...PAYLOAD_CATEGORIES] : [input.category];

  const loaded: LoadedCategory[] = [];
  const missing: PayloadCategory[] = [];

  for (const c of categories) {
    const result = loadOneCategory(dir, c);
    if (result.ok) {
      loaded.push({
        category: result.file.category,
        version: result.file.version,
        file: result.path,
        count: result.file.payloads.length,
        payloads: result.file.payloads,
      });
    } else if (result.reason === "missing") {
      missing.push(c);
    } else {
      // Hard fail on bad JSON or schema violations. We MUST NOT silently
      // serve a broken payload library — a misconfigured signal could
      // false-positive a finding for every scan that hits this category.
      return {
        ok: false,
        payloadsDir: dir,
        requested: input.category,
        loaded,
        missing,
        total: loaded.reduce((n, c) => n + c.count, 0),
        error: `failed to load ${result.path} (${result.reason}): ${result.error}`,
      };
    }
  }

  // For a single-category request, a missing file is a hard error too.
  if (input.category !== "all" && missing.length > 0) {
    return {
      ok: false,
      payloadsDir: dir,
      requested: input.category,
      loaded,
      missing,
      total: 0,
      error: `payload category '${input.category}' not found at ${join(dir, `${input.category}.json`)}`,
    };
  }

  return {
    ok: true,
    payloadsDir: dir,
    requested: input.category,
    loaded,
    missing,
    total: loaded.reduce((n, c) => n + c.count, 0),
  };
}

// ---------------------------------------------------------------------------
// MCP wiring
// ---------------------------------------------------------------------------

export function registerPayloadTools(server: McpServer): void {
  server.registerTool(
    "load_payloads",
    {
      title: "Load attack payloads by category",
      description:
        "Load the structured attack patterns shipped with the isitsafebro plugin. Pass a single category (auth | api | prompt | secrets | idor) or 'all'. Each loaded payload is validated against the canonical schema; bad JSON or schema violations cause a hard error so a broken library can never silently corrupt a scan. For 'all', missing categories are reported in `missing[]` instead of failing — useful while the library is still being built out.",
      inputSchema: z.object({
        category: z.enum([...PAYLOAD_CATEGORIES, "all"] as const),
        payloadsDir: z
          .string()
          .optional()
          .describe(
            "Override the payloads directory. Defaults to the plugin's shipped payloads/ folder, or the ISITSAFEBRO_PAYLOADS_DIR env var if set.",
          ),
      }),
    },
    async (args) => {
      const result = loadPayloads({
        category: args.category,
        payloadsDir: args.payloadsDir,
      });
      return asContent(result);
    },
  );
}
