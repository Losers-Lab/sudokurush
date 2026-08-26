import { defineConfig } from "vite";

// Baked into the bundle at build time so a loaded tab can prove which build
// it runs (logged at boot; see main.ts).
const buildId = Date.now().toString(36);

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  // Vite defaults to client/; the documented convention is one .env at the
  // repo root, and missing it silently strips VITE_DISCORD_CLIENT_ID from
  // the bundle — which reads as "Discord sign-in never happens" in production.
  envDir: "..",
  // Shared asset root: brand art lives at /brand/*.
  publicDir: "../assets",
  server: {
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
