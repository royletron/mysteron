/**
 * Echo plugin — a minimal example showing how to write a custom Mysteron plugin.
 *
 * To enable it, add the path to `plugins` in `.mysteron/config.json`:
 *   "plugins": ["usage-monitor", "./path/to/echo-plugin.js"]
 *
 * The plugin exposes one MCP tool (`echo`) that returns whatever the agent sends it.
 * Copy this file into your project and modify it to build your own plugin.
 */
import { z } from "zod";
import type { Plugin } from "../types.js";

export default {
  id: "echo",
  name: "Echo",
  description: "Example plugin — echoes its input back. Use as a starting point for custom plugins.",

  tools() {
    return [
      {
        name: "echo",
        description: "Return the message unchanged. Useful for verifying the plugin loaded correctly.",
        inputSchema: {
          message: z.string().describe("The text to echo back."),
        },
        async handler(args) {
          return { echo: args.message, at: new Date().toISOString() };
        },
      },
    ];
  },
} satisfies Plugin;
