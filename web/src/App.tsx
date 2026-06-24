import { useEffect, useState } from "preact/hooks";
import { useAsync, useGlobalEvents, useHashRoute, navigate } from "./hooks";
import { api, type ProjectListItem } from "./api";
import { Home } from "./Home";
import { Project } from "./Project";
import { TicketPage } from "./TicketPage";
import { LiveDot } from "./ui";
import logoUrl from "../images/m.png";

export interface AppEvent {
  seq: number;
  projectId?: string;
}

export function App() {
  const route = useHashRoute();
  const [evt, setEvt] = useState<AppEvent>({ seq: 0 });
  const [ticketTitle, setTicketTitle] = useState<string>();
  // The ticket live-view tab only needs its run stream, so it holds no global
  // connection — keeps each tab to a single SSE socket (browsers cap ~6/origin).
  const connected = useGlobalEvents(
    (e) => setEvt((s) => ({ seq: s.seq + 1, projectId: e.projectId as string | undefined })),
    route.name !== "ticket",
  );

  const { data } = useAsync(() => api<{ projects: ProjectListItem[] }>("/api/projects"), [evt.seq]);
  const projects = data?.projects ?? [];
  const current = route.projectId ? projects.find((p) => p.id === route.projectId) : undefined;

  useEffect(() => {
    if (route.name !== "ticket") setTicketTitle(undefined);
  }, [route.name, route.ticketId]);

  return (
    <div class="flex min-h-[100dvh] flex-col">
      <header class="sticky top-0 z-10 flex items-center gap-2 border-b border-zinc-800 bg-zinc-950/80 px-6 py-3 backdrop-blur">
        <a href="#/" class="flex items-center gap-2">
          <img src={logoUrl} alt="" width={26} height={26} class="shrink-0" />
          <span class="font-display text-xl font-bold tracking-tight">Mysteron</span>
        </a>
        {route.name === "home" ? (
          <span class="text-sm italic text-zinc-500">puppeteering your agents</span>
        ) : (
          <>
            {current && (
              <>
                <span class="text-zinc-600">/</span>
                <a href={`#/project/${current.id}`} class="text-sm text-zinc-200 hover:text-violet-300">
                  {current.name}
                </a>
              </>
            )}
            {route.name === "ticket" && (
              <>
                <span class="text-zinc-600">/</span>
                <span class="truncate text-sm text-zinc-400">{ticketTitle ?? "Ticket"}</span>
              </>
            )}
          </>
        )}

        <div class="flex-1" />

        {projects.length > 0 && (
          <select
            class="max-w-[200px] rounded-sm border border-zinc-800 bg-zinc-950 px-2 py-1 text-sm text-zinc-300 outline-none hover:border-violet-500 focus:border-violet-500"
            value={route.projectId ?? ""}
            onChange={(e) => {
              const id = (e.target as HTMLSelectElement).value;
              if (id) navigate(`#/project/${id}`);
            }}
          >
            <option value="" disabled>
              Switch project…
            </option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}

        <span
          class={`inline-flex items-center text-xs ${connected ? "text-emerald-400" : "text-zinc-600"}`}
          title="live updates"
        >
          {connected ? <LiveDot /> : <span class="inline-block h-2 w-2 rounded-full bg-current" />}
        </span>
      </header>

      <main class="w-full flex-1 p-6">
        {route.name === "home" && <Home evt={evt} />}
        {route.name === "project" && route.projectId && (
          <Project key={route.projectId} projectId={route.projectId} tab={route.tab} evt={evt} />
        )}
        {route.name === "ticket" && route.projectId && route.ticketId && (
          <TicketPage
            key={`${route.projectId}/${route.ticketId}`}
            projectId={route.projectId}
            ticketId={route.ticketId}
            autostart={route.autostart ?? false}
            evt={evt}
            onTitle={setTicketTitle}
          />
        )}
      </main>

      <Footer />
    </div>
  );
}

const REPO = "https://github.com/royletron/mysteron";

function Footer() {
  const link = "text-zinc-400 hover:text-violet-300";
  return (
    <footer class="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-zinc-800 px-6 py-4 text-sm text-zinc-500">
      <span class="font-semibold text-zinc-300">Mysteron</span>
      <a class={link} href={REPO} target="_blank" rel="noopener noreferrer">
        GitHub
      </a>
      <a class={link} href={`${REPO}/issues`} target="_blank" rel="noopener noreferrer">
        Issues
      </a>
      <a class={link} href={`${REPO}/stargazers`} target="_blank" rel="noopener noreferrer">
        ★ Stars
      </a>
      <div class="flex-1" />
      <a
        class="font-mono text-xs hover:text-violet-300"
        href={`${REPO}/commit/${__COMMIT_SHA__}`}
        target="_blank"
        rel="noopener noreferrer"
        title="Build commit"
      >
        {__COMMIT_SHA__}
      </a>
    </footer>
  );
}
