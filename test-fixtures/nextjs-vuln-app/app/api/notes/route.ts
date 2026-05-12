import { NextResponse } from "next/server";
import { store } from "@/lib/store";

// VULN: GET returns every note in the system — every user's data,
// regardless of who's asking. No auth check, no user-scoping. The list
// also includes the author's PII (email, phone). The AI wrote
// "fetch notes" without thinking about WHICH notes.
export async function GET() {
  const enriched = store.notes.map((n) => {
    const author = store.users.find((u) => u.id === n.user_id);
    return {
      id: n.id,
      title: n.title,
      body: n.body,
      created_at: n.created_at,
      author: author
        ? {
            id: author.id,
            email: author.email,
            phone: author.phone,
          }
        : null,
    };
  });
  return NextResponse.json(enriched);
}

// VULN: POST creates a note with no auth check. anyone can spam new notes
// into the database.
export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // ignore — empty body still proceeds, which is itself part of the bug
  }
  const newNote = {
    id: store.notes.length + 1,
    user_id: 999, // anonymous "user"
    title: (body.title as string) ?? "untitled",
    body: (body.body as string) ?? "",
    created_at: new Date().toISOString(),
  };
  store.notes.push(newNote);
  return NextResponse.json(newNote, { status: 201 });
}
