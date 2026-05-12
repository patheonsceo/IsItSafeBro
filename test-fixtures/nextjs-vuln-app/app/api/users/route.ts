import { NextResponse } from "next/server";
import { store } from "@/lib/store";

// VULN: this was meant to be an admin-only endpoint, but the auth check
// never got written. anyone can list every user — including phone numbers.
export async function GET() {
  return NextResponse.json(
    store.users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      phone: u.phone,
      role: u.role,
    })),
  );
}
