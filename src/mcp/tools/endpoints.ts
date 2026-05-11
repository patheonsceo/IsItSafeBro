/**
 * list_endpoints — discover HTTP routes on a target application.
 *
 * four strategies, results merged and deduped by (method, path):
 *
 *   1. Next.js app router  — glob app/{,src/}**\/route.{ts,tsx,js,jsx},
 *      derive route path from file path, parse method exports from the
 *      file contents.
 *   2. Next.js pages router — glob {pages,src/pages}/api/**, derive
 *      route path from filename. method recorded as ANY since we don't
 *      parse `req.method` checks at this stage.
 *   3. Generic source scan  — regex-match `.METHOD('/path', ...)` over
 *      every TS/JS file. Covers Express, Fastify, Hono, koa, and our
 *      own fixtures.
 *   4. HTTP crawl           — GET the base URL, parse HTML for href /
 *      src / action / form, plus regex-extract paths from inline JS
 *      (fetch / axios / url calls). same-origin only, no recursion.
 *
 * goal: not be exhaustive (an LLM-driven attacker compensates), but
 * cover the common cases reliably and report `source` + `file` so the
 * caller can audit how a path was found.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { request as undiciRequest } from "undici";

function asContent<T>(payload: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload as unknown as { [key: string]: unknown },
  };
}

/* -------------------------------------------------------------------------- */
/*  Walker                                                                    */
/* -------------------------------------------------------------------------- */

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".vercel",
  ".cache",
  ".idea",
  ".vscode",
  "out",
]);

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

function* walk(dir: string, opts: { extensions?: Set<string> } = {}): Generator<string> {
  const exts = opts.extensions ?? SOURCE_EXTS;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name.length > 1 && entry.name !== ".env.example") {
      // hidden dirs/files (except .env.example) are skipped to keep noise down
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full, opts);
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf(".");
      if (dot < 0) continue;
      const ext = entry.name.slice(dot);
      if (exts.has(ext)) yield full;
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Shared types                                                              */
/* -------------------------------------------------------------------------- */

const METHOD_KEYWORDS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const;
type Method = (typeof METHOD_KEYWORDS)[number] | "ANY";

export interface DiscoveredEndpoint {
  method: Method;
  path: string;
  source: "next_app_router" | "next_pages_router" | "source_regex" | "http_crawl";
  file?: string;
  line?: number;
}

function dedupeAndSort(found: DiscoveredEndpoint[]): DiscoveredEndpoint[] {
  const seen = new Map<string, DiscoveredEndpoint>();
  for (const ep of found) {
    const path = normalizePath(ep.path);
    const key = `${ep.method}|${path}`;
    if (!seen.has(key)) {
      seen.set(key, { ...ep, path });
    }
  }
  return Array.from(seen.values()).sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return a.method.localeCompare(b.method);
  });
}

function normalizePath(p: string): string {
  if (!p.startsWith("/")) p = "/" + p;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/* -------------------------------------------------------------------------- */
/*  Strategy 1: Next.js app router                                            */
/* -------------------------------------------------------------------------- */

function fileToAppRouterPath(file: string, appRoot: string): string {
  let rel = relative(appRoot, file).split(sep).join("/");
  // strip /route.ext
  rel = rel.replace(/\/route\.(ts|tsx|js|jsx|mjs|cjs)$/i, "");
  // dynamic segments [foo] → :foo, catch-all [...slug] → *
  rel = rel
    .replace(/\[\.\.\.([^\]]+)\]/g, "*")
    .replace(/\[\[([^\]]+)\]\]/g, ":$1?")
    .replace(/\[([^\]]+)\]/g, ":$1");
  // route groups (foo) are transparent
  rel = rel.replace(/\(([^)]+)\)\//g, "");
  return "/" + rel;
}

