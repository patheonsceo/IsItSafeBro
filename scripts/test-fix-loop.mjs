#!/usr/bin/env node
/**
 * End-to-end fix-loop test.
 *
 * Drives the FULL scan → fix → verify → freeze → merge loop through the
 * real MCP server against the deliberately-vulnerable fixture:
 *
 *   1. seed a temp git repo from test-fixtures/vuln-app/
 *   2. mcp: create_scan_worktree
 *   3. mcp: install_and_start
 *   4. mcp: load_payloads(auth) and run the attack loop until we have
 *      a few real findings
 *   5. for two specific findings (unauthenticated-admin-route and
 *      session-cookie-without-httponly), build hand-crafted patches by
 *      reading the worktree's server.js, applying string substitutions,
 *      and sending the new file content via apply_fix. ONE apply_fix
 *      call per fix → one commit per fix on the scan branch.
 *   6. mcp: restart_dev_server picks up the patched code
 *   7. mcp: verify_clean replays the original findings against the
 *      restarted server. assert: the two FIXED bugs are in cleaned[];
 *      at least one untouched bug is in stillVulnerable[].
 *   8. mcp: freeze_test serializes each cleaned finding into the user's
 *      project root at .isitsafebro/tests/<category>/...
 *   9. mcp: merge_fix_branch lands the scan branch into main. verify
 *      via git log.
 *  10. mcp: cleanup_worktree
 *
 * Run with: npm run test:e2e:fix
 */
import { spawn, execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "..");
const serverPath = join(repoRoot, "dist", "mcp", "server.js");
const fixtureSrc = join(repoRoot, "test-fixtures", "vuln-app");

function log(...args) {
  console.log("[test-fix-loop]", ...args);
}
function die(msg) {
  console.error("[test-fix-loop] FAIL:", msg);
  process.exit(1);
}
function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/* -------------------------------------------------------------------------- */
/*  MCP client (same pattern as the other e2es)                               */
/* -------------------------------------------------------------------------- */

