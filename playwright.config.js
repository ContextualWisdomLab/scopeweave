const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  retries: 0,
  use: {
    baseURL: (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/?$/, '/'),
    headless: true
  },
  webServer: {
    command: 'python3 -m http.server 4173',
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 120000
  }
});
