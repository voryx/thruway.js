// The vendored router setups are plain JavaScript run by Node outside the TypeScript projects (inside the router
// containers, or by hand against a router): ESLint 10 finds this config before the root one for every file below
// test/routers/, so they are linted with the recommended JavaScript rules and no type information.
import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 'latest', globals: { ...globals.node } },
    // the recorded probe scripts swallow socket errors on purpose and keep unused handles for readability
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { caughtErrors: 'none', varsIgnorePattern: '^_' }],
    },
  },
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs' } },
];
