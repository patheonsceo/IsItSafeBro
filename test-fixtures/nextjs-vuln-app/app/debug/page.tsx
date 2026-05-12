// VULN: forgot to gate /debug behind NODE_ENV === 'development' or an auth
// check. anyone can read env, version, and uptime via this page.
export default function DebugPage() {
  const info = {
    env: process.env.NODE_ENV ?? "development",
    version: process.version,
    uptime: process.uptime(),
    config: { debug: true, trace: true },
    request: {
      method: "GET",
      url: "/debug",
    },
  };
  return (
    <>
      <h1>debug</h1>
      <pre>{JSON.stringify(info, null, 2)}</pre>
    </>
  );
}
