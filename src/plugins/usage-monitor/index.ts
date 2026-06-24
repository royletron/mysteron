import { z } from "zod";
import type { Plugin } from "../types.js";
import type { ProjectConfig } from "../../core/types.js";
import { usageInWindow } from "./usage.js";
import { detectAccount, type AccountInfo } from "./account.js";
import { readSnapshot, type Bucket } from "./snapshot.js";

/**
 * Token limit lookup order: project config → env var → default.
 * The default (5M) is intentionally generous — calibrate to your actual plan
 * via pluginOptions["usage-monitor"].tokenLimit in .mysteron/config.json or by
 * setting MYSTERON_USAGE_TOKEN_LIMIT in the environment.
 *
 * This only governs the *estimate* path (API-key budgets and the no-live-data
 * fallback). For subscription accounts with a fresh capture, we use the real
 * server-side utilization instead and ignore this number.
 */
function tokenLimit(config?: ProjectConfig): { limit: number; source: "config" | "env" | "default" } {
  const fromConfig = config?.pluginOptions?.["usage-monitor"]?.tokenLimit;
  if (fromConfig && fromConfig > 0) return { limit: fromConfig, source: "config" };
  const raw = process.env.MYSTERON_USAGE_TOKEN_LIMIT;
  const fromEnv = raw ? Number(raw) : NaN;
  if (Number.isFinite(fromEnv) && fromEnv > 0) return { limit: fromEnv, source: "env" };
  return { limit: 5_000_000, source: "default" };
}

function windowHours(config?: ProjectConfig): number {
  const fromConfig = config?.pluginOptions?.["usage-monitor"]?.windowHours;
  if (fromConfig && fromConfig > 0) return fromConfig;
  const raw = process.env.MYSTERON_USAGE_WINDOW_HOURS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 5;
}

/** How fresh a captured snapshot must be to be trusted as "live". */
function liveTtlMs(): number {
  const raw = process.env.MYSTERON_USAGE_LIVE_TTL_MIN;
  const n = raw ? Number(raw) : NaN;
  return (Number.isFinite(n) && n > 0 ? n : 15) * 60_000;
}

/** "rejected" means we're actually rate-limited right now. */
function isRejected(b?: Bucket): boolean {
  return b?.status === "rejected";
}

/**
 * Usage monitor: keeps the companion inside Claude Code's limits, so a board can
 * be left churning over hours/days (and in yolo mode) without blowing the
 * account's budget.
 *
 * Two regimes, chosen by account type:
 *  - subscription (Pro/Max): when the capture proxy has fresh
 *    `anthropic-ratelimit-unified-*` headers, report the *real* 5h-session and
 *    weekly utilization straight from Anthropic.
 *  - API key (or no live data): there's no native session/weekly token cap, so
 *    track a self-imposed budget by tallying transcript tokens in a window.
 */
