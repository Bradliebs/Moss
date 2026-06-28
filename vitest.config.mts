import { defineConfig } from "vitest/config";

// Dedicated config so vitest does not load the renderer vite.config.ts
// (which imports the ESM-only @tailwindcss/vite plugin). These are
// node-side unit tests for the Electron backend.
export default defineConfig({
  test: {
    // Backend (electron) and renderer business-logic (src/lib) unit tests. Both
    // run in node: the renderer lib modules guard every localStorage access in
    // try/catch, so they are safe without a DOM. Component (.tsx) tests and the
    // dictation hook opt into a jsdom environment per file via a
    // `// @vitest-environment jsdom` docblock, so the default env stays node.
    include: ["electron/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
  },
});
