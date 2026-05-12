export default function LoginPage() {
  return (
    <>
      <h1>log in</h1>
      <form method="post" action="/api/login" style={{ display: "grid", gap: "0.5rem", maxWidth: 320 }}>
        <input name="username" placeholder="username" defaultValue="admin" />
        <input name="password" type="password" placeholder="password" />
        <button type="submit">sign in</button>
      </form>
      <p style={{ color: "#888", marginTop: "1rem", fontSize: "0.85em" }}>
        hint: this is a demo. try anything.
      </p>
    </>
  );
}
