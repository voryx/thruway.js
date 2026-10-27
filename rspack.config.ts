// rspack 2.2.9 browser bundles, built from src/bundle.ts (root surface + `auth` namespace):
//   dist/browser/thruway.js      UMD, global `thruway`, unminified
//   dist/browser/thruway.min.js  UMD, minified (gzip budget: scripts/size-check.mjs)
//   dist/browser/thruway.mjs     single-file ESM (`modern-module`)
// `target: ['web', 'es2020']`; builtin:swc-loader with `useDefineForClassFields: false` (the class-field semantics of
// the tsc builds); NodeNext `./x.js` specifiers resolve to `.ts` sources. scripts/build.mjs writes
// dist/browser/package.json {"type":"commonjs"}.
//
// The Symbol.observable ponyfill is the package's only side-effect module. package.json `sideEffects` names its dist
// copies, which rspack never sees (it bundles src/), so `moduleRules` pins the src module as side-effectful: `import
// './observable/symbol-observable.js'` in index.ts must run at bundle load even if no export of the module were used
// (asserted by test/package/bundle-semantics.test.ts).
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@rspack/cli';
import { rspack, type RspackOptions, type RuleSetRule } from '@rspack/core';

const outputPath = fileURLToPath(new URL('./dist/browser', import.meta.url));
const sources = fileURLToPath(new URL('./src/', import.meta.url));

/** The module rules of every bundle (exported for the bundle-semantics test, which builds with the same loader). */
export const moduleRules: RuleSetRule[] = [
  {
    test: /\.ts$/,
    include: [sources],
    loader: 'builtin:swc-loader',
    options: {
      jsc: {
        parser: { syntax: 'typescript' },
        transform: { useDefineForClassFields: false },
      },
    },
    type: 'javascript/auto',
  },
  { test: /[\\/]src[\\/]observable[\\/]symbol-observable\.ts$/, include: [sources], sideEffects: true },
];

/** The minifier of thruway.min.js. Class names are kept, so `error.constructor.name` (stack headers, error reporters,
 *  devtools) reads `WampError` as in the tsc builds, not a mangled `y` (+0.3 kB gzip). */
export const minimizer = (): NonNullable<RspackOptions['optimization']> => ({
  minimize: true,
  minimizer: [
    new rspack.SwcJsMinimizerRspackPlugin({
      minimizerOptions: {
        format: { comments: false },
        compress: { keep_classnames: true },
        mangle: { keep_classnames: true },
      },
      extractComments: false,
    }),
  ],
});

export const resolve: NonNullable<RspackOptions['resolve']> = {
  extensions: ['.ts', '.js'],
  extensionAlias: { '.js': ['.ts', '.js'] },
};

const base = (minify: boolean): RspackOptions => ({
  mode: 'production',
  entry: { thruway: './src/bundle.ts' },
  target: ['web', 'es2020'],
  devtool: 'source-map',
  resolve,
  module: { rules: moduleRules },
  optimization: minify ? minimizer() : { minimize: false },
  performance: { hints: false },
});

const umd = (minify: boolean): RspackOptions => ({
  ...base(minify),
  name: minify ? 'umd-min' : 'umd',
  output: {
    path: outputPath,
    filename: minify ? '[name].min.js' : '[name].js',
    library: { type: 'umd', name: 'thruway', umdNamedDefine: true },
    globalObject: 'globalThis',
    clean: false,
  },
});

const esm: RspackOptions = {
  ...base(false),
  name: 'esm-bundle',
  output: {
    path: outputPath,
    filename: '[name].mjs',
    module: true,
    library: { type: 'modern-module' },
    clean: false,
  },
  optimization: { minimize: false, concatenateModules: true, avoidEntryIife: true },
};

export default defineConfig([umd(false), umd(true), esm]);
