/// <reference types="cypress" />

/**
 * API Integration Tests
 * 
 * These test the core business logic endpoints against a REAL running instance.
 * Unlike unit tests (which mock the DB), these prove the full stack works:
 * app → database → response.
 * 
 * WHY THIS MATTERS:
 * - A new deploy might have a broken migration
 * - Environment variables might be misconfigured (wrong DB connection string)
 * - Network policies might block DB access
 * - ORM/query changes might work in tests but fail against real PostgreSQL
 * 
 * These tests are READ-ONLY where possible to avoid polluting staging data.
 */
describe('API Endpoints', () => {
  let authToken = null;

  before(() => {
    // Login once for all tests in this suite
    cy.request({
      method: 'POST',
      url: '/api/login',
      body: {
        username: Cypress.env('ADMIN_USERNAME') || 'admin',
        password: Cypress.env('ADMIN_PASSWORD') || 'admin123'
      },
      failOnStatusCode: false
    }).then((response) => {
      if (response.status === 200) {
        authToken = response.body.token;
      }
    });
  });

  describe('Branches', () => {
    it('should list branches (authenticated)', function () {
      if (!authToken) this.skip();

      cy.request({
        method: 'GET',
        url: '/api/branches',
        headers: { Authorization: `Bearer ${authToken}` }
      }).then((response) => {
        expect(response.status).to.eq(200);
        expect(response.body).to.be.an('array');
        // Each branch should have expected shape
        if (response.body.length > 0) {
          expect(response.body[0]).to.have.property('id');
          expect(response.body[0]).to.have.property('name');
        }
      });
    });

    it('should reject branch creation without auth', () => {
      cy.request({
        method: 'POST',
        url: '/api/branches',
        body: { name: 'Test Branch', address: '123 St', pastor_name: 'Test' },
        failOnStatusCode: false
      }).then((response) => {
        expect(response.status).to.eq(401);
      });
    });
  });

  describe('Members', () => {
    it('should list members (authenticated)', function () {
      if (!authToken) this.skip();

      cy.request({
        method: 'GET',
        url: '/api/members',
        headers: { Authorization: `Bearer ${authToken}` }
      }).then((response) => {
        expect(response.status).to.eq(200);
        expect(response.body).to.be.an('array');
      });
    });

    it('should support pagination parameters', function () {
      if (!authToken) this.skip();

      cy.request({
        method: 'GET',
        url: '/api/members?page=1&limit=10',
        headers: { Authorization: `Bearer ${authToken}` }
      }).then((response) => {
        expect(response.status).to.eq(200);
        expect(response.body).to.be.an('array');
        expect(response.body.length).to.be.at.most(10);
      });
    });

    it('should reject member creation without auth', () => {
      cy.request({
        method: 'POST',
        url: '/api/members',
        body: { name: 'Test', branch_id: 1 },
        failOnStatusCode: false
      }).then((response) => {
        expect(response.status).to.eq(401);
      });
    });
  });

  describe('Stats', () => {
    it('should return dashboard stats (authenticated)', function () {
      if (!authToken) this.skip();

      cy.request({
        method: 'GET',
        url: '/api/stats',
        headers: { Authorization: `Bearer ${authToken}` }
      }).then((response) => {
        expect(response.status).to.eq(200);
        expect(response.body).to.have.property('total_members');
        expect(response.body).to.have.property('total_branches');
        expect(response.body).to.have.property('branches');
        expect(response.body.total_members).to.be.a('number');
        expect(response.body.total_branches).to.be.a('number');
      });
    });
  });

  describe('Rate Limiting', () => {
    it('should include rate limit headers', function () {
      if (!authToken) this.skip();

      cy.request({
        method: 'GET',
        url: '/api/branches',
        headers: { Authorization: `Bearer ${authToken}` }
      }).then((response) => {
        // express-rate-limit adds these standard headers
        expect(response.headers).to.have.property('ratelimit-limit');
        expect(response.headers).to.have.property('ratelimit-remaining');
      });
    });
  });

  describe('Input Validation', () => {
    it('should reject invalid member ID format', function () {
      if (!authToken) this.skip();

      cy.request({
        method: 'PUT',
        url: '/api/members/not-a-number',
        headers: { Authorization: `Bearer ${authToken}` },
        body: { name: 'Test', branch_id: 1 },
        failOnStatusCode: false
      }).then((response) => {
        expect(response.status).to.be.oneOf([400, 403]);
      });
    });

    it('should reject overly long input', function () {
      if (!authToken) this.skip();

      const longString = 'a'.repeat(1000);
      cy.request({
        method: 'POST',
        url: '/api/login',
        body: { username: longString, password: 'test' },
        failOnStatusCode: false
      }).then((response) => {
        expect(response.status).to.eq(400);
      });
    });
  });
});
