import { NextResponse } from "next/server";
import { cookies } from "next/headers";

// VULN x2: this handler accepts known-weak default credentials AND treats
// an empty/null/missing password as valid. either way, anyone signs in.
// The AI scaffolded "the login flow" without ever writing the password
// check against a real user database.
export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // ignore — bad JSON is treated as empty
  }

  const user = (body.username ?? body.email) as string | undefined;
  const password = body.password as string | null | undefined;

  const allowed =
    (user === "admin" &&
      (password === "admin" ||
        password === "password" ||
        password === "123456" ||
        password === "admin123")) ||
    password === "" ||
    password === null ||
    password === undefined;

  if (allowed) {
    // hardcoded fake JWT-shaped token + a session cookie. real /api/me
    // would decode the JWT and trust whatever role it claims.
    const c = await cookies();
    c.set("session", "loggedin-1234", { path: "/" });
    return NextResponse.json({
      token:
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIiwicm9sZSI6ImFkbWluIn0.fake",
      user: { id: 1, email: "admin@admin.com", role: "admin" },
    });
  }

  return NextResponse.json(
    { error: "invalid credentials" },
    { status: 401 },
  );
}
