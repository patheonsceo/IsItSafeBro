import { NextResponse } from "next/server";
import { store } from "@/lib/store";

// VULN x2:
//   (a) no auth check + no ownership check → IDOR: anyone can fetch any
//       user by id by walking the integers
//   (b) the response includes the password_hash and the email
//       verification token. these are private fields that should never
//       leave the server. The AI wrote `res.json(user)` instead of
//       picking specific fields.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = store.users.find((u) => u.id === Number.parseInt(id, 10));
  if (!user) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(user);
}
