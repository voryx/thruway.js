// Vitest project `browser`: playwright chromium + webkit (firefox best effort: BROWSERS=…), against the reference
// server and, with BROWSER_ROUTER (thruway-php in CI; crossbar on demand), real routers under podman — every target
// behind a per-test fault proxy (test/browser/global-setup.ts, commands.ts).
import { playwright } from '@vitest/browser-playwright';
import { defineProject } from 'vitest/config';
import { browserCommands } from '../browser/commands.js';

type BrowserName = 'chromium' | 'firefox' | 'webkit';
const browsers = (process.env['BROWSERS'] ?? 'chromium,webkit').split(',') as BrowserName[];

// Vitest 5.0.5's playwright provider creates every context with `ignoreHTTPSErrors: true` (contextOptions cannot
// override it). The TLS connect-failure case needs the browser's real certificate check (playwright's ignoreHTTPSErrors
// off), so the provider's context options are wrapped.
const base = playwright();
const provider: typeof base = {
  ...base,
  providerFactory(project) {
    const instance = base.providerFactory(project) as ReturnType<typeof base.providerFactory> & {
      getContextOptions(): Record<string, unknown>;
    };
    const contextOptions = instance.getContextOptions.bind(instance);
    instance.getContextOptions = () => ({ ...contextOptions(), ignoreHTTPSErrors: false });
    return instance;
  },
};

export default defineProject({
  test: {
    name: 'browser',
    include: ['test/browser/**/*.test.ts'],
    globalSetup: ['test/browser/global-setup.ts'],
    testTimeout: 30000,
    hookTimeout: 120000,
    browser: {
      enabled: true,
      headless: true,
      provider,
      instances: browsers.map((browser) => ({ browser })),
      commands: browserCommands,
    },
  },
});
