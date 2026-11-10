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
    // tsconfig.test.json also covers eval/ (linted, never built into lib/).
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
  ],
};
