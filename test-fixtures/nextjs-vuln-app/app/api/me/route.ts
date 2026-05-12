import { NextResponse } from "next/server";
import { userFromAuthHeader } from "@/lib/jwt";

// VULN: /api/me trusts the JWT payload without verifying the signature.
// any alg:none token works, and any HS256 token (signed with ANY secret)
// works, because lib/jwt.ts only base64-decodes the payload portion.
// The AI wrote "JWT verification" without actually verifying.
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const payload = userFromAuthHeader(auth);
  if (!payload) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(payload);
}
