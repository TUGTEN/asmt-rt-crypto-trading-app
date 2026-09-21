import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Layering rule for every later ticket: data arrives through `lib/protocol.ts`
  // and the hooks, and reaches presentational components as plain props. A
  // `fetch` in a component (or in the pure format helpers) fails the build
  // instead of becoming a review comment.
  {
    files: ["components/**/*.{ts,tsx}", "lib/format.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message:
            "Networking lives in lib/protocol.ts and the hooks in lib/hooks/ — pass values into components as props.",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
