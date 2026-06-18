/// <reference types="cypress" />

/**
 * Health & Readiness Checks
 * 
 * These are the first tests that run after a staging deploy.
 * If these fail, everything else is irrelevant — the app isn't running.
 * 
 * WHY THIS MATTERS:
 * - /health tells us the Node process is alive
 * - /ready tells us the database connection is working
 * - Together they confirm the deploy actually succeeded
 */
describe('Application Health', () => {
  it('should return healthy status', () => {
    cy.request('/health').then((response) => {
      expect(response.status).to.eq(200);
      expect(response.body).to.have.property('status', 'ok');
      expect(response.body).to.have.property('uptime');
      expect(response.body.uptime).to.be.greaterThan(0);
    });
  });

  it('should return ready status (database connected)', () => {
    cy.request('/ready').then((response) => {
      expect(response.status).to.eq(200);
      expect(response.body).to.have.property('status', 'ready');
      expect(response.body).to.have.property('database', 'connected');
    });
  });

  it('should serve the frontend HTML', () => {
    cy.visit('/');
    cy.get('body').should('be.visible');
  });

  it('should return proper security headers', () => {
    cy.request('/health').then((response) => {
      const headers = response.headers;
      // Helmet.js should set these
      expect(headers).to.have.property('x-content-type-options', 'nosniff');
      expect(headers).to.have.property('x-frame-options');
    });
  });
});