class StdioMcpClient {
  constructor(child) {
    this.child = child;
    this.buf = "";
    this.next_id = 1;
    this.pending = new Map();
    child.stdout.on("data", (chunk) => this.onData(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(`[mcp] ${chunk}`));
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
      clientInfo: { name: "test-fix-loop", version: "1.0.0" },
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
/*  Fixture seeding                                                           */
/* -------------------------------------------------------------------------- */

function seedRepo() {
  const dir = mkdtempSync(join(tmpdir(), "isitsafebro-fix-loop-"));
  cpSync(fixtureSrc, dir, { recursive: true, filter: (src) => !src.includes("node_modules") });
  git(dir, "init", "-b", "main", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

/* -------------------------------------------------------------------------- */
/*  Attack loop (copied from test-attack.mjs, trimmed)                        */
/* -------------------------------------------------------------------------- */

function mergeRequest(base, variation) {
  const merged = { ...base, ...variation };
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
          category: payload.category,
          severity: payload.severity,
          name: payload.name,
          description: payload.description,
          request: {
            method: result.request.method,
            path: result.request.path,
            ...(req.headers ? { headers: req.headers } : {}),
            ...(req.body !== undefined ? { body: req.body } : {}),
          },
          success_signal: payload.success_signal,
          evidence: result.signal.explanation,
        };
      }
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Hand-crafted patches                                                      */
/* -------------------------------------------------------------------------- */

function applyAdminAuthPatch(serverJs) {
  // VULN-1 in the fixture: /admin returns 200 with admin-y body. Fix: 401
  // with a sign-in prompt. The signal then fails because the body no longer
  // contains 'admin panel' (or contains 'sign in', which is in the body_not).
  const before = `app.get("/admin", (_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(
    "<html><body><h1>admin panel</h1><div>user list: alice, bob, charlie</div><p>settings · manage users</p></body></html>",
  );
});`;
  const after = `app.get("/admin", (_req, res) => {
  res.writeHead(401, { "Content-Type": "text/html" });
  res.end(
    "<html><body><h1>please log in</h1><p>unauthorized</p></body></html>",
  );
});`;
  if (!serverJs.includes(before)) {
    throw new Error("admin-route patch base content not found; fixture changed?");
  }
  return serverJs.replace(before, after);
}

function applyHttponlyPatch(serverJs) {
  // VULN-9: session cookie missing HttpOnly on GET /. Fix: add HttpOnly.
  const before = `"Set-Cookie": "session=anon-9999999; Path=/",`;
  const after = `"Set-Cookie": "session=anon-9999999; Path=/; HttpOnly",`;
  if (!serverJs.includes(before)) {
    throw new Error("httponly patch base content not found; fixture changed?");
  }
  return serverJs.replace(before, after);
}

/* -------------------------------------------------------------------------- */
/*  Main                                                                      */
/* -------------------------------------------------------------------------- */

async function main() {
  const userRepo = seedRepo();
  log("seeded user repo:", userRepo);

  const mcp = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
  const client = new StdioMcpClient(mcp);

  let worktreePath = null;
  let url = null;

  try {
    await client.initialize();

    /* 1. create the scan worktree */
    const create = await client.callTool("create_scan_worktree", { cwd: userRepo });
    if (!create.ok) die("create_scan_worktree failed: " + JSON.stringify(create));
    worktreePath = create.worktreePath;
    const scanBranch = create.branch;
    log("worktree:", worktreePath, "branch:", scanBranch);

    /* 2. start the dev server in the worktree */
    const start = await client.callTool("install_and_start", {
      worktreePath,
      readyTimeoutMs: 15_000,
    });
    if (!start.ok) die("install_and_start failed: " + JSON.stringify(start));
    url = start.url;
    log("dev server up:", url);

    /* 3. load auth payloads */
    const pay = await client.callTool("load_payloads", { category: "auth" });
    if (!pay.ok) die("load_payloads failed: " + JSON.stringify(pay));
    const payloads = pay.loaded[0].payloads;
    log("loaded", payloads.length, "auth payloads");

    /* 4. run the attack loop, capture findings */
    const findings = [];
    for (const p of payloads) {
      if (p.is_destructive) continue;
      const f = await attackOne(client, url, p);
      if (f) findings.push(f);
    }
    log("attack produced", findings.length, "findings");
    const foundIds = new Set(findings.map((f) => f.payload_id));
    if (!foundIds.has("unauthenticated-admin-route")) {
      die("scan missed unauthenticated-admin-route");
    }
    if (!foundIds.has("session-cookie-without-httponly")) {
      die("scan missed session-cookie-without-httponly");
    }

    /* 5. apply two hand-crafted fixes, one per apply_fix call */
    let serverJs = readFileSync(join(worktreePath, "server.js"), "utf8");

    serverJs = applyAdminAuthPatch(serverJs);
    let r = await client.callTool("apply_fix", {
      worktreePath,
      files: [{ path: "server.js", content: serverJs }],
      commitType: "fix",
      commitSubject: "require auth on the admin route",
    });
    if (!r.ok) die("apply_fix #1 failed: " + JSON.stringify(r));
    log("commit 1:", r.sha.slice(0, 7), r.message);

    serverJs = applyHttponlyPatch(serverJs);
    r = await client.callTool("apply_fix", {
      worktreePath,
      files: [{ path: "server.js", content: serverJs }],
      commitType: "fix",
      commitSubject: "set httponly on the session cookie",
    });
    if (!r.ok) die("apply_fix #2 failed: " + JSON.stringify(r));
    log("commit 2:", r.sha.slice(0, 7), r.message);

    /* 6. restart so the running server picks up the patched code */
    const restart = await client.callTool("restart_dev_server", {
      worktreePath,
      readyTimeoutMs: 15_000,
    });
    if (!restart.ok) die("restart_dev_server failed: " + JSON.stringify(restart));
    url = restart.url;
    log("server restarted:", url);

    /* 7. verify_clean against ALL captured findings */
    const verifyInput = findings.map((f) => ({
      id: f.payload_id,
      request: f.request,
      success_signal: f.success_signal,
    }));
    const verify = await client.callTool("verify_clean", {
      url,
      findings: verifyInput,
      timeoutMs: 5000,
    });
    if (!verify.ok) die("verify_clean failed: " + JSON.stringify(verify));
    log(
      `verify_clean: cleaned=${verify.cleaned.length} stillVulnerable=${verify.stillVulnerable.length}`,
    );
    log("  cleaned:", verify.cleaned.join(", "));
    log("  stillVulnerable:", verify.stillVulnerable.join(", "));

    if (!verify.cleaned.includes("unauthenticated-admin-route")) {
      die("expected unauthenticated-admin-route in cleaned[] after fix; got: " + verify.cleaned.join(", "));
    }
    if (!verify.cleaned.includes("session-cookie-without-httponly")) {
      die("expected session-cookie-without-httponly in cleaned[] after fix");
    }
    if (verify.stillVulnerable.length === 0) {
      die("expected at least one untouched bug to remain stillVulnerable; got empty");
    }
    log("verify assertions: fixed bugs are gone, untouched bugs still match — ok");

    /* 8. freeze the cleaned findings into the user's project root */
    const cleanedFindings = findings.filter((f) => verify.cleaned.includes(f.payload_id));
    for (const f of cleanedFindings) {
      const fr = await client.callTool("freeze_test", {
        cwd: userRepo,
        finding: {
          payload_id: f.payload_id,
          category: f.category,
          severity: f.severity,
          name: f.name,
          description: f.description,
          request: f.request,
          success_signal: f.success_signal,
          evidence: f.evidence,
        },
      });
      if (!fr.ok) die("freeze_test failed for " + f.payload_id + ": " + JSON.stringify(fr));
    }
    const testsDir = join(userRepo, ".isitsafebro", "tests", "auth");
    if (!existsSync(testsDir)) die("frozen tests dir not created: " + testsDir);
    const files = readdirSync(testsDir);
    if (files.length !== 2) die(`expected 2 frozen test files, got ${files.length}: ${files.join(", ")}`);
    log("frozen", files.length, "regression tests at .isitsafebro/tests/auth/");

    /* 9. merge the scan branch into main */
    const merge = await client.callTool("merge_fix_branch", {
      cwd: userRepo,
      scanBranch,
    });
    if (!merge.ok) die("merge_fix_branch failed: " + JSON.stringify(merge));
    log("merge sha:", merge.mergeSha.slice(0, 7), "into", merge.mergedInto);

    // Confirm git log on main shows both fix commits + the merge commit
    const logOut = git(userRepo, "log", "--oneline", "-5").trim().split("\n");
    if (!logOut.some((l) => /fix: require auth on the admin route/.test(l))) {
      die("git log missing 'require auth on the admin route' commit:\n" + logOut.join("\n"));
    }
    if (!logOut.some((l) => /fix: set httponly on the session cookie/.test(l))) {
      die("git log missing 'set httponly on the session cookie' commit");
    }
    if (!logOut.some((l) => /merge isitsafebro fixes/.test(l))) {
      die("git log missing the merge commit");
    }
    log("git log on main shows both fixes + the merge commit");

    /* 10. cleanup */
    const cleanup = await client.callTool("cleanup_worktree", {
      worktreePath,
    });
    if (!cleanup.ok) die("cleanup_worktree failed: " + JSON.stringify(cleanup));
    if (existsSync(worktreePath)) die("worktree dir still exists after cleanup");
    log("cleanup ok: worktree gone, scan branch preserved");

    log("ALL CHECKS PASSED — full scan→fix→verify→freeze→merge loop works end-to-end");
    process.stdout.write("\nFROZEN TESTS:\n");
    for (const f of files) {
      const content = readFileSync(join(testsDir, f), "utf8");
      const record = JSON.parse(content);
      process.stdout.write(`\n${f}\n`);
      process.stdout.write(`  payload_id: ${record.payload_id}\n`);
      process.stdout.write(`  severity:   ${record.severity}\n`);
      process.stdout.write(`  endpoint:   ${record.request.method} ${record.request.path}\n`);
      process.stdout.write(`  frozen_at:  ${record.frozen_at}\n`);
    }
  } finally {
    client.close();
    mcp.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    if (worktreePath && existsSync(worktreePath)) {
      try {
        git(userRepo, "worktree", "remove", "--force", worktreePath);
      } catch {}
    }
    if (userRepo) {
      try {
        rmSync(userRepo, { recursive: true, force: true });
      } catch {}
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
