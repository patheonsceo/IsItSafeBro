import { NextResponse, type NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  const res = NextResponse.next();

  // VULN: bad CORS. echoes the request's Origin header AND grants
  // credentials, so any origin can send authenticated requests to this API.
  // The AI assistant wrote this when asked to "allow cors". it should
  // be an explicit allow-list, not a reflector.
  const origin = req.headers.get("origin");
  if (origin) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.set("Access-Control-Allow-Credentials", "true");
  }
  if (req.method === "OPTIONS") {
    res.headers.set(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    res.headers.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization",
    );
  }

  // VULN: sets a session cookie on every fresh visitor — but forgets the
  // `httpOnly: true` option. cookies().set defaults to httpOnly: false,
  // so any XSS anywhere on the site can read this cookie via document.cookie.
  if (!req.cookies.get("session")) {
    res.cookies.set(
      "session",
      "anon-" + Math.random().toString(36).slice(2, 11),
      { path: "/" },
    );
  }

  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
