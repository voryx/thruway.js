// ESLint 10 flat config: typescript-eslint 8.72 strictTypeChecked + stylisticTypeChecked through the TS 6 API package
// (`typescript` = @typescript/typescript6), with projectService over the solution tsconfig, so src, test, config files
// and scripts are all linted with type information. eslint-plugin-es-x keeps src/** inside ES2020 (Hermes, untranspiled
// consumers); the emitted output is checked again by scripts/es2020-check.mjs.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import esX from 'eslint-plugin-es-x';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['dist/', 'coverage/', 'reports/', '.stryker-tmp/', '.vitest/', '*.tgz']),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
    },
  },
  {
    // ES2020 output rules for the library sources. TypeScript property declarations are allowed: with
    // `useDefineForClassFields: false` they compile to constructor assignments (and `declare` fields to nothing);
    // `#private`, static blocks and every other post-ES2020 feature stay forbidden.
    files: ['src/**/*.ts'],
    extends: [esX.configs['flat/restrict-to-es2020']],
    rules: {
      'es-x/no-class-instance-fields': 'off',
      'es-x/no-class-static-fields': 'off',
    },
  },
  {
    // The public API mirrors RxJS on purpose: `any` in observer callbacks and payload defaults, and type parameters
    // that only shape a result type (`call<A, K>()`, `topic<A, K>()`).
    files: ['src/types.ts', 'src/client.ts', 'src/errors.ts', 'src/rxjs/index.ts', 'src/observable/observable.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
    },
  },
  {
    files: ['test/**/*.ts', '*.config.ts', '*.config.mjs', 'scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // The canary must not compile (scripts/typecheck.mjs proves it fails), so it is in no project: lint it without
    // type information.
    files: ['test/types/canary-fail.test-d.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { parserOptions: { projectService: false } },
  },
  prettier,
);
