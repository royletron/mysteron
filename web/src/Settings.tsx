import { useState } from "preact/hooks";
import { useAsync } from "./hooks";
import { api, getAuthStatus, logout } from "./api";

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
    </div>
  );
}
