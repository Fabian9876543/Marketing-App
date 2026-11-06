import type { Metadata } from "next";
import { connection } from "next/server";
import { eq } from "drizzle-orm";
import type { ReactNode } from "react";
import { Nav } from "@/components/Nav";
import { getDb } from "@/lib/db/client";
import { posts } from "@/lib/db/schema";
import { workerAlive } from "@/lib/settings";
import "./globals.css";

export const metadata: Metadata = {
  title: "Fokuspilot Studio",
  description: "Shorts für Fokuspilot planen, freigeben und veröffentlichen",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  const db = getDb();
  const reviewCount = db.select({ id: posts.id }).from(posts).where(eq(posts.state, "review")).all().length;
  return (
    <html lang="de">
      <body>
        <div className="mx-auto flex min-h-screen max-w-7xl flex-col md:flex-row">
          <aside className="border-b border-line p-3 md:sticky md:top-0 md:h-screen md:w-52 md:shrink-0 md:border-b-0 md:border-r md:p-4">
            <Nav reviewCount={reviewCount} workerAlive={workerAlive(db)} />
          </aside>
          <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
        </div>
      </body>
    </html>
  );
}
