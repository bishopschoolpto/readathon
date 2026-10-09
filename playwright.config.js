// UI tests run against the dev server with a fresh in-memory store and a fixed date.
const { defineConfig } = require('@playwright/test');

const PORT = 8099;

module.exports = defineConfig({
  testDir: 'tests/ui',
  timeout: 30000,
  use: { baseURL: `http://localhost:${PORT}`, browserName: 'chromium' },
  webServer: {
    command: 'node dev/server.js',
    port: PORT,
    reuseExistingServer: false,
    env: { PORT: String(PORT), DEV_DATA: ':memory:', DEV_TODAY: '2026-10-09', DEV_ADMINS: 'organizer@example.com' },
  },
});
