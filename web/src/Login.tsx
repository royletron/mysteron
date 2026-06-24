import { useState } from "preact/hooks";
import { login } from "./api";
import logoUrl from "../images/m.png";

/** Full-screen gate shown when protection is on and this browser isn't authed. */
export function Login({ onAuthed }: { onAuthed: () => void }) {
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await login(password);
      onAuthed();
    } catch (e) {
      setErr((e as Error).message || "Incorrect password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="flex min-h-[100dvh] flex-col items-center justify-center p-6">
      <form onSubmit={submit} class="card w-full max-w-sm">
        <div class="mb-3 flex items-center gap-2">
          <img src={logoUrl} alt="" width={28} height={28} class="shrink-0" />
          <h1 class="font-display text-xl font-bold tracking-tight">Mysteron</h1>
        </div>
        <p class="mb-3 text-sm text-zinc-400">
          This area is protected. Enter the password to continue.
        </p>
        <input
          class="input"
          type="password"
          autoFocus
          placeholder="Password"
          value={password}
          onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
        />
        {err && <p class="mt-2 text-sm text-red-400">{err}</p>}
        <button class="btn btn-primary mt-4 w-full justify-center" disabled={busy || !password}>
          {busy ? "Checking…" : "Enter"}
        </button>
      </form>
    </div>
  );
}
