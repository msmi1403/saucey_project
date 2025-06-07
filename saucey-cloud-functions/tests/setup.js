// Global test setup for Jest
// This file runs before all tests

// Mock console methods to reduce noise during testing
global.console = {
    ...console,
    // Suppress logs unless NODE_ENV is test-verbose
    log: process.env.NODE_ENV === 'test-verbose' ? console.log : jest.fn(),
    warn: process.env.NODE_ENV === 'test-verbose' ? console.warn : jest.fn(),
    info: process.env.NODE_ENV === 'test-verbose' ? console.info : jest.fn(),
    error: console.error // Always show errors
};

// Set test timeout globally
jest.setTimeout(10000);

// Mock Date.now for consistent testing
const mockDate = new Date('2024-01-15T12:00:00Z');
global.Date.now = jest.fn(() => mockDate.getTime());

// Global test utilities
global.testUtils = {
    // Helper to create mock user profiles
    createMockUserProfile: (overrides = {}) => ({
        userId: 'test-user-123',
        generatedAt: Date.now(),
        cuisineAffinities: [
            { cuisine: 'Italian', score: 8.5 },
            { cuisine: 'Mexican', score: 7.2 }
        ],
        favoriteProteins: [
            { protein: 'chicken', score: 9.1 },
            { protein: 'fish', score: 7.5 }
        ],
        preferredIngredients: [
            { ingredient: 'tomato', score: 8.0 },
            { ingredient: 'garlic', score: 7.8 }
        ],
        complexityPreference: 'medium',
        dataQuality: { hasGoodData: true },
        ...overrides
    }),

    // Helper to create mock recipe objects
    createMockRecipe: (overrides = {}) => ({
        recipeId: 'test-recipe-123',
        title: 'Test Recipe',
        cuisine: 'Italian',
        ingredients: [
            { item_name: 'ingredient1' },
            { item_name: 'ingredient2' }
        ],
        total_time: '30 minutes',
        averageRating: 4.0,
        cookedCount: 1,
        ...overrides
    }),

    // Helper to create mock meal objects
    createMockMeal: (overrides = {}) => ({
        title: 'Test Meal',
        recipeId: 'test-meal-123',
        keyIngredients: ['ingredient1', 'ingredient2'],
        usedAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // Yesterday
        ...overrides
    })
};

// Clean up after each test
afterEach(() => {
    jest.clearAllMocks();
}); 