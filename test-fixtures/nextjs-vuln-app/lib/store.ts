// In-memory store. Lives across hot reloads via globalThis so Next.js dev
// mode doesn't reset it on every recompile.
//
// In production you would replace this with a real database. The store is
// shaped so that the planted bugs (PII in list responses, password_hash
// leak in /api/users/[id], etc.) have data to leak.

type User = {
  id: number;
  email: string;
  name: string;
  phone: string;
  role: "user" | "admin";
  password_hash: string; // bcrypt-shaped
  email_verification_token: string;
};

type Note = {
  id: number;
  user_id: number;
  title: string;
  body: string;
  created_at: string;
};

type Store = {
  users: User[];
  notes: Note[];
};

const g = globalThis as unknown as { __vibenotes_store?: Store };

if (!g.__vibenotes_store) {
  g.__vibenotes_store = {
    users: [
      {
        id: 1,
        email: "alice@example.com",
        name: "Alice",
        phone: "+1-555-0001",
        role: "user",
        password_hash: "$2b$10$abcdefghijklmnopqrstuvwxyz0123456789abcdef",
        email_verification_token: "verify-alice-9b2c",
      },
      {
        id: 2,
        email: "bob@example.com",
        name: "Bob",
        phone: "+1-555-0002",
        role: "user",
        password_hash: "$2b$10$bbcdefghijklmnopqrstuvwxyz0123456789abcdef",
        email_verification_token: "verify-bob-1f3d",
      },
      {
        id: 3,
        email: "admin@example.com",
        name: "Site Admin",
        phone: "+1-555-0003",
        role: "admin",
        password_hash: "$2b$10$cbcdefghijklmnopqrstuvwxyz0123456789abcdef",
        email_verification_token: "verify-admin-4a8e",
      },
    ],
    notes: [
      {
        id: 1,
        user_id: 1,
        title: "shopping list",
        body: "milk, eggs, bread, a working pen",
        created_at: "2026-04-01T10:00:00Z",
      },
      {
        id: 2,
        user_id: 1,
        title: "ideas",
        body: "launch the side project finally",
        created_at: "2026-04-12T14:30:00Z",
      },
      {
        id: 3,
        user_id: 2,
        title: "private — do not share",
        body: "vacation plans, hotel confirmation #ABC-1234",
        created_at: "2026-04-15T09:00:00Z",
      },
      {
        id: 4,
        user_id: 3,
        title: "admin todo",
        body: "review the pending bans, update the homepage banner",
        created_at: "2026-04-20T16:00:00Z",
      },
    ],
  };
}

export const store: Store = g.__vibenotes_store!;
