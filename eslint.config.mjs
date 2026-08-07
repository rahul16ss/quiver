import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "dist-electron/**",
      "coverage/**",
      "examples/**/output/**",
      "examples/**/website-export/**",
      "src/**/*.bak/**",
      "src/**/.quiver-backups/**",
      ".quiver/**",
      "tests/**",
      "workflow-packs/**/expected-output/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // Quiver is strict-typed; lint is deliberately focused on correctness and
      // process hygiene rather than style (Prettier owns formatting).
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
      "no-control-regex": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-useless-escape": "off",
      // Module-level singleton handle assigned from class methods; not a
      // closure-capture footgun.
      "@typescript-eslint/no-this-alias": ["error", { allowedNames: ["activeLiveInput"] }],
    },
  },
  {
    // Browser UI: DOM/fetch globals, no Node globals.
    files: ["src/harness/ui/**/*.js"],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    // Zero-warning baseline: unused vars are errors everywhere. The legacy
    // ratchet was burned down 2026-08-07; acceptance-pinned symbols carry an
    // inline eslint-disable with the pinning US- reference.
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
);
