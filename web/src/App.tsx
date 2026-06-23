import { useState } from "preact/hooks";
import { useGlobalEvents, useHashRoute } from "./hooks";
import { Home } from "./Home";
import { Project } from "./Project";
import { TicketPage } from "./TicketPage";
import { Avatar } from "./Avatar";

export interface AppEvent {
  seq: number;
  projectId?: string;
}

export function App() {
  const route = useHashRoute();
  const [evt, setEvt] = useState<AppEvent>({ seq: 0 });
  // The ticket live-view tab only needs its run stream, so it holds no global
  // connection — keeps each tab to a single SSE socket (browsers cap ~6/origin).
  const connected = useGlobalEvents(
    (e) => setEvt((s) => ({ seq: s.seq + 1, projectId: e.projectId as string | undefined })),
    route.name !== "ticket",
  );

  return (
    <div>
      <header class="sticky top-0 z-10 flex items-center gap-3 border-b border-zinc-800 bg-zinc-950/80 px-6 py-3 backdrop-blur">
        <a href="#/" class="flex items-center gap-2">
          <Avatar seed="Henson" variant="marble" size={26} />
          <span class="text-xl font-bold tracking-wide">Henson</span>
        </a>
        <span class="text-sm italic text-zinc-500">puppeteering your agents</span>
        <span
          class={`ml-auto text-xs ${connected ? "text-emerald-400" : "text-zinc-600"}`}
          title="live updates"
        >
          ●
        </span>
      </header>

      <main class="w-full p-6">
        {route.name === "home" && <Home evt={evt} />}
        {route.name === "project" && route.projectId && (
          <Project key={route.projectId} projectId={route.projectId} evt={evt} />
        )}
        {route.name === "ticket" && route.projectId && route.ticketId && (
          <TicketPage
            key={`${route.projectId}/${route.ticketId}`}
            projectId={route.projectId}
            ticketId={route.ticketId}
            autostart={route.autostart ?? false}
            evt={evt}
          />
        )}
      </main>
    </div>
  );
}
