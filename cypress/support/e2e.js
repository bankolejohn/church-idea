// ***********************************************************
// Global configuration and behavior for Cypress E2E tests
// ***********************************************************

// Don't fail tests on uncaught application errors
// (we're testing user flows, not catching console bugs here)
Cypress.on('uncaught:exception', (err, runnable) => {
  // Return false to prevent Cypress from failing the test
  return false;
});

// Custom command: Login via API (fast, no UI interaction needed)
Cypress.Commands.add('loginViaApi', (username, password) => {
  cy.request({
    method: 'POST',
    url: '/api/login',
    body: { username, password },
    failOnStatusCode: false
  }).then((response) => {
    if (response.status === 200) {
      window.localStorage.setItem('token', response.body.token);
    }
    return response;
  });
});

// Custom command: API request with auth token
Cypress.Commands.add('apiRequest', (method, url, body = null) => {
  const token = window.localStorage.getItem('token');
  const options = {
    method,
    url,
    headers: { Authorization: `Bearer ${token}` },
    failOnStatusCode: false
  };
  if (body) options.body = body;
  return cy.request(options);
});
