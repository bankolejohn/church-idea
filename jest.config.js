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
            branches: 10,
            functions: 10,
            lines: 10,
            statements: 10
        }
    }
};