export const usageMonitorPlugin: Plugin = {
  id: "usage-monitor",
  name: "Claude usage monitor",
  description:
    "Tracks Claude usage — real session/weekly limits for subscription accounts (via captured rate-limit headers), or a self-imposed token budget for API keys — and tells the companion whether it's safe to keep working.",

  tools(ctx) {
    return [
      {
        name: "check_usage_budget",
        description:
          "Report Claude usage in the current rolling windows and whether it is safe to continue working. For subscription accounts this reflects the real session (5h) and weekly limits; for API keys it tracks a self-imposed token budget. Call before starting a new ticket, especially in yolo mode.",
        inputSchema: {
          safetyMarginPercent: z
            .number()
            .min(0)
            .max(100)
            .optional()
            .describe("Stop when usage exceeds this percent of the limit. Default 85."),
        },
        async handler(args) {
          const margin = (args.safetyMarginPercent as number | undefined) ?? 85;
          const wh = windowHours(ctx.config);

          // Always compute the transcript estimate — it's the fallback and also
          // useful supplementary detail (token counts) even in live mode.
          const [usage, weeklyUsage] = await Promise.all([usageInWindow(wh), usageInWindow(168)]);
          const { limit, source: limitSource } = tokenLimit(ctx.config);
          const estUsed = usage.billableTokens;
          const estPct = limit > 0 ? (estUsed / limit) * 100 : 0;
          const estResetAt = usage.oldestMessageAt
            ? new Date(Date.parse(usage.oldestMessageAt) + wh * 3600_000).toISOString()
            : undefined;

          // Is there a fresh live capture?
          const snap = await readSnapshot();
          const ageMs = snap ? Date.now() - Date.parse(snap.capturedAt) : Infinity;
          const fresh = Number.isFinite(ageMs) && ageMs <= liveTtlMs();
          const unified = fresh ? snap?.unified : undefined;
          const hasLive = Boolean(unified && (unified.session || unified.weekly));

          const account: AccountInfo = await detectAccount(hasLive);

          const breakdown = {
            input: usage.inputTokens,
            output: usage.outputTokens,
            cacheCreation: usage.cacheCreationTokens,
            cacheRead: usage.cacheReadTokens,
            messages: usage.messages,
          };

          const common = {
            account: { kind: account.kind, subscriptionType: account.subscriptionType },
            windowHours: wh,
            windowStart: usage.windowStart,
            safetyMarginPercent: margin,
            yolo: ctx.config.yolo,
            breakdown,
            // Token tallies are always available as supplementary detail.
            tokensThisWindow: estUsed,
            weeklyUsed: weeklyUsage.billableTokens,
          };

          // --- Live mode: real subscription limits from captured headers ------
          if (hasLive && unified) {
            const session = unified.session;
            const weekly = unified.weekly;
            const sessionPct = session?.utilizationPct ?? 0;
            const weeklyPct = weekly?.utilizationPct ?? 0;
            // The binding constraint is whichever bucket is closest to its cap.
            const governing = weeklyPct > sessionPct ? "weekly" : "session";
            const pct = Math.max(sessionPct, weeklyPct);
            const rejected = isRejected(session) || isRejected(weekly) || unified.status === "rejected";
            const resetAt = (governing === "weekly" ? weekly?.resetAt : session?.resetAt) ?? estResetAt;
            const safeToContinue = !rejected && pct < margin;

            let recommendation: string;
            if (rejected) {
              const when = resetAt ? new Date(resetAt).toLocaleString() : "the window reset";
              recommendation = `Rate limited right now (${governing} cap). Pause until ${when}.${
                ctx.config.yolo ? " In yolo mode: sleep until reset, then resume the board." : ""
              }`;
            } else if (safeToContinue) {
              recommendation = `Within limits — session ${sessionPct.toFixed(0)}%, weekly ${weeklyPct.toFixed(
                0,
              )}%. ${ctx.config.yolo ? "Proceed to the next ticket." : "Safe to continue."}`;
            } else {
              const when = resetAt ? new Date(resetAt).toLocaleString() : "the window reset";
              recommendation = `${governing === "weekly" ? "Weekly" : "Session"} limit nearly reached (${pct.toFixed(
                0,
              )}%). Pause new work until ${when}.${
                ctx.config.yolo ? " In yolo mode: sleep until reset, then resume the board." : ""
              }`;
            }

            return {
              ...common,
              source: "live" as const,
              mode: "subscription-limits" as const,
              live: {
                capturedAt: snap!.capturedAt,
                ageSeconds: Math.round(ageMs / 1000),
                overallStatus: unified.status,
                session,
                weekly,
              },
              // Top-level compat fields (autopilot + existing UI read these).
              percentUsed: Number(pct.toFixed(1)),
              resetAt,
              safeToContinue,
              recommendation,
              // Limits are %-based here; token "limit/used/remaining" don't apply.
              limit: undefined,
              limitSource: undefined,
              used: estUsed,
              remaining: undefined,
            };
          }

          // --- Estimate mode: self-imposed token budget ----------------------
          const pct = estPct;
          const remaining = Math.max(0, limit - estUsed);
          const safeToContinue = pct < margin;
          // API keys have no native session cap, so frame it as a user budget.
          const isApi = account.kind === "api-key";
          const noun = isApi ? "budget" : "estimated budget";

          let recommendation: string;
          if (safeToContinue) {
            recommendation = ctx.config.yolo
              ? `Within ${noun} — proceed to the next ticket.`
              : `Within ${noun} — safe to continue.`;
          } else {
            const resetStr = estResetAt ? new Date(estResetAt).toLocaleTimeString() : "the end of the window";
            recommendation = `${isApi ? "Token budget" : "Estimated budget"} nearly exhausted (${pct.toFixed(
              1,
            )}% of ${limit.toLocaleString()}). Pause new work until the window rolls over around ${resetStr}.${
              ctx.config.yolo ? " In yolo mode: sleep until reset, then resume the board." : ""
            }`;
          }

          return {
            ...common,
            source: "estimate" as const,
            mode: isApi ? ("api-budget" as const) : ("estimate" as const),
            live: null,
            percentUsed: Number(pct.toFixed(1)),
            resetAt: estResetAt,
            safeToContinue,
            recommendation,
            limit,
            limitSource,
            used: estUsed,
            remaining,
          };
        },
      },
    ];
  },
};
