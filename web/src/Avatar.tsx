import Boring from "boring-avatars";
import type { Companion } from "./api";

export type AvatarVariant = "beam" | "marble" | "pixel" | "sunset" | "ring" | "bauhaus";

// Mysteron's palette (colorhunt 450693 / 8C00FF / FF3F7F / FFC400), so avatars sit
// on-brand against the dark UI.
export const COLORS = ["#450693", "#8c00ff", "#ff3f7f", "#ffc400"];

/**
 * Deterministic boring-avatars avatar (offline SVG). Pass a `companion` (uses its
 * avatarSeed) or an explicit `seed`. Companions use `beam` (face-like); projects
 * use `marble`; the brand mark uses `pixel`.
 */
export function Avatar({
  companion,
  seed,
  variant = "beam",
  size = 36,
  square = false,
}: {
  companion?: Pick<Companion, "name" | "avatarSeed">;
  seed?: string;
  variant?: AvatarVariant;
  size?: number;
  square?: boolean;
}) {
  const name = seed ?? companion?.avatarSeed ?? companion?.name ?? "?";
  return (
    <span
      class={`inline-block shrink-0 overflow-hidden ${square ? "rounded-md" : "rounded-full"}`}
      style={{ width: size, height: size }}
    >
      <Boring size={size} name={name} variant={variant} colors={COLORS} />
    </span>
  );
}
