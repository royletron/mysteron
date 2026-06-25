import { useEffect, useState } from "preact/hooks";
import { useAsync, useGlobalEvents } from "./hooks";
import {
  STATE_LABELS,
  api,
  fmtWhen,
  getAuthStatus,
  getGuestOffer,
  getGuestToken,
  getHostBoard,
  getWorkers,
  logout,
  mintGuestToken,
  revokeGuestToken,
  startGuestOffer,
  stopGuestOffer,
  type TicketState,
} from "./api";
import { LiveDot } from "./ui";

const BOARD_ORDER: TicketState[] = ["backlog", "ready", "in-progress", "review", "done"];

/** Global (per-app) settings. Currently: optional password protection. */
export function Settings() {
  const status = useAsync(() => getAuthStatus(), []);
  const s = status.data;
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const savePassword = async () => {
    setErr("");
    setMsg("");
    if (password.length < 4) return setErr("Use at least 4 characters.");
    if (password !== confirm) return setErr("Passwords don't match.");
    try {
      await api("/api/settings/auth", { method: "PUT", body: JSON.stringify({ password }) });
      setPassword("");
      setConfirm("");
      setMsg("Password saved — protection is on. Other sessions have been signed out.");
      status.reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const toggle = async (enabled: boolean) => {
    setErr("");
    setMsg("");
    try {
      await api("/api/settings/auth", { method: "PUT", body: JSON.stringify({ enabled }) });
      status.reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const doLogout = async () => {
    await logout();
    location.reload();
  };

  return (
    <div class="mx-auto max-w-xl">
      <h1 class="mb-4 text-xl font-semibold">Settings</h1>
      <div class="card">
        <div class="flex items-center gap-2">
          <h2 class="text-lg font-semibold">Password protection</h2>
          {s && (
            <span class={`pill text-xs ${s.enabled ? "border-emerald-500 text-emerald-400" : "border-zinc-600 text-zinc-400"}`}>
              {s.enabled ? "on" : "off"}
            </span>
          )}
        </div>
        <p class="text-sm text-zinc-400">
          Global to this Mysteron app. When on, a password is required to view anything. Changing the
          password signs out all existing sessions.
        </p>

        {status.loading && <div class="pulse mt-3 text-sm text-zinc-500">Loading…</div>}

        {s && (
          <>
            {s.passwordSet && (
              <div class="mt-3 flex items-center gap-2">
                {s.enabled ? (
                  <button class="btn btn-sm" onClick={() => toggle(false)}>
                    Turn protection off
                  </button>
                ) : (
                  <button class="btn btn-sm" onClick={() => toggle(true)}>
                    Turn protection on
                  </button>
                )}
                <div class="flex-1" />
                {s.enabled && s.authed && (
                  <button class="btn btn-sm" onClick={doLogout}>
                    Log out
                  </button>
                )}
              </div>
            )}

            <div class="mt-4 border-t border-zinc-800 pt-4">
              <label class="field-label !mt-0">{s.passwordSet ? "Change password" : "Set a password"}</label>
              <input
                class="input mb-2"
                type="password"
                placeholder="New password"
                value={password}
                onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
              />
              <input
                class="input"
                type="password"
                placeholder="Confirm password"
                value={confirm}
                onInput={(e) => setConfirm((e.target as HTMLInputElement).value)}
              />
              {err && <p class="mt-2 text-sm text-red-400">{err}</p>}
              {msg && <p class="mt-2 text-sm text-emerald-400">{msg}</p>}
              <button class="btn btn-primary btn-sm mt-3" onClick={savePassword} disabled={!password}>
                {s.passwordSet ? "Change password" : "Set password"}
              </button>
            </div>
          </>
        )}
      </div>

      <GuestWorkers />
      <OfferAsGuest />
    </div>
  );
}

/** Offer this machine to another host as a guest worker, and see that host's board. */
function OfferAsGuest() {
  const [nonce, setNonce] = useState(0);
  useGlobalEvents(() => setNonce((n) => n + 1));
  const offer = useAsync(() => getGuestOffer(), [nonce]);
  const g = offer.data?.guest ?? null;

  const [hostUrl, setHostUrl] = useState("");
  const [token, setToken] = useState("");
  const [hours, setHours] = useState("2");
  const [err, setErr] = useState("");

  const connect = async () => {
    setErr("");
    try {
      await startGuestOffer({ hostUrl: hostUrl.trim(), token: token.trim(), forMs: Number(hours) * 3_600_000 });
      offer.reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const withdraw = async () => {
    await stopGuestOffer();
    offer.reload();
  };

  const active = Boolean(g && g.offering);

  return (
    <div class="card mt-4">
      <h2 class="text-lg font-semibold">Offer this machine to a host</h2>
      <p class="text-sm text-zinc-400">
        Lend this machine + your Claude account to another Mysteron host as a guest companion for a while —
        you'll run their tickets locally. ⚠ Only offer to hosts you trust.
      </p>

      {active && g ? (
        <>
          <div class="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span
              class={`pill gap-1.5 ${g.state === "offered" ? "border-emerald-500 text-emerald-400" : "border-amber-500 text-amber-400"}`}
            >
              {g.state === "offered" && <LiveDot />}
              {g.state}
            </span>
            <span class="text-zinc-400">
              {g.hostUrl}
              {g.hostLabel ? ` · ${g.hostLabel}` : ""}
            </span>
            <div class="flex-1" />
            <button class="btn btn-danger btn-sm" onClick={withdraw}>
              Withdraw
            </button>
          </div>
          {g.message && <p class="mt-1 text-xs text-zinc-500">{g.message}</p>}
          {(g.expiresAt || g.activeRuns > 0) && (
            <p class="mt-1 text-xs text-zinc-500">
              {g.expiresAt ? `expires ${fmtWhen(g.expiresAt)}` : ""}
              {g.activeRuns > 0 ? ` · ${g.activeRuns} active run(s)` : ""}
            </p>
          )}
          <HostBoard nonce={nonce} />
        </>
      ) : (
        <div class="mt-3 flex flex-col gap-2">
          <input
            class="input"
            placeholder="Host URL (e.g. https://host:4319)"
            value={hostUrl}
            onInput={(e) => setHostUrl((e.target as HTMLInputElement).value)}
          />
          <input
            class="input"
            placeholder="Join token (from the host's Settings)"
            value={token}
            onInput={(e) => setToken((e.target as HTMLInputElement).value)}
          />
          <div class="flex items-center gap-2">
            <label class="text-sm text-zinc-400">For</label>
            <select
              class="input max-w-[130px]"
              value={hours}
              onChange={(e) => setHours((e.target as HTMLSelectElement).value)}
            >
              <option value="0.5">30 min</option>
              <option value="1">1 hour</option>
              <option value="2">2 hours</option>
              <option value="4">4 hours</option>
              <option value="8">8 hours</option>
            </select>
            <div class="flex-1" />
            <button class="btn btn-primary btn-sm" onClick={connect} disabled={!hostUrl.trim() || !token.trim()}>
              Offer machine
            </button>
          </div>
          {err && <p class="text-sm text-red-400">{err}</p>}
        </div>
      )}
    </div>
  );
}

/** Read-only view of the host's board (polled while offering). */
function HostBoard({ nonce }: { nonce: number }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, []);
  const board = useAsync(() => getHostBoard(), [tick, nonce]);
  const projects = board.data?.projects ?? [];
  if (projects.length === 0) return null;

  return (
    <div class="mt-4 border-t border-zinc-800 pt-4">
      <label class="field-label !mt-0">Host board</label>
      {projects.map((p) => (
        <div key={p.id} class="mb-3">
          <div class="mb-1 text-sm font-semibold">{p.name}</div>
          <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            {BOARD_ORDER.filter((st) => p.tickets.some((t) => t.state === st)).map((st) => (
              <div key={st} class="contents">
                <b class="text-zinc-400">{STATE_LABELS[st]}</b>
                <span class="text-zinc-300">
                  {p.tickets
                    .filter((t) => t.state === st)
                    .map((t) => t.title)
                    .join(", ")}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Manage the guest join token and see who's currently offering their machine. */
function GuestWorkers() {
  // Refetch the connected list whenever the host pushes a global event.
  const [nonce, setNonce] = useState(0);
  useGlobalEvents(() => setNonce((n) => n + 1));
  const tokenState = useAsync(() => getGuestToken(), []);
  const workers = useAsync(() => getWorkers(), [nonce]);
  const [copied, setCopied] = useState(false);

  const token = tokenState.data?.token ?? null;
  const joinCmd = token ? `mysteron join ${location.origin} --token ${token} --for 2h` : "";

  const generate = async () => {
    await mintGuestToken();
    tokenState.reload();
  };
  const revoke = async () => {
    if (!confirm("Revoke the guest token? Connected guests stay until they expire, but no new ones can join.")) return;
    await revokeGuestToken();
    tokenState.reload();
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(joinCmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the command is shown for manual copy */
    }
  };

  const list = workers.data?.workers ?? [];

  return (
    <div class="card mt-4">
      <h2 class="text-lg font-semibold">Guest companions</h2>
      <p class="text-sm text-zinc-400">
        Let a trusted peer offer their machine + Claude account as an extra companion for a while. Share
        the join command below; they run it with the Mysteron CLI. ⚠ Guests run your tickets' code on their
        own machine — only invite people you trust.
      </p>

      <div class="mt-3">
        {token ? (
          <>
            <label class="field-label !mt-0">Join command</label>
            <div class="flex items-center gap-2">
              <code class="flex-1 overflow-x-auto whitespace-nowrap rounded-sm border border-zinc-800 bg-zinc-950 px-2.5 py-2 font-mono text-xs">
                {joinCmd}
              </code>
              <button class="btn btn-sm shrink-0" onClick={copy}>
                {copied ? "Copied ✓" : "Copy"}
              </button>
            </div>
            <div class="mt-2 flex gap-2">
              <button class="btn btn-sm" onClick={generate}>
                Regenerate
              </button>
              <button class="btn btn-danger btn-sm" onClick={revoke}>
                Revoke
              </button>
            </div>
          </>
        ) : (
          <button class="btn btn-primary btn-sm" onClick={generate}>
            Generate join token
          </button>
        )}
      </div>

      <div class="mt-4 border-t border-zinc-800 pt-4">
        <label class="field-label !mt-0">Connected guests ({list.length})</label>
        {list.length === 0 ? (
          <div class="text-sm text-zinc-500">None connected.</div>
        ) : (
          <div class="flex flex-col gap-1.5">
            {list.map((w) => (
              <div key={w.id} class="flex items-center gap-2 rounded-sm border border-zinc-800 px-2.5 py-1.5 text-sm">
                <span class={`inline-flex items-center gap-1.5 ${w.status === "busy" ? "text-amber-400" : "text-emerald-400"}`}>
                  <LiveDot />
                  {w.label}
                </span>
                <span class="text-xs text-zinc-500">×{w.capacity}</span>
                <div class="flex-1" />
                <span class="text-xs text-zinc-500">expires {fmtWhen(w.expiresAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
