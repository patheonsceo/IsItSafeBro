#!/usr/bin/env node
/**
 * End-to-end ATTACK PROOF for isitsafebro.
 *
 * This is the day-6 "the product works" test. It:
 *
 *   1. spawns the deliberately-vulnerable fixture (test-fixtures/vuln-app)
 *   2. drives the real compiled MCP server over stdio
 *   3. calls load_payloads({category:'auth'}) to fetch the 10 attack patterns
 *   4. calls list_endpoints({worktreePath}) to verify route discovery
 *   5. for every non-destructive payload, runs an attack loop:
 *        for each variation × each endpoint_hint:
 *          probe_endpoint with the structured success_signal evaluated server-side;
 *          stop the payload when the signal fires once (we've proven the bug).
 *   6. asserts: every expected payload produced a finding (9 of 10; the
 *      destructive mass-assignment one is intentionally skipped); no false
 *      positives against the fixture's healthy counterpart routes.
 *
 * If this test passes, the entire attack loop — load, discover, probe, eval,
 * report — works end to end against real HTTP and the real payload library.
 */
import { spawn, execFileSync } from "node:child_process";
import getPort from "get-port";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "..");
const serverPath = resolve(repoRoot, "dist", "mcp", "server.js");
const vulnAppDir = resolve(repoRoot, "test-fixtures", "vuln-app");

function log(...args) {
  console.log("[test-attack]", ...args);
}
function die(msg) {
  console.error("[test-attack] FAIL:", msg);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/*  MCP client                                                                */
/* -------------------------------------------------------------------------- */

class StdioMcpClient {
  constructor(child) {
    this.child = child;
    this.buf = "";
    this.next_id = 1;
    this.pending = new Map();
    child.stdout.on("data", (chunk) => this.onData(chunk));
    child.stderr.on("data", (chunk) =>
      process.stderr.write(`[mcp] ${chunk}`),
    );
  }
  onData(chunk) {
    this.buf += chunk.toString("utf8");
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const [resolveFn, rejectFn] = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rejectFn(new Error(JSON.stringify(msg.error)));
        else resolveFn(msg.result);
      }
    }
  }
  send(method, params, expectReply = true) {
    const id = expectReply ? this.next_id++ : undefined;
    const payload = { jsonrpc: "2.0", method, ...(id !== undefined ? { id } : {}), params };
    return new Promise((resolveFn, rejectFn) => {
      if (id !== undefined) this.pending.set(id, [resolveFn, rejectFn]);
      this.child.stdin.write(JSON.stringify(payload) + "\n");
      if (id === undefined) resolveFn(undefined);
    });
  }
  async initialize() {
    await this.send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-attack", version: "1.0.0" },
    });
    await this.send("notifications/initialized", {}, false);
  }
  async callTool(name, args) {
    const result = await this.send("tools/call", { name, arguments: args });
    if (result.structuredContent) return result.structuredContent;
    return JSON.parse(result.content[0].text);
  }
  close() {
    this.child.stdin.end();
  }
}

/* -------------------------------------------------------------------------- */
/*  Vuln-app lifecycle                                                        */
/* -------------------------------------------------------------------------- */

