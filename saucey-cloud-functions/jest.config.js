module.exports = {
    testEnvironment: 'node',
    collectCoverage: true,
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov', 'html'],
    testMatch: [
        '<rootDir>/tests/**/*.test.js'
    ],
    setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
    coveragePathIgnorePatterns: [
        '/node_modules/',
        '/tests/',
        '/coverage/'
    ],
    collectCoverageFrom: [
        'mealPlanFunctions/**/*.js',
        '!mealPlanFunctions/**/index.js',
        '!**/node_modules/**'
    ],
    verbose: true,
    testTimeout: 10000,
    moduleNameMapper: {
        '^@saucey/(.*)$': '<rootDir>/$1'
    }
}; 