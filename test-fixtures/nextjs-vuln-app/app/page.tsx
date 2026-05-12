import { store } from "@/lib/store";

export default function HomePage() {
  // pretend the current user is alice (id=1) — no real auth yet.
  const myNotes = store.notes.filter((n) => n.user_id === 1);
  return (
    <>
      <h1>your notes</h1>
      <p style={{ color: "#888" }}>signed in as alice@example.com (totally not faked)</p>
      <ul>
        {myNotes.map((n) => (
          <li key={n.id}>
            <a href={`/notes/${n.id}`}>{n.title}</a>
            <div style={{ color: "#666", fontSize: "0.9em" }}>{n.body}</div>
          </li>
        ))}
      </ul>
      <p>
        <a href="/search">search your notes</a> · ask the AI: try <a href="/chat-demo">/chat-demo</a>
      </p>
    </>
  );
}
