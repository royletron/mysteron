import type { ComponentChildren } from "preact";
import { runElapsed, type RunStatus } from "./api";
import { useNow } from "./hooks";

export function Modal({ children, onClose }: { children: ComponentChildren; onClose: () => void }) {
  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div class="card max-h-[90vh] w-full max-w-xl overflow-auto">{children}</div>
    </div>
  );
}

export function Loading({ what }: { what?: string }) {
  return <div class="pulse p-10 text-center text-zinc-500">{what ?? "Loading…"}</div>;
}

/** A pulsing dot marking a live/running state. Inherits the current text colour. */
export function LiveDot({ class: className = "" }: { class?: string }) {
  return <span class={`live-dot ${className}`} aria-hidden="true" />;
}

/** Cloud glyph — marks work running on / offloaded to a remote guest machine. */
export function CloudGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6-1.6A4 4 0 0 0 6 19z" />
    </svg>
  );
}

/** Home glyph — marks work that ran on the local host machine. */
export function HomeGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" />
    </svg>
  );
}

/** Monitor glyph — marks work that ran on another (non-guest) machine. */
export function MonitorGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

/** Where a run executed, shown on its own line so a run row never overflows:
 *  a cloud for guest machines, a monitor for remote hosts, a home for the local host. */
export function RunMachine({
  run,
}: {
  run: { guestLabel?: string; hostname?: string; logAvailable?: boolean };
}) {
  if (run.guestLabel)
    return (
      <span class="inline-flex items-center gap-1 text-sky-400" title={`Ran on guest machine “${run.guestLabel}”`}>
        <CloudGlyph size={11} /> {run.guestLabel}
      </span>
    );
  if (run.logAvailable === false)
    return (
      <span class="inline-flex items-center gap-1 text-zinc-500" title={`Ran on ${run.hostname ?? "another machine"}; logs are local to that machine`}>
        <MonitorGlyph size={11} /> {run.hostname || "remote"}
      </span>
    );
  return (
    <span class="inline-flex items-center gap-1 text-zinc-500" title={`Ran on this host machine${run.hostname ? ` (${run.hostname})` : ""}`}>
      <HomeGlyph size={11} /> {run.hostname || "host"}
    </span>
  );
}

/** Elapsed-time readout for a run; ticks every second while the run is running. */
export function RunTimer({
  run,
  prefix = "",
  class: className = "",
}: {
  run: { startedAt: string; endedAt?: string; status: RunStatus };
  prefix?: string;
  class?: string;
}) {
  const label = runElapsed(run, useNow(run.status === "running"));
  if (!label) return null;
  return (
    <span class={`tabular-nums ${className}`}>
      {prefix}
      {label}
    </span>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return <div class="p-10 text-center text-red-400">{message}</div>;
}

export function Avatar({ emoji, size = "text-3xl" }: { emoji: string; size?: string }) {
  return <div class={`${size} leading-none`}>{emoji}</div>;
}
