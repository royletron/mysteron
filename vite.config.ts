import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";

// Short commit sha baked into the build for the footer (falls back to "dev").
const commitSha = (() => {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "dev";
  }
})();

// The Mysteron web UI. Builds to dist/server/public so the Express server serves
// it as static assets (headless-friendly — no separate frontend process in prod).
export default defineConfig({
  root: "web",
  define: { __COMMIT_SHA__: JSON.stringify(commitSha) },
  plugins: [preact(), tailwindcss()],
  server: {
    port: 5319,
    // In dev, proxy API + the live WebSocket to the running Express server.
    proxy: {
      "/api": {
        target: process.env.MYSTERON_DEV_API ?? "http://127.0.0.1:4319",
        changeOrigin: true,
      },
      "/ws": {
        target: process.env.MYSTERON_DEV_API ?? "http://127.0.0.1:4319",
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "../dist/server/public",
    emptyOutDir: true,
  },
});
