import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  server: {
    port: studioPort(),
    strictPort: true,
    proxy: {
      "/__studio_api": {
        target: studioApiProxyTarget(),
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/__studio_api/, ""),
      },
    },
  },
  plugins: [tsconfigPaths(), tanstackStart(), viteReact()],
});

function studioPort() {
  const configured = Number.parseInt(process.env.PORT ?? "3004", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 3004;
}

function studioApiProxyTarget() {
  const configured =
    process.env.STUDIO_API_PROXY_TARGET ?? process.env.VITE_STUDIO_API_URL;
  if (configured?.startsWith("http://") || configured?.startsWith("https://")) {
    return configured;
  }
  return `http://localhost:${process.env.API_PORT ?? "8787"}`;
}
