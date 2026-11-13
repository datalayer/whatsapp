import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["test/**/*.test.ts"],
    // One file at a time: against a real Solr each file makes its own
    // throwaway collection, and one at a time keeps the cluster's load low.
    fileParallelism: false,
    server: {
      deps: {
        // agent-runtimes' lib/portable keeps tsc's extensionless relative
        // imports: in a standalone clone it sits in node_modules, where Node
        // would load it as is and fail; transformed by Vite, it resolves.
        // In the monorepo the workspace link already points outside
        // node_modules.
        inline: ["@datalayer/agent-runtimes"],
      },
    },
  },
});
