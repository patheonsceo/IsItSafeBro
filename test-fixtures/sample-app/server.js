// Zero-dependency Node HTTP fixture for isitsafebro worktree tests.
// Honors PORT and HOST env vars exactly like a typical vibe-coded dev server.
import { createServer } from "node:http";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "127.0.0.1";

const server = createServer((req, res) => {
  if (req.url === "/hello") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, from: "isitsafebro-fixture" }));
    return;
  }
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("sample fixture is alive\n");
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found\n");
});

server.listen(port, host, () => {
  // Logs go to stderr so they don't muddle stdout if anything pipes us.
  console.error(`fixture listening on http://${host}:${port}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
