const { defineConfig } = require('cypress');

module.exports = defineConfig({
  e2e: {
    // Base URL is set via CYPRESS_BASE_URL env var in CI
    // Locally: npx cypress open --config baseUrl=http://localhost:3000
    baseUrl: process.env.CYPRESS_BASE_URL || 'http://localhost:3000',

    // Test files location
    specPattern: 'cypress/e2e/**/*.cy.js',
    supportFile: 'cypress/support/e2e.js',

    // Timeouts (staging can be slower than local)
    defaultCommandTimeout: 10000,
    requestTimeout: 15000,
    responseTimeout: 15000,
    pageLoadTimeout: 30000,

    // Retry failed tests (flaky network in CI)
    retries: {
      runMode: 2,    // Retries in CI (headless)
      openMode: 0    // No retries in interactive mode
    },

    // Video and screenshots for debugging failed CI runs
    video: false,
    screenshotOnRunFailure: true,
    screenshotsFolder: 'cypress/screenshots',

    // Don't fail on uncaught exceptions from the app
    // (we test behavior, not console errors)
    setupNodeEvents(on, config) {
      on('task', {
        log(message) {
          console.log(message);
          return null;
        }
      });
    }
  }
});
