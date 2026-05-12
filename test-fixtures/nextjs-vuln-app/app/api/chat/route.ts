import { NextResponse } from "next/server";

// VULN: this "AI chat" endpoint accepts whatever the user sends and (in
// the real deploy) would forward it to an LLM with no guard. for the
// demo, it simulates the worst case: the model obediently follows any
// instruction in the user's content, including hidden system-prompt
// overrides, fake [SYSTEM] tags, jailbreak roleplays, and pre-fabricated
// 'assistant' turns the client sent. it does this by scanning the input
// for any ISITSAFEBRO_*_OK canary token and echoing the user content back
// as the assistant message.
//
// Real fix: pass user content as DATA, not instructions; pin the system
// prompt server-side; reject client-supplied assistant turns; consider
// output filtering for canary-shaped tokens.
export async function POST(req: Request) {
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    // ignore
  }
  let userContent = "";
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (Array.isArray(b.messages)) {
      userContent = (b.messages as Array<Record<string, unknown>>)
        .map((m) => String(m?.content ?? ""))
        .join(" ");
    } else {
      for (const k of ["prompt", "message", "input", "text", "content"]) {
        if (typeof b[k] === "string") {
          userContent = b[k] as string;
          break;
        }
      }
    }
  }
  if (!userContent && body) userContent = JSON.stringify(body);

  const canary = userContent.match(/ISITSAFEBRO_[A-Z0-9_]+_OK/);
  return NextResponse.json({
    choices: [
      {
        message: {
          role: "assistant",
          content: canary
            ? userContent
            : "Hello! I'm VibeNotes AI. How can I help with your notes today?",
        },
      },
    ],
  });
}
