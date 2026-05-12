import "./globals.css";
import { Footer } from "@/components/Footer";

export const metadata = {
  title: "VibeNotes",
  description: "your AI-powered notes",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <header className="topnav">
          <strong>VibeNotes</strong>
          <nav>
            <a href="/">home</a>
            <a href="/search">search</a>
            <a href="/admin">admin</a>
            <a href="/login">log in</a>
          </nav>
        </header>
        <main>{children}</main>
        <Footer />
      </body>
    </html>
  );
}
