import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

export default function AdminPage() {
  return (
    <main>
      <h1>Admin</h1>
      <p>Queues for submissions, claims and cities land here next.</p>
    </main>
  );
}
