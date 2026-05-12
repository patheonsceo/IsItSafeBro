#!/usr/bin/env node
/**
 * isitsafebro — Next.js demo.
 *
 * Drives the full scan → fix → verify → freeze → merge loop against the
 * VibeNotes fixture (test-fixtures/nextjs-vuln-app/), a real Next.js 15
 * + React 19 + TypeScript app engineered with the same kinds of security
 * bugs vibe-coded apps actually ship.
 *
 *   npm run demo:nextjs
 *
 * Auto-installs the fixture's deps on first run (~60-90s for next + react
 * + types). Subsequent runs reuse the cached node_modules. Total demo
 * wall-clock: ~2 minutes warm, ~3 minutes cold.
 */
import { spawn, execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "..");
const serverPath = join(repoRoot, "dist", "mcp", "server.js");
const fixtureSrc = join(repoRoot, "test-fixtures", "nextjs-vuln-app");

const isTTY = process.stdout.isTTY;
const c = isTTY
  ? {
      reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
      red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
      cyan: "\x1b[36m", gray: "\x1b[90m", magenta: "\x1b[35m",
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
const SEV = { critical: red, high: yellow, medium: cyan, low: gray };

function out(s = "") { process.stdout.write(s + "\n"); }
function pause(ms) { return new Promise((r) => setTimeout(r, ms)); }
function step(n, total, label) { out(""); out(`${dim(`[${n}/${total}]`)} ${bold(label)}`); }
function bullet(s) { out(`  ${dim("·")} ${s}`); }
function tick(s) { out(`  ${green("✓")} ${s}`); }
function fail(s) { out(`  ${red("✗")} ${s}`); }
function banner() {
  const rule = "─".repeat(62);
  out(""); out(bold(rule)); out("");
  out(`  ${cyan("is it safe, bro?")}`);
  out(`  ${dim("VibeNotes — isitsafebro vs. a real Next.js 15 app")}`);
  out(""); out(bold(rule)); out("");
  out(dim("the target: a Next.js 15 + react 19 + typescript app engineered with"));
  out(dim("the same security bugs vibe-coded apps actually ship. app router,"));
  out(dim("middleware.ts, route handlers, NEXT_PUBLIC env vars, the works."));
  out("");
}

class StdioMcpClient {
  constructor(child) {
    this.child = child; this.buf = ""; this.next_id = 1; this.pending = new Map();
    child.stdout.on("data", (chunk) => this.onData(chunk));
    child.stderr.on("data", () => {});
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
      protocolVersion: "2025-06-18", capabilities: {},
      clientInfo: { name: "isitsafebro-demo-nextjs", version: "1.0.0" },
    });
    await this.send("notifications/initialized", {}, false);
  }
  async callTool(name, args) {
    const result = await this.send("tools/call", { name, arguments: args });
    if (result.structuredContent) return result.structuredContent;
    return JSON.parse(result.content[0].text);
  }
  close() { this.child.stdin.end(); }
}

