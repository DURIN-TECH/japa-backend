module.exports = {
  root: true,
  env: {
    es6: true,
    node: true,
  },
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
  ],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    // tsconfig.test.json also covers the eval (src/scrapers/visa-catalog/eval/:
    // linted, never built into lib/, see tsconfig.json exclude).
    project: ["tsconfig.json", "tsconfig.test.json"],
    tsconfigRootDir: __dirname,
    sourceType: "module",
  },
  ignorePatterns: [
    "/lib/**/*",
    "/node_modules/**/*",
    ".eslintrc.js",
  ],
  plugins: [
    "@typescript-eslint",
  ],
  rules: {
    "quotes": ["error", "double"],
    "indent": ["error", 2],
    "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
  },
  overrides: [
    {
      // Unit tests (test/**): casting fixtures/partial results through `any`
      // is how the tests poke at diff rows and fake Firestore docs, and
      // `_`-prefixed destructured vars are used to drop fields (e.g.
      // `const { updatedAt: _a, ...rest } = doc`). Allow both here only;
      // src/ keeps the strict rules.
      files: ["test/**/*.ts"],
      rules: {
        "@typescript-eslint/no-explicit-any": "off",
        "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }],
      },
    },
    {
      // Scrapers module boundary (issue #91). Code outside src/scrapers/ may
      // import only the module's public entry points, `scrapers` (index.ts:
      // runtime) and `scrapers/types` (types only), never a file inside one of
      // its areas (scrapers/shared/**, scrapers/visa-catalog/**,
      // scrapers/news/**). The module itself, its tests (test/scrapers/**) and
      // the shared test helpers (test/helpers/**, which patch scraper services
      // for the fakes) are exempt. See src/scrapers/README.md.
      files: ["**/*.ts"],
      excludedFiles: ["src/scrapers/**", "test/scrapers/**", "test/helpers/**"],
      rules: {
        "no-restricted-imports": ["error", {
          patterns: [{
            group: ["**/scrapers/*/**"],
            message: "Import the scrapers module through its public API (`scrapers` or `scrapers/types`), not its internals. See src/scrapers/README.md.",
          }],
        }],
      },
    },
  ],
};
