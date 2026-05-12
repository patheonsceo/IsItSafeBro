// Vulnerable JWT helper.
//
// This is what shipped when the AI was asked to "add JWT auth". The code
// decodes the payload but never verifies the signature. As a result:
//   - alg:none tokens are accepted
//   - tokens signed with ANY HS256 secret are accepted (we don't even
//     look at the signature, let alone check it against a key)
//   - tokens with arbitrary claims (role:admin, sub:1, ...) work
//
// /api/me uses this and trusts whatever it returns.

import { Buffer } from "node:buffer";

export type JwtPayload = Record<string, unknown>;

export function decodeJwt(token: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const decoded = Buffer.from(parts[1], "base64url").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

export function userFromAuthHeader(authHeader: string | null): JwtPayload | null {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  return decodeJwt(token);
}
