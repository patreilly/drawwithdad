import { defineConfig } from "vite";

/**
 * Bundles the API into dist-server/ with all dependencies included, so it runs
 * with plain `node` (Docker) or as a Lambda handler (AWS) without node_modules.
 */
export default defineConfig({
  build: {
    ssr: true,
    outDir: "dist-server",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    rollupOptions: {
      input: { node: "server/node.ts", lambda: "server/lambda.ts" },
      output: { format: "es", entryFileNames: "[name].mjs", chunkFileNames: "[name]-[hash].mjs" },
    },
  },
  ssr: { noExternal: true, target: "node" },
});
