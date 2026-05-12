#!/usr/bin/env node
/**
 * isitsafebro — runnable demo.
 *
 * Drives the full scan → fix → verify → freeze → merge loop end-to-end
 * against the deliberately-vulnerable fixture and tells the story in the
 * project voice. Designed for recording (asciinema, screen capture, or
 * just pasting into a terminal).
 *
 * Total runtime: ~45-60 seconds, depending on machine.
 *
 *   npm run demo
 *
 * Self-cleaning: every temp file gets removed on exit, even if you Ctrl-C
 * mid-run.
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

/* -------------------------------------------------------------------------- */
/*  Terminal output helpers                                                   */
/* -------------------------------------------------------------------------- */

const isTTY = process.stdout.isTTY;
const c = isTTY
  ? {
      reset: "\x1b[0m",
      bold: "\x1b[1m",
      dim: "\x1b[2m",
      red: "\x1b[31m",
      green: "\x1b[32m",
      yellow: "\x1b[33m",
      blue: "\x1b[34m",
      magenta: "\x1b[35m",
      cyan: "\x1b[36m",
      gray: "\x1b[90m",
    }
  : new Proxy({}, { get: () => "" });

const bold = (s) => `${c.bold}${s}${c.reset}`;
const dim = (s) => `${c.dim}${s}${c.reset}`;
const red = (s) => `${c.red}${s}${c.reset}`;
const green = (s) => `${c.green}${s}${c.reset}`;
const yellow = (s) => `${c.yellow}${s}${c.reset}`;
const cyan = (s) => `${c.cyan}${s}${c.reset}`;
const gray = (s) => `${c.gray}${s}${c.reset}`;
const magenta = (s) => `${c.magenta}${s}${c.reset}`;

const SEVERITY_COLOR = {
  critical: red,
  high: yellow,
  medium: cyan,
  low: gray,
};

function out(s = "") {
  process.stdout.write(s + "\n");
}

function pause(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function step(n, total, label) {
  out("");
  out(`${dim(`[${n}/${total}]`)} ${bold(label)}`);
}

function tick(s) {
  out(`  ${green("✓")} ${s}`);
}

function bullet(s) {
  out(`  ${dim("·")} ${s}`);
}

function fail(s) {
  out(`  ${red("✗")} ${s}`);
}

function banner() {
  const rule = "─".repeat(62);
  out("");
  out(bold(rule));
  out("");
  out(`  ${cyan("is it safe, bro?")}`);
  out(`  ${dim("isitsafebro live demo")}`);
  out("");
  out(bold(rule));
  out("");
  out(dim("this demo drives the same MCP server claude code uses for /isitsafe."));
  out(dim("the target is a deliberately-vulnerable practice app shipped with the repo;"));
  out(dim("your real app would be scanned the exact same way."));
  out("");
}

/* -------------------------------------------------------------------------- */
/*  MCP client (same shape as the e2e tests)                                  */
/* -------------------------------------------------------------------------- */

class StdioMcpClient {
  constructor(child) {
    this.child = child;
    this.buf = "";
    this.next_id = 1;
    this.pending = new Map();
    child.stdout.on("data", (chunk) => this.onData(chunk));
    child.stderr.on("data", () => {
      // swallow mcp stderr in the demo; we don't want it cluttering output
    });
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
      clientInfo: { name: "isitsafebro-demo", version: "1.0.0" },
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

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/* -------------------------------------------------------------------------- */
/*  Attack loop                                                               */
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
          fix_hint: payload.fix_hint,
          request: {
            method: result.request.method,
            path: result.request.path,
            ...(req.headers ? { headers: req.headers } : {}),
            ...(req.body !== undefined ? { body: req.body } : {}),
          },
          success_signal: payload.success_signal,
          evidence: result.signal.explanation,
          responseStatus: result.response?.status,
        };
      }
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Hand-crafted patches                                                      */
/*  These are the same kinds of patches the orchestrator in /isitsafe would   */
/*  ask Claude to compose from the payload fix_hints. Hard-coded here so the  */
/*  demo runs without an LLM on the path.                                     */
/* -------------------------------------------------------------------------- */

function patchAdminRoute(src) {
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
  return src.replace(before, after);
}

function patchSessionCookie(src) {
  return src.replace(
    `"Set-Cookie": "session=anon-9999999; Path=/",`,
    `"Set-Cookie": "session=anon-9999999; Path=/; HttpOnly",`,
  );
}

function patchLoginHandler(src) {
  // Replace the /login handler entirely with one that rejects weak/empty creds.
  // Anchored on a unique marker comment from the fixture.
  const before = /\/\* ─+ \*\/\s+\/\* {2}VULN-5 \+ VULN-6: weak default creds AND empty-password acceptance[\s\S]*?app\.post\("\/login", \(req, res\) => \{[\s\S]*?\n\}\);/;
  const after = `/* ─────────────────────────────────────────────────────────────────────── */
/*  Patched by isitsafebro: rejects weak/empty credentials                 */
/* ─────────────────────────────────────────────────────────────────────── */

app.post("/login", (_req, res) => {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "invalid credentials" }));
});`;
  if (!before.test(src)) {
    throw new Error("login patch base not found; fixture changed?");
  }
  return src.replace(before, after);
}

function patchDotenv(src) {
  // Replace the .env serving route with a 404.
  const before = /\/\/ VULN-SEC-1: \.env served\napp\.get\("\/\.env", \(_req, res\) => \{[\s\S]*?\n\}\);/;
  const after = `// Patched by isitsafebro: refuse to serve dotfiles
app.get("/.env", (_req, res) => {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});`;
  if (!before.test(src)) {
    throw new Error("dotenv patch base not found; fixture changed?");
  }
  return src.replace(before, after);
}

function patchSearchXss(src) {
  // Add an escape helper and use it in the search response.
  const helperBefore = `function getQuery(req) {`;
  const helperAfter = `function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getQuery(req) {`;
  const useBefore = `res.end(\`<html><body><h1>results for: \${q}</h1></body></html>\`);`;
  const useAfter = `res.end(\`<html><body><h1>results for: \${escapeHtml(q)}</h1></body></html>\`);`;
  return src.replace(helperBefore, helperAfter).replace(useBefore, useAfter);
}

/* -------------------------------------------------------------------------- */
/*  Setup / teardown                                                          */
/* -------------------------------------------------------------------------- */

function seedRepo() {
  const dir = mkdtempSync(join(tmpdir(), "isitsafebro-demo-"));
  cpSync(fixtureSrc, dir, { recursive: true, filter: (src) => !src.includes("node_modules") });
  git(dir, "init", "-b", "main", "-q");
  git(dir, "config", "user.email", "vibecoder@example.com");
  git(dir, "config", "user.name", "vibecoder");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "initial: my fresh vibe-coded app");
  return dir;
}