async function startVulnApp() {
  const port = await getPort();
  const child = spawn("node", ["server.js"], {
    cwd: vulnAppDir,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  // wait for port to respond
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      execFileSync("curl", ["-s", "-o", "/dev/null", `http://127.0.0.1:${port}/`], {
        stdio: "ignore",
      });
      return { child, url: `http://127.0.0.1:${port}` };
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  throw new Error(`vuln-app did not come up on port ${port}`);
}

function stopVulnApp(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch {}
  }
}

/* -------------------------------------------------------------------------- */
/*  The attack loop                                                           */
/* -------------------------------------------------------------------------- */

function mergeRequest(base, variation) {
  const merged = { ...base, ...variation };
  // headers are merged on top, not replaced
  if (base.headers || variation.headers) {
    merged.headers = { ...(base.headers ?? {}), ...(variation.headers ?? {}) };
  }
  return merged;
}

async function attackOne(client, url, payload) {
  const variations = [{}, ...(payload.variations ?? [])];
  for (const variation of variations) {
    const req = mergeRequest(payload.request, variation);
    for (const hint of payload.endpoints_hint) {
      const result = await client.callTool("probe_endpoint", {
        url,
        path: hint,
        method: req.method,
        ...(req.headers ? { headers: req.headers } : {}),
        ...(req.body !== undefined ? { body: req.body } : {}),
        evaluateSignal: payload.success_signal,
      });
      if (result.signal?.matched) {
        return {
          payload_id: payload.id,
          severity: payload.severity,
          category: payload.category,
          endpoint: hint,
          method: req.method,
          variation_index: variations.indexOf(variation),
          explanation: result.signal.explanation,
          response_status: result.response?.status,
          fix_hint: payload.fix_hint,
        };
      }
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Main                                                                      */
/* -------------------------------------------------------------------------- */

async function main() {
  const { child: vuln, url } = await startVulnApp();
  log("vuln-app started:", url);

  const mcp = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
  const client = new StdioMcpClient(mcp);

  try {
    await client.initialize();
    log("mcp initialized");

    /* 1. Load payloads from EVERY category */
    const pay = await client.callTool("load_payloads", { category: "all" });
    if (!pay.ok) die("load_payloads failed: " + JSON.stringify(pay));
    const allPayloads = pay.loaded.flatMap((c) => c.payloads);
    const byCategory = {};
    for (const c of pay.loaded) byCategory[c.category] = c.payloads.length;
    log(`loaded ${allPayloads.length} payloads across categories:`, byCategory);

    /* 2. List endpoints */
    const eps = await client.callTool("list_endpoints", {
      url,
      worktreePath: vulnAppDir,
    });
    if (!eps.ok) die("list_endpoints failed: " + JSON.stringify(eps));
    log(
      `discovered ${eps.total} endpoints (sources: ${JSON.stringify(eps.bySource)})`,
    );
    const paths = new Set(eps.endpoints.map((e) => e.path));
    const expectedRoutes = [
      "/admin",
      "/api/me",
      "/api/users",
      "/debug",
      "/login",
      "/api/products",
      "/api/config",
      "/api/customers/1",
      "/api/chat",
    ];
    for (const p of expectedRoutes) {
      if (!paths.has(p)) die(`list_endpoints missed expected route ${p}`);
    }
    log("endpoint discovery sanity: ok");

    /* 3. Attack loop across all categories */
    const findings = [];
    const skipped = [];
    for (const p of allPayloads) {
      if (p.is_destructive) {
        skipped.push(p.id);
        continue;
      }
      const f = await attackOne(client, url, p);
      if (f) {
        findings.push(f);
        log(
          `  ✓ [${f.severity}] ${f.category}/${f.payload_id} → ${f.method} ${f.endpoint} (status ${f.response_status})`,
        );
      }
    }
    log(`skipped destructive: ${skipped.join(", ")}`);

    /* 4. Per-category expectations */
    const expectedFindings = {
      auth: new Set([
        "unauthenticated-admin-route",
        "unauthenticated-write-endpoint",
        "jwt-alg-none-bypass",
        "weak-jwt-secret-guessable",
        "weak-default-credentials",
        "login-empty-credentials-accepted",
        "cors-misconfig-credentials-with-wildcard-or-reflected-origin",
        "unprotected-debug-or-internal-route",
        "session-cookie-without-httponly",
      ]),
      api: new Set([
        "sql-injection-error-based",
        "xss-reflected",
        "path-traversal-via-filename-param",
      ]),
      secrets: new Set([
        "dotenv-file-served",
        "config-route-leaks-secrets",
      ]),
      idor: new Set([
        "per-user-resource-fetched-without-auth",
        "unauthed-list-endpoint-returns-records",
        "pii-in-list-response",
      ]),
      prompt: new Set([
        "prompt-injection-direct-canary",
        "prompt-injection-json-output-takeover",
        "prompt-injection-fake-system-message",
        "prompt-injection-data-channel-canary",
        "prompt-injection-jailbreak-via-roleplay",
        "prompt-injection-fake-assistant-turn",
        "prompt-injection-developer-mode-bypass",
      ]),
    };

    const totalExpected = Object.values(expectedFindings).reduce((n, s) => n + s.size, 0);
    log(`total findings: ${findings.length} (expected ${totalExpected})`);

    const errors = [];
    for (const [cat, expectedIds] of Object.entries(expectedFindings)) {
      const catFindings = findings.filter((f) => f.category === cat);
      const catFoundIds = new Set(catFindings.map((f) => f.payload_id));
      const missing = [...expectedIds].filter((id) => !catFoundIds.has(id));
      const surprises = [...catFoundIds].filter((id) => !expectedIds.has(id));
      if (missing.length > 0) errors.push(`[${cat}] missed: ${missing.join(", ")}`);
      if (surprises.length > 0) errors.push(`[${cat}] unexpected: ${surprises.join(", ")}`);
      log(`  ${cat}: ${catFindings.length}/${expectedIds.size} expected, surprises=${surprises.length}`);
    }
    if (errors.length > 0) {
      die("per-category assertions failed:\n  " + errors.join("\n  "));
    }
    log("every expected bug was found, no surprises across all 5 categories");

    /* 5. Anti-false-positive: healthy counterparts must NOT trigger */
    const findPayload = (id) => allPayloads.find((p) => p.id === id);

    const fpChecks = [
      {
        label: "/safe-admin does not match unauth-admin signal",
        payload: findPayload("unauthenticated-admin-route"),
        probe: { path: "/safe-admin", method: "GET" },
      },
      {
        label: "/api/safe-users does not match unauth-write signal",
        payload: findPayload("unauthenticated-write-endpoint"),
        probe: {
          path: "/api/safe-users",
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      },
      {
        label: "/api/users (no PII-secret fields) does not match excessive-data-exposure",
        payload: findPayload("excessive-data-exposure-on-user-endpoint"),
        probe: { path: "/api/users", method: "GET" },
      },
      {
        label: "/api/chat with benign 'hi' input does not match prompt-injection-direct-canary",
        payload: findPayload("prompt-injection-direct-canary"),
        probe: {
          path: "/api/chat",
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
        },
      },
    ];
    for (const fp of fpChecks) {
      if (!fp.payload) die(`anti-FP check missing payload definition: ${fp.label}`);
      const r = await client.callTool("probe_endpoint", {
        url,
        ...fp.probe,
        evaluateSignal: fp.payload.success_signal,
      });
      if (r.signal?.matched) {
        die(`FALSE POSITIVE: ${fp.label} — but signal matched.`);
      }
      log(`  ✓ no FP: ${fp.label}`);
    }

    log(`ALL CHECKS PASSED — ${findings.length} verified findings, 0 false positives, across 5 categories`);
    process.stdout.write("\nFINDINGS DETAIL:\n");
    const sorted = [...findings].sort((a, b) => {
      const cats = ["auth", "api", "secrets", "idor", "prompt"];
      const ci = cats.indexOf(a.category) - cats.indexOf(b.category);
      if (ci !== 0) return ci;
      return a.payload_id.localeCompare(b.payload_id);
    });
    let lastCat = null;
    for (const f of sorted) {
      if (f.category !== lastCat) {
        process.stdout.write(`\n=== ${f.category.toUpperCase()} ===\n`);
        lastCat = f.category;
      }
      process.stdout.write(`\n[${f.severity}] ${f.payload_id}\n`);
      process.stdout.write(`  endpoint: ${f.method} ${f.endpoint}\n`);
      process.stdout.write(`  evidence:\n`);
      for (const line of f.explanation.split("\n")) {
        process.stdout.write(`    ${line}\n`);
      }
    }
  } finally {
    client.close();
    mcp.kill("SIGTERM");
    stopVulnApp(vuln);
    await new Promise((r) => setTimeout(r, 200));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
