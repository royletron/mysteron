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
  assignee?: string;
  labels: string[];
  created: string;
  updated: string;
  /** Markdown description / acceptance criteria. */
  body: string;
}

export interface CompanionConfig {
  /** Randomly generated fun name, e.g. "Kermit the Compiler". */
  name: string;
  /** Emoji avatar. */
  avatar: string;
  /** Default agent-team recipe id used when delegating work. */
  recipe?: string;
}

export interface ProjectConfig {
  id: string;
  name: string;
  companion: CompanionConfig;
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