function scanNextAppRouter(worktreePath: string): DiscoveredEndpoint[] {
  const out: DiscoveredEndpoint[] = [];
  const candidates = [join(worktreePath, "app"), join(worktreePath, "src", "app")];
  for (const appRoot of candidates) {
    let stat;
    try {
      stat = statSync(appRoot);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    for (const file of walk(appRoot)) {
      if (!/\/route\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(file.replace(/\\/g, "/"))) continue;
      let contents = "";
      try {
        contents = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const path = fileToAppRouterPath(file, appRoot);
      const exportRe = /export\s+(?:async\s+)?(?:function|const|let|var)\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g;
      const methods = new Set<Method>();
      for (const m of contents.matchAll(exportRe)) {
        methods.add(m[1] as Method);
      }
      if (methods.size === 0) {
        // route.ts files without recognizable method exports — record as ANY
        // so the attacker still tries to probe it.
        methods.add("ANY");
      }
      for (const method of methods) {
        out.push({ method, path, source: "next_app_router", file });
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Strategy 2: Next.js pages router (API routes only)                        */
/* -------------------------------------------------------------------------- */

function scanNextPagesRouter(worktreePath: string): DiscoveredEndpoint[] {
  const out: DiscoveredEndpoint[] = [];
  const candidates = [join(worktreePath, "pages", "api"), join(worktreePath, "src", "pages", "api")];
  for (const apiRoot of candidates) {
    let stat;
    try {
      stat = statSync(apiRoot);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    for (const file of walk(apiRoot)) {
      const rel = relative(apiRoot, file).split(sep).join("/");
      let path = rel.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/i, "");
      if (path === "index") path = "";
      path = path.replace(/\/index$/, "");
      path = path
        .replace(/\[\.\.\.([^\]]+)\]/g, "*")
        .replace(/\[\[([^\]]+)\]\]/g, ":$1?")
        .replace(/\[([^\]]+)\]/g, ":$1");
      out.push({ method: "ANY", path: `/api/${path}`.replace(/\/+/g, "/"), source: "next_pages_router", file });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Strategy 3: generic source regex                                          */
/* -------------------------------------------------------------------------- */

// Match common router-method idioms:
//   app.get('/x', ...), router.post("/y", ...), fastify.put(`/z`, ...)
//   .get('/x', also captures bare get('/x', ...) inside this file's source.
// The leading word boundary plus a likely receiver keeps noise down.
const SOURCE_ROUTE_RE = /\b(?:app|router|server|fastify|api|route|express|hono|koa|web)\b\s*[\.\[]?\s*(?:get|post|put|patch|delete|options|head|all)\s*[\]]?\s*\(\s*['"`]([^'"`]+)['"`]/gi;
const METHOD_FROM_SOURCE_RE = /\b(?:app|router|server|fastify|api|route|express|hono|koa|web)\b\s*[\.\[]?\s*(get|post|put|patch|delete|options|head|all)\s*[\]]?\s*\(\s*['"`]([^'"`]+)['"`]/gi;

function scanSourceRegex(worktreePath: string): DiscoveredEndpoint[] {
  const out: DiscoveredEndpoint[] = [];
  for (const file of walk(worktreePath)) {
    let contents = "";
    try {
      contents = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!SOURCE_ROUTE_RE.test(contents)) continue;
    SOURCE_ROUTE_RE.lastIndex = 0;

    // re-scan with method capture
    for (const m of contents.matchAll(METHOD_FROM_SOURCE_RE)) {
      const methodRaw = m[1]?.toUpperCase() ?? "";
      const path = m[2] ?? "";
      if (!path.startsWith("/")) continue; // skip relative URLs like 'api/x'
      const method: Method = methodRaw === "ALL" ? "ANY" : ((METHOD_KEYWORDS as readonly string[]).includes(methodRaw) ? (methodRaw as Method) : "ANY");
      // approximate line number via slice-up-to-match
      const upto = contents.slice(0, m.index ?? 0);
      const line = upto.split("\n").length;
      out.push({ method, path, source: "source_regex", file, line });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Strategy 4: HTTP crawl                                                    */
/* -------------------------------------------------------------------------- */

const HTML_PATH_ATTR_RE = /(?:href|src|action)\s*=\s*['"`]([^'"`]+)['"`]/gi;
const JS_PATH_LITERAL_RE = /['"`](\/[a-zA-Z0-9_\-./:?=&%]*)['"`]/g;

async function crawlForEndpoints(baseUrl: string, timeoutMs = 5000): Promise<DiscoveredEndpoint[]> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return [];
  }

  let body = "";
  try {
    const res = await undiciRequest(url, {
      method: "GET",
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    const chunks: Buffer[] = [];
    let total = 0;
    const cap = 512 * 1024;
    for await (const chunk of res.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > cap) break;
      chunks.push(buf);
    }
    body = Buffer.concat(chunks).toString("utf8");
  } catch {
    return [];
  }

  const paths = new Set<string>();
  for (const m of body.matchAll(HTML_PATH_ATTR_RE)) {
    const v = m[1] ?? "";
    if (v.startsWith("/")) paths.add(v.split(/[?#]/)[0] ?? v);
    else if (v.startsWith(url.origin)) {
      const p = v.slice(url.origin.length);
      paths.add(p.split(/[?#]/)[0] ?? p);
    }
  }
  for (const m of body.matchAll(JS_PATH_LITERAL_RE)) {
    const v = m[1] ?? "";
    if (v.startsWith("/")) paths.add(v.split(/[?#]/)[0] ?? v);
  }

  const out: DiscoveredEndpoint[] = [];
  for (const p of paths) {
    out.push({ method: "ANY", path: p, source: "http_crawl" });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Top-level                                                                 */
/* -------------------------------------------------------------------------- */

export interface ListEndpointsInput {
  url?: string;
  worktreePath?: string;
  crawl?: boolean;
}

export interface ListEndpointsResult {
  ok: boolean;
  endpoints: DiscoveredEndpoint[];
  total: number;
  bySource: Record<string, number>;
  warnings: string[];
}

export async function listEndpoints(input: ListEndpointsInput): Promise<ListEndpointsResult> {
  const warnings: string[] = [];
  const all: DiscoveredEndpoint[] = [];

  if (input.worktreePath) {
    let stat;
    try {
      stat = statSync(input.worktreePath);
    } catch {
      warnings.push(`worktreePath does not exist: ${input.worktreePath}`);
    }
    if (stat?.isDirectory()) {
      all.push(...scanNextAppRouter(input.worktreePath));
      all.push(...scanNextPagesRouter(input.worktreePath));
      all.push(...scanSourceRegex(input.worktreePath));
    }
  }

  if (input.url && (input.crawl ?? true)) {
    try {
      all.push(...(await crawlForEndpoints(input.url)));
    } catch (err) {
      warnings.push(`crawl failed: ${(err as Error).message}`);
    }
  }

  const endpoints = dedupeAndSort(all);
  const bySource: Record<string, number> = {};
  for (const e of endpoints) {
    bySource[e.source] = (bySource[e.source] ?? 0) + 1;
  }

  return { ok: true, endpoints, total: endpoints.length, bySource, warnings };
}

/* -------------------------------------------------------------------------- */
/*  MCP wiring                                                                */
/* -------------------------------------------------------------------------- */

// Suppress unused warning for the type-only import
void dirname;

export function registerEndpointTools(server: McpServer): void {
  server.registerTool(
    "list_endpoints",
    {
      title: "Enumerate HTTP endpoints on the target app",
      description:
        "Discover routes on the user's running app via four strategies merged together: Next.js app router (parse method exports from route.ts files), Next.js pages router (api/ files), a generic regex scan over TS/JS source for Express/Fastify/Hono/koa idioms, and an HTTP crawl of the base URL (HTML href/src/action plus inline JS path literals). Returns deduped endpoints with {method, path, source, file?, line?} so the caller can audit how each was found.",
      inputSchema: z.object({
        url: z
          .string()
          .optional()
          .describe("Base URL of the running dev server. Enables the HTTP crawl strategy."),
        worktreePath: z
          .string()
          .optional()
          .describe(
            "Path to the project's source code. Enables Next.js / generic-source static analysis.",
          ),
        crawl: z.boolean().optional().describe("Disable the HTTP crawl if false (default true)."),
      }),
    },
    async (args) => {
      const result = await listEndpoints({
        url: args.url,
        worktreePath: args.worktreePath,
        crawl: args.crawl,
      });
      return asContent(result);
    },
  );
}
