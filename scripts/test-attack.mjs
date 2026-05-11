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

    /* 1. Load payloads */
    const pay = await client.callTool("load_payloads", { category: "auth" });
    if (!pay.ok) die("load_payloads failed: " + JSON.stringify(pay));
    const payloads = pay.loaded[0].payloads;
    log(`loaded ${payloads.length} auth payloads`);

    /* 2. List endpoints */
    const eps = await client.callTool("list_endpoints", {
      url,
      worktreePath: vulnAppDir,
    });
    if (!eps.ok) die("list_endpoints failed: " + JSON.stringify(eps));
    log(
      `discovered ${eps.total} endpoints (sources: ${JSON.stringify(eps.bySource)})`,
    );
    // Sanity: should find /admin, /api/users, /api/me, etc.
    const paths = new Set(eps.endpoints.map((e) => e.path));
    const expectedRoutes = ["/admin", "/api/me", "/api/users", "/debug", "/login"];
    for (const p of expectedRoutes) {
      if (!paths.has(p)) die(`list_endpoints missed expected route ${p}`);
    }
    log("endpoint discovery sanity: ok");

    /* 3. Attack loop */
    const findings = [];
    const skipped = [];
    for (const p of payloads) {
      if (p.is_destructive) {
        skipped.push(p.id);
        continue;
      }
      const f = await attackOne(client, url, p);
      if (f) {
        findings.push(f);
        log(
          `  ✓ [${f.severity}] ${f.payload_id} → ${f.method} ${f.endpoint} (status ${f.response_status})`,
        );
      } else {
        log(`  ✗ NO FINDING: ${p.id}`);
      }
    }
    log(`skipped destructive: ${skipped.join(", ")}`);
    log(`total findings: ${findings.length} (expected 9)`);

    /* 4. Assertions: every expected payload fired */
    const expected = new Set([
      "unauthenticated-admin-route",
      "unauthenticated-write-endpoint",
      "jwt-alg-none-bypass",
      "weak-jwt-secret-guessable",
      "weak-default-credentials",
      "login-empty-credentials-accepted",
      "cors-misconfig-credentials-with-wildcard-or-reflected-origin",
      "unprotected-debug-or-internal-route",
      "session-cookie-without-httponly",
    ]);
    const foundIds = new Set(findings.map((f) => f.payload_id));
    const missing = [...expected].filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      die("missed expected findings: " + missing.join(", "));
    }
    const surprises = [...foundIds].filter((id) => !expected.has(id));
    if (surprises.length > 0) {
      die("unexpected findings (review): " + surprises.join(", "));
    }
    log("every expected bug was found, no surprises");

    /* 5. Anti-false-positive: healthy counterparts must NOT trigger */
    const unauthAdmin = payloads.find((p) => p.id === "unauthenticated-admin-route");
    const fpAdmin = await client.callTool("probe_endpoint", {
      url,
      path: "/safe-admin",
      method: "GET",
      evaluateSignal: unauthAdmin.success_signal,
    });
    if (fpAdmin.signal?.matched) {
      die("FALSE POSITIVE: unauthenticated-admin-route matched /safe-admin");
    }
    log("  ✓ no FP: /safe-admin does not match unauth-admin signal");

    const unauthWrite = payloads.find((p) => p.id === "unauthenticated-write-endpoint");
    const fpWrite = await client.callTool("probe_endpoint", {
      url,
      path: "/api/safe-users",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      evaluateSignal: unauthWrite.success_signal,
    });
    if (fpWrite.signal?.matched) {
      die("FALSE POSITIVE: unauthenticated-write-endpoint matched /api/safe-users");
    }
    log("  ✓ no FP: /api/safe-users does not match unauth-write signal");

    log("ALL CHECKS PASSED — 9 verified findings, 0 false positives");
    process.stdout.write("\nFINDINGS DETAIL:\n");
    for (const f of findings) {
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