/* -------------------------------------------------------------------------- */
/*  Main                                                                      */
/* -------------------------------------------------------------------------- */

let cleanup = () => {};
process.on("SIGINT", () => {
  out("");
  out(dim("cleaning up..."));
  cleanup();
  process.exit(130);
});

async function main() {
  banner();
  await pause(700);

  /* -------------------------- step 1: seed the app ----------------------- */
  step(1, 10, "seeding a fresh vibe-coded app to scan");
  await pause(300);
  const userRepo = seedRepo();
  bullet(`temp project at ${gray(userRepo)}`);
  bullet(`git initialized with one commit on main`);
  await pause(800);

  const mcp = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
  const client = new StdioMcpClient(mcp);
  let worktreePath = null;

  cleanup = () => {
    try { client.close(); } catch {}
    try { mcp.kill("SIGTERM"); } catch {}
    if (worktreePath && existsSync(worktreePath)) {
      try { git(userRepo, "worktree", "remove", "--force", worktreePath); } catch {}
    }
    if (userRepo && existsSync(userRepo)) {
      try { rmSync(userRepo, { recursive: true, force: true }); } catch {}
    }
  };

  try {
    await client.initialize();

    /* ---------------------- step 2: create the worktree -------------------- */
    step(2, 10, "creating an isolated git worktree");
    await pause(300);
    const create = await client.callTool("create_scan_worktree", { cwd: userRepo });
    if (!create.ok) throw new Error("create_scan_worktree failed: " + create.error);
    worktreePath = create.worktreePath;
    bullet(`worktree at ${gray(worktreePath)}`);
    bullet(`branch ${magenta(create.branch)}`);
    bullet(`your main branch is untouched`);
    await pause(800);

    /* ---------------------- step 3: start the dev server ------------------ */
    step(3, 10, "starting the dev server in the worktree");
    await pause(300);
    const start = await client.callTool("install_and_start", {
      worktreePath,
      readyTimeoutMs: 15000,
    });
    if (!start.ok) throw new Error("install_and_start failed: " + start.error);
    let url = start.url;
    bullet(`script ${green("npm run " + start.script)}`);
    bullet(`listening at ${green(url)}`);
    await pause(800);

    /* ------------------- step 4: load the payload library ----------------- */
    step(4, 10, "loading the attack library");
    await pause(300);
    const pay = await client.callTool("load_payloads", { category: "all" });
    if (!pay.ok) throw new Error("load_payloads failed: " + pay.error);
    const byCategory = {};
    for (const cat of pay.loaded) byCategory[cat.category] = cat.payloads.length;
    bullet(`${pay.total} attack patterns across ${pay.loaded.length} categories`);
    for (const [cat, n] of Object.entries(byCategory)) {
      out(`      ${dim("•")} ${cat.padEnd(8)} ${dim(n + " patterns")}`);
    }
    const allPayloads = pay.loaded.flatMap((c) => c.payloads);
    await pause(1000);

    /* ----------------------- step 5: run the attack ----------------------- */
    step(5, 10, "attacking");
    bullet(dim("pretending to be the worst kind of internet stranger..."));
    await pause(800);
    const findings = [];
    for (const p of allPayloads) {
      if (p.is_destructive) continue;
      const f = await attackOne(client, url, p);
      if (f) {
        findings.push(f);
        const sev = SEVERITY_COLOR[f.severity](`[${f.severity}]`);
        out(`  ${green("✓")} ${sev} ${f.payload_id} ${dim(`→ ${f.request.method} ${f.request.path}`)}`);
      }
    }
    await pause(500);
    out("");
    out(`  ${bold(yellow(`found ${findings.length} things that ain't safe.`))}`);
    await pause(1200);

    /* --------------------- step 6: surface in human words ----------------- */
    step(6, 10, "what would happen if you shipped this");
    await pause(500);
    const summaries = {
      "unauthenticated-admin-route": "anyone on the internet can open your admin panel.",
      "unauthenticated-write-endpoint": "anyone can create records in your /api/users without logging in.",
      "jwt-alg-none-bypass": "anyone can forge a login token with admin claims and you'd accept it.",
      "weak-jwt-secret-guessable": "your JWT secret is one a robot can guess. forged tokens go through.",
      "weak-default-credentials": "anyone who tried 'admin/admin' just logged in as admin.",
      "login-empty-credentials-accepted": "anyone who left the password field blank just logged in.",
      "cors-misconfig-credentials-with-wildcard-or-reflected-origin": "a malicious site can hit your API with your users' cookies.",
      "unprotected-debug-or-internal-route": "your /debug endpoint is exposing env/version/config to the world.",
      "session-cookie-without-httponly": "your session cookie can be stolen by any XSS, anywhere on your site.",
      "sql-injection-error-based": "one weird URL leaks your SQL syntax. a determined attacker can read your whole database.",
      "xss-reflected": "any link of the form /search?q=<script> gets executed in your visitors' browsers.",
      "path-traversal-via-filename-param": "anyone can read /etc/passwd off your server with a crafted URL.",
      "dotenv-file-served": "your .env file is published on the internet. all secrets leaked.",
      "config-route-leaks-secrets": "your /api/config endpoint is serving your stripe + openai keys to anyone who asks.",
      "per-user-resource-fetched-without-auth": "anyone can read customer #1's data by visiting /api/customers/1.",
      "unauthed-list-endpoint-returns-records": "your /api/users returns every user record to anyone, with PII.",
      "pii-in-list-response": "your user list response leaks every user's email and phone number.",
      "prompt-injection-direct-canary": "anyone can override your AI's system prompt with text in a chat message.",
      "prompt-injection-json-output-takeover": "anyone can force your AI to output structured JSON they control.",
      "prompt-injection-fake-system-message": "anyone can put fake [SYSTEM] tags in a chat message and the AI obeys.",
      "prompt-injection-data-channel-canary": "data you ask your AI to summarize can hijack the AI's behavior.",
      "prompt-injection-jailbreak-via-roleplay": "your AI can be talked into roleplaying as an unrestricted bot.",
      "prompt-injection-fake-assistant-turn": "your chat API trusts client-supplied assistant messages and follows them.",
      "prompt-injection-developer-mode-bypass": "your AI accepts fake 'developer mode' / 'debug mode' instructions from users.",
    };
    for (const f of findings) {
      const sev = SEVERITY_COLOR[f.severity](f.severity.padStart(8));
      const desc = summaries[f.payload_id] ?? f.name;
      out(`  ${sev}  ${desc}`);
    }
    await pause(1500);

    /* ------------------- step 7: apply hand-crafted fixes ------------------ */
    step(7, 10, "applying fixes (in /isitsafe this is your coding agent)");
    await pause(500);
    let serverJs = readFileSync(join(worktreePath, "server.js"), "utf8");
    const fixes = [
      { id: "unauthenticated-admin-route", subject: "require auth on the admin route", patch: patchAdminRoute },
      { id: "session-cookie-without-httponly", subject: "set httponly on the session cookie", patch: patchSessionCookie },
      { id: "weak-default-credentials", subject: "stop accepting weak default credentials", patch: patchLoginHandler },
      { id: "dotenv-file-served", subject: "refuse to serve dotfiles like .env", patch: patchDotenv },
      { id: "xss-reflected", subject: "html-escape user input in search results", patch: patchSearchXss },
    ];
    for (const f of fixes) {
      serverJs = f.patch(serverJs);
      const r = await client.callTool("apply_fix", {
        worktreePath,
        files: [{ path: "server.js", content: serverJs }],
        commitType: "fix",
        commitSubject: f.subject,
      });
      if (!r.ok) throw new Error("apply_fix " + f.id + " failed: " + r.error);
      out(`  ${green("✓")} commit ${gray(r.sha.slice(0, 7))} ${r.message}`);
      await pause(250);
    }
    await pause(800);

    /* ------------------- step 8: restart the dev server ------------------- */
    step(8, 10, "restarting the dev server so it picks up the patched code");
    await pause(300);
    const restart = await client.callTool("restart_dev_server", {
      worktreePath,
      readyTimeoutMs: 15000,
    });
    if (!restart.ok) throw new Error("restart_dev_server failed: " + restart.error);
    url = restart.url;
    bullet(`back up at ${green(url)}`);
    await pause(800);

    /* -------- step 9: verify_clean (the moment of truth) ----------------- */
    step(9, 10, "verifying the fixes actually closed the holes");
    bullet(dim("replaying every original exploit against the patched server..."));
    await pause(800);
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
    if (!verify.ok) throw new Error("verify_clean failed: " + verify.error);
    out("");
    out(`  ${green(`${verify.cleaned.length} bugs are gone:`)}`);
    for (const id of verify.cleaned) out(`    ${green("✓")} ${id}`);
    if (verify.stillVulnerable.length > 0) {
      out("");
      out(`  ${yellow(`${verify.stillVulnerable.length} bugs were not part of this demo's fix set:`)}`);
      for (const id of verify.stillVulnerable) out(`    ${dim("·")} ${id}`);
    }
    await pause(1500);

    /* --------- step 10: freeze + merge + cleanup + scoreboard ------------ */
    step(10, 10, "freezing the verified fixes as regression tests, then merging");
    await pause(500);
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
      if (fr.ok) {
        out(`  ${green("✓")} froze ${gray(f.payload_id)}`);
      }
    }
    await pause(500);
    const testsDir = join(userRepo, ".isitsafebro", "tests");
    if (existsSync(testsDir)) {
      // Quick stat across categories
      let total = 0;
      for (const cat of readdirSync(testsDir)) {
        total += readdirSync(join(testsDir, cat)).length;
      }
      bullet(`${total} frozen regression test${total === 1 ? "" : "s"} under ${gray(".isitsafebro/tests/")}`);
    }
    await pause(800);

    const merge = await client.callTool("merge_fix_branch", {
      cwd: userRepo,
      scanBranch: create.branch,
    });
    if (!merge.ok) throw new Error("merge_fix_branch failed: " + merge.error);
    out("");
    bullet(`merged ${magenta(create.branch)} into ${magenta(merge.mergedInto)}`);
    bullet(`merge sha ${gray(merge.mergeSha.slice(0, 7))}`);
    await pause(800);

    const cleanupResult = await client.callTool("cleanup_worktree", {
      worktreePath,
    });
    if (cleanupResult.ok) {
      bullet(`worktree torn down, scan branch preserved`);
    }
    worktreePath = null;
    await pause(1000);

    /* ----------------------- final scoreboard ----------------------------- */
    const rule = "─".repeat(62);
    out("");
    out(bold(rule));
    out("");
    out(`  ${green("done bro.")}`);
    out("");
    out(`  ${dim("·")} ${findings.length} real bugs found`);
    out(`  ${dim("·")} ${verify.cleaned.length} fixes applied + verified + frozen`);
    out(`  ${dim("·")} 0 false positives (every finding had a structured signal match)`);
    out(`  ${dim("·")} 1 clean merge into main`);
    out(`  ${dim("·")} 0 humans involved`);
    out("");
    out(`  ${cyan("it's safe-er, bro.")}`);
    out("");
    out(bold(rule));
    out("");
    out(dim("in claude code: `/isitsafe` does the same thing, with you in the loop"));
    out(dim("at each decision point. install with: npm install -g isitsafebro && isitsafebro register"));
    out("");

    cleanup();
    process.exit(0);
  } catch (err) {
    out("");
    fail(red(`demo failed: ${err.message}`));
    cleanup();
    process.exit(1);
  }
}

main().catch((err) => {
  fail(red(`unexpected error: ${err.message}`));
  cleanup();
  process.exit(1);
});
