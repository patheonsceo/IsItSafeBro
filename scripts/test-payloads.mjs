#!/usr/bin/env node
/**
 * End-to-end integration test for load_payloads over a live MCP server.
 *
 * - Drives the compiled dist/mcp/server.js over stdio.
 * - Loads `auth` directly and asserts the shape (10 payloads, severities,
 *   destructive flag on mass-assignment, recursive signals).
 * - Loads `all`: expects auth present, the other four categories listed
 *   in missing[].
 * - Confirms that asking for a missing single category is a hard error.
 *
 * Run with:  npm run test:e2e:payloads
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "..");
const serverPath = resolve(repoRoot, "dist", "mcp", "server.js");

function log(...args) {
  console.log("[test-payloads]", ...args);
}
function die(msg) {
  console.error("[test-payloads] FAIL:", msg);
  process.exit(1);
}

class StdioMcpClient {
  constructor(child) {
    this.child = child;
    this.buf = "";
    this.next_id = 1;
    this.pending = new Map();
    child.stdout.on("data", (chunk) => this.onData(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
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
      clientInfo: { name: "test-payloads", version: "1.0.0" },
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

async function main() {
  const child = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
  const client = new StdioMcpClient(child);

  try {
    await client.initialize();
    log("initialized");

    /* 1. load auth */
    const auth = await client.callTool("load_payloads", { category: "auth" });
    if (!auth.ok) die("auth load failed: " + JSON.stringify(auth));
    if (auth.total !== 10) die(`expected 10 auth payloads, got ${auth.total}`);
    const authCat = auth.loaded[0];
    if (authCat.category !== "auth") die("category mismatch");
    if (authCat.payloads.length !== 10) die("loaded.payloads.length != 10");
    log(`auth load ok: ${auth.total} payloads`);

    /* 2. severity sanity (we picked 6 critical, 3 high, 1 medium when seeding) */
    const sevCount = authCat.payloads.reduce((acc, p) => {
      acc[p.severity] = (acc[p.severity] ?? 0) + 1;
      return acc;
    }, {});
    if (sevCount.critical !== 6 || sevCount.high !== 3 || sevCount.medium !== 1) {
      die("unexpected severity distribution: " + JSON.stringify(sevCount));
    }
    log("severity distribution ok:", sevCount);

    /* 3. mass-assignment is correctly destructive-flagged */
    const massAssign = authCat.payloads.find((p) => p.id === "mass-assignment-role-on-signup");
    if (!massAssign) die("missing mass-assignment-role-on-signup payload");
    if (massAssign.is_destructive !== true) die("mass-assignment must be is_destructive");
    log("destructive flag ok on mass-assignment-role-on-signup");

    /* 4. weak-jwt-secret-guessable has the variations baked in (20 secrets total = base + 19 variations) */
    const weakJwt = authCat.payloads.find((p) => p.id === "weak-jwt-secret-guessable");
    if (!weakJwt) die("missing weak-jwt-secret-guessable payload");
    const totalJwtAttempts = 1 + (weakJwt.variations?.length ?? 0);
    if (totalJwtAttempts !== 20) {
      die(`expected 20 JWT attempt variants (base + 19 variations), got ${totalJwtAttempts}`);
    }
    log("weak-jwt-secret-guessable has 20 token variants");

    /* 5. recursive signals: confirm cors-misconfig has a nested any_of */
    const cors = authCat.payloads.find((p) =>
      p.id === "cors-misconfig-credentials-with-wildcard-or-reflected-origin",
    );
    if (!cors) die("missing cors-misconfig payload");
    if (cors.success_signal.kind !== "all_of") die("cors signal root must be all_of");
    const hasNestedAnyOf = cors.success_signal.conditions.some((c) => c.kind === "any_of");
    if (!hasNestedAnyOf) die("expected a nested any_of inside cors signal");
    log("recursive signal structure ok on cors-misconfig");

    /* 6. load all → every shipped category present, no missing */
    const all = await client.callTool("load_payloads", { category: "all" });
    if (!all.ok) die("all load failed: " + JSON.stringify(all));
    const cats = new Set(all.loaded.map((c) => c.category));
    const expectedCats = new Set(["auth", "api", "secrets", "idor", "prompt"]);
    for (const c of expectedCats) {
      if (!cats.has(c)) die(`expected category ${c} to be loaded, but it wasn't`);
    }
    // The library can grow without breaking this test; just assert minimums.
    if (all.total < 30) die(`expected at least 30 total payloads with all 5 categories shipped, got ${all.total}`);
    if (all.missing.length !== 0) die("expected no missing categories now that all 5 ship; got: " + JSON.stringify(all.missing));
    log(`all-load: ${all.total} payloads across ${all.loaded.length} categories`);

    /* 7. unknown category is a schema-validation error */
    let threw = false;
    try {
      await client.callTool("load_payloads", { category: "no-such-category" });
    } catch {
      threw = true;
    }
    if (!threw) die("expected unknown category to be rejected by zod enum");
    log("single-category miss correctly hard-errors: unknown enum value rejected");

    log("ALL CHECKS PASSED");
  } finally {
    client.close();
    child.kill("SIGTERM");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
