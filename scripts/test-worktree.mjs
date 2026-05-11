#!/usr/bin/env node
/**
 * End-to-end integration test for the day-4 worktree tools.
 *
 * Builds a temp git repo from the test-fixtures/sample-app/ fixture, drives
 * the compiled MCP server through:
 *
 *   1. create_scan_worktree  → expect a new branch and worktree directory
 *   2. install_and_start     → expect the dev server to come up on a free
 *                              port; verify with an HTTP GET against /hello
 *   3. cleanup_worktree     → assert the spawned process group is dead, the
 *                              worktree directory is gone, the branch is kept
 *
 * Run with:  npm run test:worktree
 * (Requires `npm run build` first via the script wrapper.)
 */
import { spawn, execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "..");
const serverPath = join(repoRoot, "dist", "mcp", "server.js");
const fixtureSrc = join(repoRoot, "test-fixtures", "sample-app");

function log(...args) {
  console.log("[test-worktree]", ...args);
}
function die(msg) {
  console.error("[test-worktree] FAIL:", msg);
  process.exit(1);
}
function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/* -------------------------------------------------------------------------- */
/*  MCP client (mirrors test-snap.mjs)                                        */
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
        for (const [, [, reject]] of this.pending) {
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
      clientInfo: { name: "test-worktree", version: "1.0.0" },
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
/*  HTTP helper                                                               */
/* -------------------------------------------------------------------------- */

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "GET" }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error("http timeout"));
    });
    req.end();
  });
}

/* -------------------------------------------------------------------------- */
/*  Fixture seeding                                                           */
/* -------------------------------------------------------------------------- */

function seedRepo() {
  const dir = mkdtempSync(join(tmpdir(), "isitsafebro-wt-"));
  cpSync(fixtureSrc, dir, { recursive: true, filter: (src) => !src.includes("node_modules") });
  git(dir, "init", "-b", "main", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

/* -------------------------------------------------------------------------- */
/*  Driver                                                                    */
/* -------------------------------------------------------------------------- */

let createdWorktreePath = null;
let sourceRepo = null;

async function main() {
  sourceRepo = seedRepo();
  log("seeded source repo:", sourceRepo);

  const serverChild = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
  const client = new StdioMcpClient(serverChild);

  try {
    await client.initialize();

    /* 1. create_scan_worktree */
    const create = await client.callTool("create_scan_worktree", { cwd: sourceRepo });
    if (!create.ok) die("create_scan_worktree failed: " + JSON.stringify(create));
    if (!create.branch?.startsWith("isitsafebro/scan-")) die("unexpected branch: " + create.branch);
    if (!create.worktreePath || !existsSync(create.worktreePath)) {
      die("worktree path missing: " + create.worktreePath);
    }
    createdWorktreePath = create.worktreePath;
    log("worktree created at:", createdWorktreePath, "on branch:", create.branch);
    log("node_modules disposition:", create.nodeModules);

    /* 2. install_and_start */
    const start = await client.callTool("install_and_start", {
      worktreePath: createdWorktreePath,
      readyTimeoutMs: 15_000,
    });
    if (!start.ok) die("install_and_start failed: " + JSON.stringify(start));
    if (typeof start.port !== "number" || start.port <= 0) die("bad port: " + start.port);
    if (start.url !== `http://127.0.0.1:${start.port}`) die("unexpected url: " + start.url);
    if (start.script !== "dev") die("expected script='dev', got: " + start.script);
    log("dev server up:", start.url, "pid:", start.pid);

    /* 3. HTTP probe */
    const probe = await httpGet(`${start.url}/hello`);
    if (probe.status !== 200) die(`expected 200 on /hello, got ${probe.status}`);
    let body;
    try {
      body = JSON.parse(probe.body);
    } catch {
      die("expected JSON body on /hello, got: " + probe.body);
    }
    if (body?.from !== "isitsafebro-fixture") die("unexpected body: " + probe.body);
    log("HTTP probe ok:", probe.status, probe.body);

    /* 4. double-start refusal */
    const startAgain = await client.callTool("install_and_start", {
      worktreePath: createdWorktreePath,
      readyTimeoutMs: 2_000,
    });
    if (startAgain.ok !== false) die("expected double-start to be refused");
    if (!/already running/i.test(startAgain.error ?? "")) {
      die("expected 'already running' error, got: " + startAgain.error);
    }
    log("double-start correctly refused:", startAgain.error);

    /* 5. cleanup_worktree */
    const cleanup = await client.callTool("cleanup_worktree", {
      worktreePath: createdWorktreePath,
    });
    if (!cleanup.ok) die("cleanup_worktree failed: " + JSON.stringify(cleanup));
    if (cleanup.removed !== true) die("expected removed=true, got: " + cleanup.removed);
    if (!cleanup.killed || cleanup.killed === "none") {
      die("expected killed to be process_group or force, got: " + cleanup.killed);
    }
    if (cleanup.branchKept !== create.branch) {
      die(`expected branchKept=${create.branch}, got: ${cleanup.branchKept}`);
    }
    log("cleanup ok: killed=" + cleanup.killed + ", removed=" + cleanup.removed + ", branchKept=" + cleanup.branchKept);

    /* 6. Verify side-effects of cleanup */
    if (existsSync(createdWorktreePath)) {
      die("worktree directory still exists after cleanup: " + createdWorktreePath);
    }
    log("worktree directory is gone");

    // Branch should still be in the source's branch list.
    const branches = git(sourceRepo, "branch", "--list", create.branch).trim();
    if (!branches.includes(create.branch)) {
      die("expected branch to be kept; got branches: " + branches);
    }
    log("branch is preserved in source repo");

    // Hitting the old URL should now fail (connection refused).
    let stillUp = false;
    try {
      await httpGet(`${start.url}/hello`);
      stillUp = true;
    } catch {
      // connection refused = good
    }
    if (stillUp) die("dev server is still responding after cleanup; tree-kill failed");
    log("dev server is no longer responding");

    /* 7. Idempotency: cleanup on already-cleaned worktree returns an error
        (worktreePath does not exist), which is the documented behavior. */
    const cleanup2 = await client.callTool("cleanup_worktree", {
      worktreePath: createdWorktreePath,
    });
    if (cleanup2.ok !== false) die("expected second cleanup to error (dir gone)");
    log("second cleanup correctly reported missing dir:", cleanup2.error);

    log("ALL CHECKS PASSED");
  } finally {
    client.close();
    serverChild.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    if (sourceRepo) {
      try {
        rmSync(sourceRepo, { recursive: true, force: true });
      } catch {}
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
