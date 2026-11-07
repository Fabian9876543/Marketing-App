import type { Metadata } from "next";
import { connection } from "next/server";
import { and, eq } from "drizzle-orm";
import type { ReactNode } from "react";
import { switchProjectAction } from "@/app/actions";
import { Nav } from "@/components/Nav";
import { getScope, scopeFilter } from "@/lib/active-project";
import { getDb } from "@/lib/db/client";
import { contents, posts } from "@/lib/db/schema";
import { workerAlive } from "@/lib/settings";
import "./globals.css";

export const metadata: Metadata = {
  title: "Marketing Studio",
  description: "Shorts für mehrere Projekte planen, freigeben und veröffentlichen",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  const db = getDb();
  const scope = await getScope(db);
  const projectId = scopeFilter(scope);
  const reviewCount = db
    .select({ id: posts.id })
    .from(posts)
    .innerJoin(contents, eq(contents.id, posts.contentId))
    .where(projectId ? and(eq(posts.state, "review"), eq(contents.projectId, projectId)) : eq(posts.state, "review"))
    .all().length;
  return (
    <html lang="de">
      <body>
        <div className="mx-auto flex min-h-screen max-w-7xl flex-col md:flex-row">
          <aside className="border-b border-line p-3 md:sticky md:top-0 md:h-screen md:w-56 md:shrink-0 md:overflow-y-auto md:border-b-0 md:border-r md:p-4">
            <Nav
              projects={scope.projects.map((p) => ({ id: p.id, name: p.name, color: p.color }))}
              activeId={scope.active?.id ?? null}
              all={scope.all}
              reviewCount={reviewCount}
              workerAlive={workerAlive(db)}
              switchAction={switchProjectAction}
            />
          </aside>
          <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
        </div>
      </body>
    </html>
  );
}
