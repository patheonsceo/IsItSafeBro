import { store } from "@/lib/store";

// VULN: no auth check. Anyone who visits /admin gets the user list.
// The AI scaffold added this route but never added a guard.
export default function AdminPage() {
  const users = store.users;
  return (
    <>
      <h1>admin panel</h1>
      <p>user list:</p>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>id</th>
            <th style={{ textAlign: "left" }}>email</th>
            <th style={{ textAlign: "left" }}>name</th>
            <th style={{ textAlign: "left" }}>role</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.id}</td>
              <td>{u.email}</td>
              <td>{u.name}</td>
              <td>{u.role}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>settings · manage users · system status: ok</p>
    </>
  );
}
