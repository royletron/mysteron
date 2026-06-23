/** Core domain types for Henson. */

export const TICKET_STATES = [
  "backlog",
  "ready",
  "in-progress",
  "review",
  "done",
] as const;

export type TicketState = (typeof TICKET_STATES)[number];

export const TICKET_PRIORITIES = ["low", "medium", "high"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export interface Ticket {
  id: string;
  title: string;
  state: TicketState;
  priority: TicketPriority;
  /** Id of the companion this ticket is assigned to (see ProjectConfig.companions). */
  companionId?: string;
  /** Human-readable assignee (the companion's name at assign time); for display. */
  assignee?: string;
  labels: string[];
  created: string;
  updated: string;
  /** Markdown description / acceptance criteria. */
  body: string;
}

/**
 * A companion is a first-class, named agent identity that lives with the
 * project (committed in .henson/config.json, so every machine agrees who's who).
 * Its role comes from the project's recipe; runs of a companion are per-machine.
 */
export interface Companion {
  /** Stable id, also used as the Claude session id for conversation continuity. */
  id: string;
  /** Fun generated name, e.g. "Kermit the Compiler". */
  name: string;
  /** Role id from the recipe, e.g. "soloist", "designer", "backend". */
  role: string;
  /** Seed for the boring-avatars avatar (kept stable even if renamed). */
  avatarSeed: string;
}

/** @deprecated Pre-roster single-companion shape; migrated to {@link Companion}[]. */
export interface CompanionConfig {
  name: string;
  avatar: string;
  recipe?: string;
}

export interface ProjectConfig {
  id: string;
  name: string;
  /** The chosen agent-team recipe (drives the companion roster). */
  recipe: string;
  /** The project's companions, one per role in the recipe. */
  companions: Companion[];
  /** Enabled plugin ids. */
  plugins: string[];
  /** When true the companion may work autonomously without per-step approval. */
  yolo: boolean;
  /**
   * Tools the companion is allowed to use without prompting (Claude Code
   * --allowedTools), e.g. "Edit", "Write", "Bash(npm test:*)". Lets you keep
   * yolo off but still let the agent run specific things. Ignored when yolo is on
   * (bypass mode allows everything).
   */
  allowedTools?: string[];
  /** Tools the companion may never use (Claude Code --disallowedTools). */
  disallowedTools?: string[];
  /**
   * How to launch the agent for a ticket. Defaults to Claude Code headless.
   * Override here (or with the HENSON_AGENT_CMD env var) to use any agent CLI.
   */
  agent?: {
    command: string;
    args?: string[];
  };
  createdAt: string;
}

export interface RegistryEntry {
  id: string;
  name: string;
  /** Absolute path to the project root on disk. */
  path: string;
  createdAt: string;
}

export interface Registry {
  projects: RegistryEntry[];
}

export interface DocSummary {
  name: string;
  path: string;
  bytes: number;
  updated: string;
}

export interface MemorySummary {
  name: string;
  description?: string;
  type?: string;
}
