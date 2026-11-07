import { cookies } from "next/headers";
import type { DB } from "./db/client";
import type { Project } from "./db/schema";
import { listProjects } from "./projects";

export const PROJECT_COOKIE = "studio_projekt";
export const ALL_PROJECTS = "alle";

export type ProjectScope = {
  /** Alle nicht archivierten Projekte */
  projects: Project[];
  /** Gewähltes Projekt; null bei „Alle Projekte“ oder wenn es noch keins gibt */
  active: Project | null;
  /** „Alle Projekte“ ist gewählt */
  all: boolean;
};

/** Wertet die Auswahl aus (rein, testbar). Unbekannte/archivierte Projekte fallen auf das erste zurück. */
export function resolveScope(projects: Project[], cookieValue: string | undefined): ProjectScope {
  if (!projects.length) return { projects, active: null, all: false };
  // „Alle Projekte“ lohnt erst ab zwei Projekten.
  if (cookieValue === ALL_PROJECTS && projects.length > 1) return { projects, active: null, all: true };
  const found = projects.find((p) => String(p.id) === cookieValue);
  return { projects, active: found ?? projects[0], all: false };
}

/** Aktuelle Projektauswahl aus dem Cookie (nur in Server-Komponenten/-Aktionen). */
export async function getScope(db: DB): Promise<ProjectScope> {
  const jar = await cookies();
  return resolveScope(listProjects(db), jar.get(PROJECT_COOKIE)?.value);
}

/** Für Filter: undefined = alle Projekte. */
export const scopeFilter = (scope: ProjectScope): number | undefined => (scope.all ? undefined : scope.active?.id);
