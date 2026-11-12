import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Browser-mode only: lets the GUI find the locally running runtime by reading the
 * connection file the runtime writes (same thing the Tauri shell does natively).
 * The dev server is bound to loopback.
 */
function runtimeConnection(): Plugin {
  const file = path.join(process.env.GRAPHCODE_HOME ?? path.join(os.homedir(), ".graphcode"), "runtime.json");
  return {
    name: "graphcode-runtime-connection",
    configureServer(server) {
      server.middlewares.use("/__graphcode/connection", (_req, res) => {
        try {
          res.setHeader("content-type", "application/json");
          res.end(fs.readFileSync(file, "utf8"));
        } catch {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: `Runtime connection file not found at ${file}. Start the runtime with \`pnpm runtime\`.` }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), runtimeConnection()],
  clearScreen: false,
  server: { port: 5173, strictPort: true, host: "127.0.0.1" },
  build: { target: "es2022", outDir: "dist", chunkSizeWarningLimit: 6000 },
});
