import { NextResponse } from "next/server";

// VULN: returns server-side secrets to anyone. the AI wrote a /api/config
// route to "expose runtime config" and dumped process.env-shaped data
// without filtering. server-only secrets (stripe secret, jwt secret,
// openai key, db url) leak alongside the legitimately-public bits.
export async function GET() {
  return NextResponse.json({
    public: {
      stripePublishableKey: "pk_live_isitsafebroFAKEpublishable",
      appUrl: "http://localhost:3000",
      appName: "VibeNotes",
    },
    server: {
      STRIPE_SECRET_KEY:
        "sk_" + "live_" + "isitsafebroVibeNotesSERVERFAKEdemokey1234567890",
      JWT_SECRET: "my-very-secret-key",
      DATABASE_URL: "postgres://app:redacted@db.host:5432/app",
      OPENAI_API_KEY:
        "sk-fakeOpenAIkeyVibeNotesabcdefghijklmnopqrstuvwxyz0123",
      ANTHROPIC_API_KEY:
        "sk-ant-fakeAnthropicKeyVibeNotesabcdefghijklmnop",
    },
  });
}
