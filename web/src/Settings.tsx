import { useState } from "preact/hooks";
import { useAsync, useGlobalEvents } from "./hooks";
import {
  api,
  fmtWhen,
  getAuthStatus,
  getGuestToken,
  getWorkers,
  logout,
  mintGuestToken,
  revokeGuestToken,
} from "./api";
import { LiveDot } from "./ui";

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
