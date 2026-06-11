module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/tests/**/*.test.js'],
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov', 'clover'],
    collectCoverageFrom: [
        'server.js',
        'lib/**/*.js',
        '!node_modules/**'
    ],
    coverageThreshold: {
        global: {
            branches: 30,
            functions: 30,
            lines: 30,
            statements: 30
        }
    }
};
