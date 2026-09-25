// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/test-results/**",
      "**/playwright-report/**",
      "**/.lighthouseci/**",
      "**/*.d.ts",
      "templates/**",
    ],
  },
  js.configs.recommended,
  {
    // Node scripts and tooling: declare the runtime globals explicitly rather
    // than pulling in another dependency just to list them.
    files: ["scripts/**/*.mjs", "bin/**/*.mjs", "**/*.config.js", "**/*.config.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        fetch: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
      },
    },
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // The kit's own rule: no raw magic durations in components. Motion values
      // must come from the design tokens so reduced-motion and visual freezing
      // keep working.
      "no-restricted-syntax": [
        "warn",
        {
          selector:
            "Property[key.name='transition'] > TemplateLiteral, Property[key.name='transitionDuration']",
          message:
            "Use transition()/duration tokens from @kit/design-system instead of a literal duration.",
        },
      ],
    },
  },
  prettier,
);
