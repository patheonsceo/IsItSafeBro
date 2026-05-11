#!/usr/bin/env node
/**
 * End-to-end integration test for the snap MCP tools.
 *
 * Creates a temporary git repo, seeds it with a multi-feature messy diff
 * (auth tweak + unrelated config bump + new docs), spawns the compiled MCP
 * server over stdio, and drives it through:
 *
 *   1. snap_inspect  → confirm the diff is detected and clean=false
 *   2. snap_commit   → land one conventional commit for auth changes
 *   3. snap_commit   → land one conventional commit for the chore bump
 *   4. snap_commit   → land one conventional commit for the docs add
 *   5. snap_inspect  → confirm clean=true
 *
 * Exits non-zero if any step fails or any assertion is wrong.
 *
 * Run with:  node scripts/test-snap.mjs
 * (Requires `npm run build` first.)
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "..");
const serverPath = join(repoRoot, "dist", "mcp", "server.js");

function log(...args) {
  console.log("[test-snap]", ...args);
}

function die(msg) {
  console.error("[test-snap] FAIL:", msg);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/*  Safe git helper — execFile, never shell                                   */
/* -------------------------------------------------------------------------- */

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/* -------------------------------------------------------------------------- */
/*  MCP client over stdio                                                     */
/* -------------------------------------------------------------------------- */

class StdioMcpClient {
  constructor(child) {
    this.child = child;
    this.buf = "";
    this.next_id = 1;
    this.pending = new Map();
    child.stdout.on("data", (chunk) => this.onData(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
    child.on("exit", (code) => {
      if (this.pending.size > 0) {
        for (const [, reject] of this.pending.values()) {
          reject(new Error(`server exited (code=${code}) with pending requests`));
        }
      }
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
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
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
      clientInfo: { name: "test-snap", version: "1.0.0" },
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
/*  Fixture: a messy multi-feature repo                                       */
/* -------------------------------------------------------------------------- */

function seedRepo() {
  const dir = mkdtempSync(join(tmpdir(), "snap-test-"));

  git(dir, "init", "-b", "main", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");

  // Initial committed state.
  mkdirSync(join(dir, "src", "auth"), { recursive: true });
  writeFileSync(
    join(dir, "src", "auth", "signup.js"),
    "module.exports.signup = () => null;\n",
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      { name: "app", version: "0.1.0", dependencies: { next: "14.2.0" } },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(dir, "README.md"), "# app\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "initial");

  // ---- now make a messy 3-feature diff ----

  // (a) auth feature change
  writeFileSync(
    join(dir, "src", "auth", "signup.js"),
    "module.exports.signup = (password) => password.length >= 12 ? 'ok' : 'weak';\n",
  );

  // (b) chore: bump a dep
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      { name: "app", version: "0.1.0", dependencies: { next: "14.2.3" } },
      null,
      2,
    ) + "\n",
  );

  // (c) docs: new file
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "auth.md"), "# auth\n\npasswords must be 12+ chars.\n");

  return dir;
}

/* -------------------------------------------------------------------------- */
/*  Test driver                                                               */
/* -------------------------------------------------------------------------- */

async function main() {
  const repo = seedRepo();
  log("seeded repo:", repo);

  const child = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
  const client = new StdioMcpClient(child);

  try {
    await client.initialize();
    log("initialized");

    // 1. inspect
    const inspect1 = await client.callTool("snap_inspect", { cwd: repo });
    if (!inspect1.ok) die("first inspect failed: " + JSON.stringify(inspect1));
    if (inspect1.clean !== false) die("expected clean=false on first inspect");
    const paths = inspect1.files.map((f) => f.path).sort();
    const want = ["docs/auth.md", "package.json", "src/auth/signup.js"];
    if (JSON.stringify(paths) !== JSON.stringify(want)) {
      die(`expected files ${JSON.stringify(want)}, got ${JSON.stringify(paths)}`);
    }
    log("inspect1 ok: 3 files detected");

    // 2. auth commit
    const c1 = await client.callTool("snap_commit", {
      cwd: repo,
      type: "feat",
      subject: "enforce 12 char minimum on signup password",
      files: ["src/auth/signup.js"],
    });
    if (!c1.ok) die("auth commit failed: " + JSON.stringify(c1));
    if (c1.message !== "feat: enforce 12 char minimum on signup password") {
      die("unexpected auth commit message: " + c1.message);
    }
    log("commit 1:", c1.sha.slice(0, 7), c1.message);

    // 3. chore commit
    const c2 = await client.callTool("snap_commit", {
      cwd: repo,
      type: "chore",
      subject: "bump next to 14.2.3",
      files: ["package.json"],
    });
    if (!c2.ok) die("chore commit failed: " + JSON.stringify(c2));
    log("commit 2:", c2.sha.slice(0, 7), c2.message);

    // 4. docs commit
    const c3 = await client.callTool("snap_commit", {
      cwd: repo,
      type: "docs",
      subject: "document the new password rule",
      files: ["docs/auth.md"],
    });
    if (!c3.ok) die("docs commit failed: " + JSON.stringify(c3));
    log("commit 3:", c3.sha.slice(0, 7), c3.message);

    // 5. final inspect should be clean
    const inspect2 = await client.callTool("snap_inspect", { cwd: repo });
    if (!inspect2.ok) die("final inspect failed: " + JSON.stringify(inspect2));
    if (inspect2.clean !== true) {
      die("expected clean=true after all commits; got: " + JSON.stringify(inspect2.summary));
    }
    log("final inspect ok: tree is clean");

    // 6. validation: reject uppercase subject (must come AFTER the tree is
    // clean so the reset+add doesn't leave junk behind for later assertions)
    const bad = await client.callTool("snap_commit", {
      cwd: repo,
      type: "fix",
      subject: "Bad Subject",
      files: ["package.json"],
    });
    if (bad.ok !== false) die("expected uppercase subject to be rejected");
    if (!/lowercase/i.test(bad.error)) die("expected 'lowercase' in error, got: " + bad.error);
    log("validation rejection ok:", bad.error);

    // 7. verify the git log has the three commits in order
    const logOut = git(repo, "log", "--pretty=%s").trim().split("\n");
    const wantLog = [
      "docs: document the new password rule",
      "chore: bump next to 14.2.3",
      "feat: enforce 12 char minimum on signup password",
      "initial",
    ];
    if (JSON.stringify(logOut) !== JSON.stringify(wantLog)) {
      die("unexpected git log:\n" + JSON.stringify(logOut, null, 2));
    }
    log("git log matches expected order");

    log("ALL CHECKS PASSED");
  } finally {
    client.close();
    try {
      rmSync(repo, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
