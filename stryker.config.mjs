// StrykerJS: the vitest runner on the `mutation` project, `coverageAnalysis: 'perTest'`, an explicit `concurrency`,
// thresholds high 90 / low 85 / break 80, the mutate globs below. The vitest runner runs every project of the config it
// loads, so it loads the mutation project file itself (no browser/node/integration/interop projects).
// `npm run test:mutation` runs it; a local run of part of the code: `npx stryker run --mutate 'src/core/**/*.ts'`.
// Surviving mutants are reviewed per file.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  packageManager: 'npm',
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'test/projects/mutation.ts', related: false },
  mutate: [
    'src/core/**/*.ts',
    'src/ops/**/*.ts',
    'src/protocol/{decode,uri,payload}.ts',
    'src/observable/{observable,subjects,input,abort}.ts',
    'src/transport/websocket.ts',
    'src/options.ts',
    'src/validate.ts',
    'src/client.ts',
  ],
  coverageAnalysis: 'perTest',
  concurrency: 8,
  thresholds: { high: 90, low: 85, break: 80 },
  reporters: ['clear-text', 'progress', 'html', 'json'],
  clearTextReporter: { allowColor: false, logTests: false },
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  tempDirName: '.stryker-tmp',
  ignorePatterns: ['dist', 'coverage', 'reports', '.vitest'],
  cleanTempDir: true,
};
export default config;