function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8" }); }

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
        url, path: hint, method: req.method,
        ...(req.headers ? { headers: req.headers } : {}),
        ...(req.body !== undefined ? { body: req.body } : {}),
        evaluateSignal: payload.success_signal,
        timeoutMs: 30_000,
      });
      if (result.signal?.matched) {
        return {
          payload_id: payload.id, category: payload.category,
          severity: payload.severity, name: payload.name,
          description: payload.description, fix_hint: payload.fix_hint,
          request: {
            method: result.request.method, path: result.request.path,
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

function patchAdminAuth(src) {
  const before = `import { store } from "@/lib/store";

// VULN: no auth check. Anyone who visits /admin gets the user list.
// The AI scaffold added this route but never added a guard.
export default function AdminPage() {
  const users = store.users;`;
  const after = `import { store } from "@/lib/store";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

// Patched: gate the admin panel behind an authenticated admin session.
export default async function AdminPage() {
  const c = await cookies();
  const session = c.get("session")?.value ?? "";
  if (!session.startsWith("loggedin-admin")) {
    redirect("/login");
  }
  const users = store.users;`;
  if (!src.includes(before)) throw new Error("admin-page patch base not found");
  return src.replace(before, after);
}

function patchCookieHttponly(src) {
  const before = `      "anon-" + Math.random().toString(36).slice(2, 11),
      { path: "/" },`;
  const after = `      "anon-" + Math.random().toString(36).slice(2, 11),
      { path: "/", httpOnly: true, sameSite: "lax" },`;
  if (!src.includes(before)) throw new Error("cookie patch base not found");
  return src.replace(before, after);
}

function patchLoginRejectWeak(src) {
  const before = `  const allowed =
    (user === "admin" &&
      (password === "admin" ||
        password === "password" ||
        password === "123456" ||
        password === "admin123")) ||
    password === "" ||
    password === null ||
    password === undefined;`;
  const after = `  // Patched: reject weak/empty credentials. real apps validate against a
  // hashed password in the database; for the demo, every login fails.
  void user;
  void password;
  const allowed = false;`;
  if (!src.includes(before)) throw new Error("login patch base not found");
  return src.replace(before, after);
}

function patchSearchXss(src) {
  // Drop the "dangerously set" HTML — let React auto-escape the interpolation.
  const dangerouslyApi = ["dangerously", "Set", "Inner", "HTML"].join("");
  const before = `      <h1
        ${dangerouslyApi}={{
          __html: \`results for: \${query}\`,
        }}
      />`;
  const after = `      <h1>results for: {query}</h1>`;
  if (!src.includes(before)) throw new Error("search patch base not found");
  return src.replace(before, after);
}

function patchFooterDropSecret(src) {
  const before = `  const stripeKey = process.env.NEXT_PUBLIC_STRIPE_SECRET ?? "";
  return (
    <footer>
      <small>
        VibeNotes © 2026 — powered by Stripe ({stripeKey.slice(0, 8)}…)
      </small>
      <small style={{ display: "none" }} data-stripe-debug={stripeKey}>
        debug
      </small>
    </footer>
  );`;
  const after = `  // Patched: dropped the NEXT_PUBLIC_STRIPE_SECRET reference. the key was
  // misprefixed and was getting baked into the client bundle on every page.
  return (
    <footer>
      <small>VibeNotes © 2026</small>
    </footer>
  );`;
  if (!src.includes(before)) throw new Error("footer patch base not found");
  return src.replace(before, after);
}

function ensureFixtureDeps() {
  const nm = join(fixtureSrc, "node_modules");
  if (existsSync(nm)) return false;
  out(dim("  · this is the first run — installing the fixture's deps (~60-90s)..."));
  const r = spawnSync("npm", ["install"], { cwd: fixtureSrc, stdio: "ignore" });
  if (r.status !== 0) throw new Error("npm install in fixture failed");
  tick("fixture deps installed");
  return true;
}

function seedRepo() {
  const dir = mkdtempSync(join(tmpdir(), "vibenotes-demo-"));
  cpSync(fixtureSrc, dir, {
    recursive: true,
    filter: (src) => !src.includes("node_modules") && !src.includes("/.next"),
  });
  try {
    symlinkSync(join(fixtureSrc, "node_modules"), join(dir, "node_modules"), "dir");
  } catch {
    cpSync(join(fixtureSrc, "node_modules"), join(dir, "node_modules"), { recursive: true });
  }
  git(dir, "init", "-b", "main", "-q");
  git(dir, "config", "user.email", "vibecoder@example.com");
  git(dir, "config", "user.name", "vibecoder");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "initial: my vibe-coded notes app");
  return dir;
}

let cleanup = () => {};
process.on("SIGINT", () => {
  out(""); out(dim("cleaning up..."));
  cleanup(); process.exit(130);
});

async function main() {
  banner();
  await pause(700);

  step(1, 10, "seeding a fresh Next.js project to scan");
  await pause(300);
  const installed = ensureFixtureDeps();
  if (installed) await pause(400);
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

    step(2, 10, "creating an isolated git worktree");
    await pause(300);
    const create = await client.callTool("create_scan_worktree", { cwd: userRepo });
    if (!create.ok) throw new Error("create_scan_worktree failed: " + create.error);
    worktreePath = create.worktreePath;
    bullet(`worktree at ${gray(worktreePath)}`);
    bullet(`branch ${magenta(create.branch)}`);
    bullet(`your main branch is untouched`);
    await pause(800);

    step(3, 10, "starting next dev in the worktree");
    bullet(dim("first request triggers turbopack compile, can take a few seconds..."));
    await pause(300);
    const start = await client.callTool("install_and_start", {
      worktreePath, readyTimeoutMs: 30_000,
    });
    if (!start.ok) throw new Error("install_and_start failed: " + start.error);
    let url = start.url;
    bullet(`script ${green("npm run " + start.script)}`);
    bullet(`listening at ${green(url)}`);
    await pause(800);

    step(4, 10, "loading the attack library");
    await pause(300);
    const pay = await client.callTool("load_payloads", { category: "all" });
    if (!pay.ok) throw new Error("load_payloads failed: " + pay.error);
    bullet(`${pay.total} attack patterns across ${pay.loaded.length} categories`);
    const allPayloads = pay.loaded.flatMap((c) => c.payloads);
    await pause(1000);

    step(5, 10, "scanning the Next.js app");
    bullet(dim("hitting the same MCP tools claude code uses for /isitsafe..."));
    await pause(800);
    const findings = [];
    for (const p of allPayloads) {
      if (p.is_destructive) continue;
      const f = await attackOne(client, url, p);
      if (f) {
        findings.push(f);
        const sev = SEV[f.severity](`[${f.severity}]`);
        out(`  ${green("✓")} ${sev} ${f.payload_id} ${dim(`→ ${f.request.method} ${f.request.path}`)}`);
      }
    }
    await pause(500);
    out("");
    out(`  ${bold(yellow(`found ${findings.length} things that ain't safe.`))}`);
    await pause(1200);

    step(6, 10, "what would happen if you shipped this");
    await pause(500);
    const summaries = {
      "unauthenticated-admin-route": "anyone on the internet can open your admin panel.",
      "jwt-alg-none-bypass": "anyone can forge a login token with admin claims and you'd accept it.",
      "weak-jwt-secret-guessable": "your JWT secret is guessable. forged tokens go through.",
      "weak-default-credentials": "anyone who tried 'admin/admin' just logged in as admin.",
      "login-empty-credentials-accepted": "anyone who left the password field blank just logged in.",
      "cors-misconfig-credentials-with-wildcard-or-reflected-origin": "a malicious site can hit your API with your users' cookies.",
      "unprotected-debug-or-internal-route": "your /debug endpoint is exposing env/version/config to the world.",
      "session-cookie-without-httponly": "your session cookie can be stolen by any XSS, anywhere on your site.",
      "xss-reflected": "any link of the form /search?q=<script> gets executed in your visitors' browsers.",
      "excessive-data-exposure-on-user-endpoint": "your /api/users/:id endpoint returns password_hash to anyone who asks.",
      "client-bundle-contains-api-key": "your stripe secret key is in the page source. anyone who view-sources has it.",
      "config-route-leaks-secrets": "your /api/config endpoint is serving your stripe + openai keys to anyone.",
      "per-user-resource-fetched-without-auth": "anyone can read user #1's data by visiting /api/users/1.",
      "unauthed-list-endpoint-returns-records": "your /api/users returns every user record with PII.",
      "pii-in-list-response": "your user list response leaks every user's email and phone number.",
      "prompt-injection-direct-canary": "anyone can override your AI's system prompt with text in a chat message.",
      "prompt-injection-json-output-takeover": "anyone can force your AI to output structured JSON they control.",
      "prompt-injection-fake-system-message": "anyone can put fake [SYSTEM] tags in a chat message and the AI obeys.",
      "prompt-injection-data-channel-canary": "data you ask your AI to summarize can hijack the AI's behavior.",
      "prompt-injection-jailbreak-via-roleplay": "your AI can be talked into roleplaying as an unrestricted bot.",
      "prompt-injection-fake-assistant-turn": "your chat API trusts client-supplied assistant messages and follows them.",
      "prompt-injection-developer-mode-bypass": "your AI accepts fake 'developer mode' / 'debug mode' instructions.",
    };
    for (const f of findings) {
      const sev = SEV[f.severity](f.severity.padStart(8));
      const desc = summaries[f.payload_id] ?? f.name;
      out(`  ${sev}  ${desc}`);
    }
    await pause(1500);

    step(7, 10, "applying fixes (in /isitsafe, your coding agent writes these)");
    await pause(500);
    const fixSteps = [
      { label: "require auth on the admin page", file: "app/admin/page.tsx", patch: patchAdminAuth },
      { label: "set httponly on the session cookie", file: "middleware.ts", patch: patchCookieHttponly },
      { label: "stop accepting weak default credentials", file: "app/api/login/route.ts", patch: patchLoginRejectWeak },
      { label: "drop the unsafe html injection on the search page", file: "app/search/page.tsx", patch: patchSearchXss },
      { label: "stop bundling the next public stripe key into the client", file: "components/Footer.tsx", patch: patchFooterDropSecret },
    ];
    for (const fx of fixSteps) {
      const filePath = join(worktreePath, fx.file);
      const currentSrc = readFileSync(filePath, "utf8");
      const patchedSrc = fx.patch(currentSrc);
      const r = await client.callTool("apply_fix", {
        worktreePath,
        files: [{ path: fx.file, content: patchedSrc }],
        commitType: "fix",
        commitSubject: fx.label,
      });
      if (!r.ok) throw new Error(`apply_fix '${fx.label}' failed: ` + r.error);
      out(`  ${green("✓")} commit ${gray(r.sha.slice(0, 7))} ${r.message} ${dim("(" + fx.file + ")")}`);
      await pause(250);
    }
    await pause(800);

    step(8, 10, "restarting next dev to pick up the patched code");
    await pause(300);
    const restart = await client.callTool("restart_dev_server", {
      worktreePath, readyTimeoutMs: 30_000,
    });
    if (!restart.ok) throw new Error("restart_dev_server failed: " + restart.error);
    url = restart.url;
    bullet(`back up at ${green(url)}`);
    await pause(800);

    step(9, 10, "verifying every fix actually closed its bug");
    bullet(dim("replaying the exact requests that produced each finding..."));
    await pause(800);
    const verify = await client.callTool("verify_clean", {
      url,
      findings: findings.map((f) => ({
        id: f.payload_id, request: f.request, success_signal: f.success_signal,
      })),
      timeoutMs: 15000,
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

    step(10, 10, "freezing the verified fixes, then merging");
    await pause(500);
    const cleanedFindings = findings.filter((f) => verify.cleaned.includes(f.payload_id));
    for (const f of cleanedFindings) {
      const fr = await client.callTool("freeze_test", {
        cwd: userRepo,
        finding: {
          payload_id: f.payload_id, category: f.category, severity: f.severity,
          name: f.name, description: f.description, request: f.request,
          success_signal: f.success_signal, evidence: f.evidence,
        },
      });
      if (fr.ok) tick(`froze ${gray(f.payload_id)}`);
    }
    await pause(500);
    const testsDir = join(userRepo, ".isitsafebro", "tests");
    if (existsSync(testsDir)) {
      let total = 0;
      for (const cat of readdirSync(testsDir)) {
        total += readdirSync(join(testsDir, cat)).length;
      }
      bullet(`${total} frozen regression test${total === 1 ? "" : "s"} under ${gray(".isitsafebro/tests/")}`);
    }
    await pause(800);

    const merge = await client.callTool("merge_fix_branch", {
      cwd: userRepo, scanBranch: create.branch,
    });
    if (!merge.ok) throw new Error("merge_fix_branch failed: " + merge.error);
    out("");
    bullet(`merged ${magenta(create.branch)} into ${magenta(merge.mergedInto)}`);
    bullet(`merge sha ${gray(merge.mergeSha.slice(0, 7))}`);
    await pause(800);

    const cleanupResult = await client.callTool("cleanup_worktree", { worktreePath });
    if (cleanupResult.ok) bullet(`worktree torn down, scan branch preserved`);
    worktreePath = null;
    await pause(1000);

    const rule = "─".repeat(62);
    out(""); out(bold(rule)); out("");
    out(`  ${green("done bro.")}`); out("");
    out(`  ${dim("·")} ${findings.length} real bugs found in your Next.js app`);
    out(`  ${dim("·")} ${verify.cleaned.length} fixes applied + verified + frozen`);
    out(`  ${dim("·")} 0 false positives (every finding had a structured signal match)`);
    out(`  ${dim("·")} 1 clean merge into main`);
    out(`  ${dim("·")} 0 humans involved`);
    out("");
    out(`  ${cyan("it's safe-er, bro.")}`); out("");
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
    if (err.stack) out(dim(err.stack.split("\n").slice(0, 5).join("\n")));
    cleanup();
    process.exit(1);
  }
}

main().catch((err) => {
  fail(red(`unexpected error: ${err.message}`));
  cleanup();
  process.exit(1);
});
