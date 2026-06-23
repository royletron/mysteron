// One WebSocket per tab for ALL live push data — global board/autopilot events
// and per-run output, multiplexed by channel. WebSockets have their own (large)
// browser connection budget, separate from the 6-per-origin HTTP/1.1 pool that
// fetch uses, so this can never starve REST calls no matter how many tabs/runs.

type GlobalCb = (evt: Record<string, unknown>) => void;
type RunEvt = { kind: string; line?: unknown; status?: string; exitCode?: number | null };
type RunCb = (evt: RunEvt) => void;
type ConnCb = (connected: boolean) => void;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let connected = false;
const globalSubs = new Set<GlobalCb>();
const connSubs = new Set<ConnCb>();
const runSubs = new Map<string, Set<RunCb>>();

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

/** Tell a run's subscribers to clear, then (re)subscribe — the server replays
 *  the run's full buffer on subscribe, so resetting first avoids duplicates. */
function sendSub(runId: string): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    runSubs.get(runId)?.forEach((cb) => cb({ kind: "reset" }));
    ws.send(JSON.stringify({ type: "sub-run", runId }));
  }
}

function ensure(): void {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  ws = new WebSocket(wsUrl());
  ws.onopen = () => {
    connected = true;
    connSubs.forEach((f) => f(true));
    for (const runId of runSubs.keys()) sendSub(runId); // resubscribe after (re)connect
  };
  ws.onclose = () => {
    connected = false;
    connSubs.forEach((f) => f(false));
    ws = null;
    scheduleReconnect();
  };
  ws.onerror = () => {
    /* onclose handles reconnect */
  };
  ws.onmessage = (e) => {
    let m: { channel?: string; evt?: Record<string, unknown> };
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    if (m.channel === "global" && m.evt) globalSubs.forEach((cb) => cb(m.evt!));
    else if (m.channel === "run" && m.evt) runSubs.get(m.evt.runId as string)?.forEach((cb) => cb(m.evt as RunEvt));
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (globalSubs.size || runSubs.size) ensure();
  }, 1500);
}

function maybeIdle(): void {
  if (!globalSubs.size && !runSubs.size) {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    ws?.close();
    ws = null;
  }
}

export function subscribeGlobal(onEvent: GlobalCb, onConn: ConnCb): () => void {
  globalSubs.add(onEvent);
  connSubs.add(onConn);
  ensure();
  onConn(connected);
  return () => {
    globalSubs.delete(onEvent);
    connSubs.delete(onConn);
    maybeIdle();
  };
}

export function subscribeRun(runId: string, onEvent: RunCb): () => void {
  let set = runSubs.get(runId);
  if (!set) {
    set = new Set();
    runSubs.set(runId, set);
  }
  set.add(onEvent);
  ensure();
  sendSub(runId);
  return () => {
    const s = runSubs.get(runId);
    if (s) {
      s.delete(onEvent);
      if (s.size === 0) {
        runSubs.delete(runId);
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "unsub-run", runId }));
      }
    }
    maybeIdle();
  };
}
