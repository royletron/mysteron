import { useEffect, useRef, useState } from "preact/hooks";
import type { RunLine, RunStatus } from "./api";
import { subscribeGlobal, subscribeRun } from "./ws";

export interface Route {
  name: "home" | "project" | "ticket";
  projectId?: string;
  ticketId?: string;
  tab?: string;
  autostart?: boolean;
}

function parseRoute(): Route {
  const hash = location.hash.replace(/^#/, "");
  const parts = hash.split("/").filter(Boolean);
  if (parts[0] === "project" && parts[2] === "ticket" && parts[3]) {
    return { name: "ticket", projectId: parts[1], ticketId: parts[3], autostart: parts[4] === "run" };
  }
  if (parts[0] === "project" && parts[1]) {
    return { name: "project", projectId: parts[1], tab: parts[2] };
  }
  return { name: "home" };
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(parseRoute());
  useEffect(() => {
    const onChange = () => setRoute(parseRoute());
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function navigate(hash: string): void {
  location.hash = hash;
}

export interface AsyncState<T> {
  data?: T;
  error?: string;
  loading: boolean;
  reload: () => void;
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    fnRef.current()
      .then((data) => alive && setState({ data, loading: false }))
      .catch((e) => alive && setState({ error: String(e?.message || e), loading: false }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { ...state, reload: () => setNonce((n) => n + 1) };
}

/**
 * Subscribe to the shared live event stream (the single per-tab WebSocket).
 * `enabled` is kept for callers but no longer affects connection count — all
 * subscriptions ride one socket. Returns the connection state.
 */
export function useGlobalEvents(
  onEvent: (evt: Record<string, unknown>) => void,
  enabled = true,
): boolean {
  const [connected, setConnected] = useState(false);
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      return;
    }
    return subscribeGlobal((e) => cb.current(e), setConnected);
  }, [enabled]);
  return connected;
}

export interface RunStreamHandlers {
  onLine: (line: RunLine) => void;
  onStatus: (status: RunStatus, exitCode?: number | null) => void;
  /** Called when the server (re)sends the run's buffer — clear accumulated lines
   *  first to avoid duplicates. */
  onReset?: () => void;
}

/**
 * Stream a run's output over the shared WebSocket. The server replays the run's
 * buffer on (re)subscribe (preceded by a reset), so reconnects are seamless.
 */
export function useRunStream(runId: string | null | undefined, handlers: RunStreamHandlers): void {
  const h = useRef(handlers);
  h.current = handlers;
  useEffect(() => {
    if (!runId) return;
    return subscribeRun(runId, (evt) => {
      if (evt.kind === "reset") h.current.onReset?.();
      else if (evt.kind === "line" && evt.line) h.current.onLine(evt.line as RunLine);
      else if (evt.kind === "status" && evt.status) h.current.onStatus(evt.status as RunStatus, evt.exitCode);
    });
  }, [runId]);
}
