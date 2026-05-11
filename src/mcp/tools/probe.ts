/**
 * probe_endpoint — send a single HTTP request, optionally evaluate a
 * structured signal against the response.
 *
 * design choices:
 *   - undici.request is used directly (not fetch). it preserves multi-value
 *     headers like Set-Cookie as arrays without WHATWG normalization games.
 *   - body reads cap at maxBodyBytes (default 1 MiB) but the full body is
 *     drained so we can report the true byte size; the matcher only sees
 *     the capped slice.
 *   - per-host rate limit (50 ms min gap → ≤20 req/s/host) is applied
 *     module-globally so the attacker can't accidentally DDoS the user's
 *     localhost dev server.
 *   - default timeout 5s, default no redirects. callers opt in.
 *   - never throws on network errors; returns {ok:false, error:...} so the
 *     attack loop can keep going.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { request as undiciRequest } from "undici";
import { evaluateSignal, normalizeHeaders, type EvalContext } from "./signal-eval.js";
import { SignalSchema, HttpMethodSchema, type Signal } from "./payload-schema.js";

function asContent<T>(payload: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload as unknown as { [key: string]: unknown },
  };
}

/* -------------------------------------------------------------------------- */
/*  Rate limiting (per host, in-process)                                      */
/* -------------------------------------------------------------------------- */

const DEFAULT_MIN_GAP_MS = 50;
const lastRequestByHost = new Map<string, number>();

async function rateLimit(host: string, minGapMs: number = DEFAULT_MIN_GAP_MS): Promise<void> {
  const last = lastRequestByHost.get(host);
  if (last !== undefined) {
    const elapsed = Date.now() - last;
    if (elapsed < minGapMs) {
      await new Promise<void>((r) => setTimeout(r, minGapMs - elapsed));
    }
  }
  lastRequestByHost.set(host, Date.now());
}

/* -------------------------------------------------------------------------- */
/*  Body reader with byte cap                                                 */
/* -------------------------------------------------------------------------- */

interface BodyRead {
  text: string;
  truncated: boolean;
  size: number;
}

async function readBodyCapped(
  body: AsyncIterable<Buffer | Uint8Array>,
  maxBytes: number,
): Promise<BodyRead> {
  const kept: Buffer[] = [];
  let keptBytes = 0;
  let totalBytes = 0;
  let truncated = false;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (truncated) continue;
    if (keptBytes + buf.length <= maxBytes) {
      kept.push(buf);
      keptBytes += buf.length;
    } else {
      const remaining = maxBytes - keptBytes;
      if (remaining > 0) {
        kept.push(buf.subarray(0, remaining));
        keptBytes += remaining;
      }
      truncated = true;
    }
  }
  return {
    text: Buffer.concat(kept).toString("utf8"),
    truncated,
    size: totalBytes,
  };
}

/* -------------------------------------------------------------------------- */
/*  Core probe                                                                */
/* -------------------------------------------------------------------------- */

export interface ProbeInput {
  url: string;
  path: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  evaluateSignal?: Signal;
}

export interface ProbeResult {
  ok: boolean;
  request: {
    url: string;
    method: string;
    path: string;
    finalUrl: string;
    headers: Record<string, string>;
    body?: string;
  };
  response?: {
    status: number;
    headers: Record<string, string[]>;
    body: string;
    bodyTruncated: boolean;
    bodySize: number;
    elapsedMs: number;
  };
  signal?: {
    matched: boolean;
    explanation: string;
  };
  error?: string;
}

export async function probeEndpoint(input: ProbeInput): Promise<ProbeResult> {
  const method = (input.method ?? "GET").toUpperCase();
  const timeoutMs = input.timeoutMs ?? 5000;
  const maxBodyBytes = input.maxBodyBytes ?? 1024 * 1024; // 1 MiB

  // Resolve the URL. Allow `path` to be an absolute URL too (useful for
  // crawl follow-ups). Otherwise join with the base.
  let finalUrl: URL;
  try {
    finalUrl = /^https?:\/\//.test(input.path)
      ? new URL(input.path)
      : new URL(input.path, input.url);
  } catch (err) {
    return {
      ok: false,
      request: { url: input.url, method, path: input.path, finalUrl: "", headers: input.headers ?? {} },
      error: `invalid URL: ${(err as Error).message}`,
    };
  }

  await rateLimit(finalUrl.host);

  const echoRequest = {
    url: input.url,
    method,
    path: input.path,
    finalUrl: finalUrl.toString(),
    headers: input.headers ?? {},
    ...(input.body !== undefined ? { body: input.body } : {}),
  };

  const started = Date.now();
  try {
    const res = await undiciRequest(finalUrl, {
      method: method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD",
      headers: input.headers ?? {},
      ...(input.body !== undefined ? { body: input.body } : {}),
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });

    const status = res.statusCode;
    const responseHeaders = normalizeHeaders(
      res.headers as Record<string, string | string[] | undefined>,
    );
    const bodyRead = await readBodyCapped(res.body, maxBodyBytes);
    const elapsedMs = Date.now() - started;

    const response = {
      status,
      headers: responseHeaders,
      body: bodyRead.text,
      bodyTruncated: bodyRead.truncated,
      bodySize: bodyRead.size,
      elapsedMs,
    };

    let signal: ProbeResult["signal"] | undefined;
    if (input.evaluateSignal) {
      const ctx: EvalContext = {
        status,
        headers: responseHeaders,
        body: bodyRead.text,
      };
      signal = evaluateSignal(input.evaluateSignal, ctx);
    }

    return {
      ok: true,
      request: echoRequest,
      response,
      ...(signal ? { signal } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      request: echoRequest,
      error: `${(err as Error).name}: ${(err as Error).message}`,
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  MCP wiring                                                                */
/* -------------------------------------------------------------------------- */

export function registerProbeTools(server: McpServer): void {
  server.registerTool(
    "probe_endpoint",
    {
      title: "Send one HTTP probe, optionally evaluate a signal",
      description:
        "Send a single HTTP request against the running dev server. Returns the response (status, headers as normalized Record<string, string[]>, body capped at 1 MiB, elapsed time). If `evaluateSignal` is supplied, the same structured predicate used in the payload library is run against the response and {matched, explanation} is returned alongside. Rate-limited to ≤20 req/s per host. Never throws on network errors; instead returns {ok: false, error: ...}.",
      inputSchema: z.object({
        url: z
          .string()
          .describe(
            "Base URL of the running dev server (e.g., http://127.0.0.1:3000). `path` is joined onto this.",
          ),
        path: z
          .string()
          .describe("Path or full URL. Absolute http(s)://… is allowed and overrides `url`."),
        method: HttpMethodSchema.optional(),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
        maxBodyBytes: z.number().int().positive().optional(),
        evaluateSignal: SignalSchema.optional(),
      }),
    },
    async (args) => {
      const result = await probeEndpoint({
        url: args.url,
        path: args.path,
        method: args.method,
        headers: args.headers,
        body: args.body,
        timeoutMs: args.timeoutMs,
        maxBodyBytes: args.maxBodyBytes,
        evaluateSignal: args.evaluateSignal,
      });
      return asContent(result);
    },
  );
}
