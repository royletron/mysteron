import { EventEmitter } from "node:events";

export interface MysteronEvent {
  type: "docs-changed" | "board-changed" | "config-changed";
  projectId: string;
  detail?: string;
  at: string;
}

export interface RunLine {
  stream: "stdout" | "stderr" | "system";
  text: string;
  at: string;
}

export interface RunEvent {
  kind: "started" | "line" | "status";
  runId: string;
  projectId: string;
  ticketId: string;
  line?: RunLine;
  status?: string;
  exitCode?: number | null;
  at: string;
}

export type AutopilotStatus = "running" | "paused" | "idle" | "stopped";

export interface AutopilotEvent {
  projectId: string;
  status: AutopilotStatus;
  message: string;
  currentTicketId?: string;
  currentRunId?: string;
  completed: number;
  at: string;
}

/** Process-wide event bus used to push live updates to the web UI (via SSE). */
class MysteronBus extends EventEmitter {
  emitEvent(evt: Omit<MysteronEvent, "at">): void {
    this.emit("mysteron", { ...evt, at: new Date().toISOString() } satisfies MysteronEvent);
  }

  emitRun(evt: Omit<RunEvent, "at">): void {
    this.emit("run", { ...evt, at: new Date().toISOString() } satisfies RunEvent);
  }

  emitAutopilot(evt: Omit<AutopilotEvent, "at">): void {
    this.emit("autopilot", { ...evt, at: new Date().toISOString() } satisfies AutopilotEvent);
  }
}

export const bus = new MysteronBus();
