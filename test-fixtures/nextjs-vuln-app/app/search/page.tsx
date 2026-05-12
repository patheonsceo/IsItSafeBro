import { store } from "@/lib/store";

// VULN: user-supplied `q` is interpolated into an HTML string and rendered
// via React's "dangerously set" inner-HTML API. Default React escaping is
// bypassed, so <script> or any HTML in the query string is rendered raw.
// AI assistants reach for this when they want "the title should show the
// user's query" and don't realize they've just turned every search link
// into an XSS vector.
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { q } = await searchParams;
  const query = Array.isArray(q) ? q[0] ?? "" : q ?? "";
  const matches = query
    ? store.notes.filter((n) =>
        (n.title + " " + n.body).toLowerCase().includes(query.toLowerCase()),
      )
    : [];
  return (
    <>
      <h1
        dangerouslySetInnerHTML={{
          __html: `results for: ${query}`,
        }}
      />
      <form method="get" action="/search">
        <input name="q" defaultValue={query} placeholder="search..." />
        <button type="submit">go</button>
      </form>
      <ul>
        {matches.map((n) => (
          <li key={n.id}>
            <strong>{n.title}</strong>
            <div style={{ color: "#666" }}>{n.body}</div>
          </li>
        ))}
      </ul>
    </>
  );
}
