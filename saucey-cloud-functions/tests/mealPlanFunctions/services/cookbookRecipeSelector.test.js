const { describe, test, expect, beforeEach } = require('@jest/globals');

// Mock firestoreHelper
jest.mock('@saucey/shared/services/firestoreHelper', () => ({
    getCollection: jest.fn()
}));

// Mock logger
jest.mock('firebase-functions/v2', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    }
}));

const { CookbookRecipeSelector } = require('../../../mealPlanFunctions/services/cookbookRecipeSelector');
const firestoreHelper = require('@saucey/shared/services/firestoreHelper');

describe('CookbookRecipeSelector', () => {
    let selector;
    const mockUserId = 'test-user-123';

    beforeEach(() => {
        selector = new CookbookRecipeSelector();
        jest.clearAllMocks();
    });

    const mockUserProfile = {
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
        recentFavorites: []
    };

    const mockCookbookRecipes = [
        {
            recipeId: 'recipe-1',
            title: 'Chicken Parmesan',
            cuisine: 'Italian',
            ingredients: [
                { item_name: 'chicken breast' },
                { item_name: 'tomato sauce' }
            ],
            total_time: '45 minutes',
            averageRating: 4.5,
            cookedCount: 3,
            category: 'main_dish'
        },
        {
            recipeId: 'recipe-2',
            title: 'Fish Tacos',
            cuisine: 'Mexican',
            ingredients: [
                { item_name: 'white fish' },
                { item_name: 'corn tortillas' }
            ],
            total_time: '30 minutes',
            averageRating: 4.2,
            cookedCount: 1,
            category: 'main_dish'
        },
        {
            recipeId: 'recipe-3',
            title: 'Asian Stir Fry',
            cuisine: 'Asian',
            ingredients: [
                { item_name: 'mixed vegetables' },
                { item_name: 'soy sauce' }
            ],
            total_time: '20 minutes',
            averageRating: 4.0,
            cookedCount: 0,
            category: 'main_dish'
        }
    ];

    describe('constructor and ratios', () => {
        test('should have updated recipe source ratios based on research', () => {
            expect(selector.recipeSourceRatios).toEqual({
                'cookbookOnly': { cookbook: 1.0, ai: 0.0 },
                'balancedMix': { cookbook: 0.7, ai: 0.3 },  // Updated from 0.5/0.5
                'discoverNew': { cookbook: 0.4, ai: 0.6 }   // Updated from 0.2/0.8
            });
        });
    });

    describe('calculateRecipeDistribution', () => {
        test('should calculate correct distribution for balancedMix', () => {
            const result = selector.calculateRecipeDistribution('balancedMix', 10);

            expect(result).toEqual({
                cookbookCount: 7,  // 70% of 10
                aiCount: 3         // Remaining 30%
            });
        });

        test('should calculate correct distribution for discoverNew', () => {
            const result = selector.calculateRecipeDistribution('discoverNew', 10);

            expect(result).toEqual({
                cookbookCount: 4,  // 40% of 10
                aiCount: 6         // Remaining 60%
            });
        });

        test('should calculate correct distribution for cookbookOnly', () => {
            const result = selector.calculateRecipeDistribution('cookbookOnly', 10);

            expect(result).toEqual({
                cookbookCount: 10, // 100% of 10
                aiCount: 0         // 0%
            });
        });

        test('should handle fractional results correctly', () => {
            const result = selector.calculateRecipeDistribution('balancedMix', 5);

            expect(result).toEqual({
                cookbookCount: 3,  // Math.floor(5 * 0.7) = 3
                aiCount: 2         // 5 - 3 = 2
            });
        });

        test('should use balancedMix as default for unknown priority', () => {
            const result = selector.calculateRecipeDistribution('unknown', 10);

            expect(result).toEqual({
                cookbookCount: 7,  // Same as balancedMix
                aiCount: 3
            });
        });

        test('should ensure total adds up correctly', () => {
            const result = selector.calculateRecipeDistribution('discoverNew', 7);

            expect(result.cookbookCount + result.aiCount).toBe(7);
        });
    });

    describe('selectOptimalCookbookRecipes', () => {
        beforeEach(() => {
            firestoreHelper.getCollection.mockResolvedValue(mockCookbookRecipes);
        });

        test('should return empty array when no recipes needed', async () => {
            const result = await selector.selectOptimalCookbookRecipes(
                mockUserId, 0, mockUserProfile, {}, []
            );

            expect(result).toEqual([]);
            expect(firestoreHelper.getCollection).not.toHaveBeenCalled();
        });

        test('should return empty array when no cookbook recipes found', async () => {
            firestoreHelper.getCollection.mockResolvedValue([]);

            const result = await selector.selectOptimalCookbookRecipes(
                mockUserId, 2, mockUserProfile, {}, []
            );

            expect(result).toEqual([]);
        });

        test('should select top-scored recipes', async () => {
            const result = await selector.selectOptimalCookbookRecipes(
                mockUserId, 2, mockUserProfile, {}, []
            );

            expect(result).toHaveLength(2);
            expect(result[0]).toHaveProperty('score');
            expect(result[1]).toHaveProperty('score');
            expect(result[0].score).toBeGreaterThanOrEqual(result[1].score); // Sorted by score
        });

        test('should prefer recipes matching user preferences', async () => {
            const result = await selector.selectOptimalCookbookRecipes(
                mockUserId, 3, mockUserProfile, {}, []
            );

            // Should prefer Italian and Mexican recipes due to user profile
            const selectedTitles = result.map(r => r.title);
            expect(selectedTitles).toContain('Chicken Parmesan'); // Italian + chicken
            expect(selectedTitles).toContain('Fish Tacos'); // Mexican + fish
        });

        test('should handle recent usage penalty', async () => {
            const recentlyUsed = ['recipe-1']; // Chicken Parmesan was recently used

            const result = await selector.selectOptimalCookbookRecipes(
                mockUserId, 2, mockUserProfile, {}, recentlyUsed
            );

            // Should penalize recently used recipes
            const chickenParmesan = result.find(r => r.recipeId === 'recipe-1');
            const fishTacos = result.find(r => r.recipeId === 'recipe-2');

            if (chickenParmesan && fishTacos) {
                expect(fishTacos.score).toBeGreaterThan(chickenParmesan.score);
            }
        });

        test('should handle errors gracefully', async () => {
            firestoreHelper.getCollection.mockRejectedValue(new Error('Firestore error'));

            const result = await selector.selectOptimalCookbookRecipes(
                mockUserId, 2, mockUserProfile, {}, []
            );

            expect(result).toEqual([]);
        });
    });

    describe('scoreRecipeForContext', () => {
        const mockMealContext = {
            targetMacros: { calories: 500 },
            mealType: 'dinner',
            maxCookTime: 60,
            cuisinePreference: 'Italian'
        };

        test('should score recipes between 0 and 10', () => {
            const recipe = mockCookbookRecipes[0];
            const score = selector.scoreRecipeForContext(recipe, mockMealContext, mockUserProfile, []);

            expect(score).toBeGreaterThanOrEqual(0);
            expect(score).toBeLessThanOrEqual(10);
        });

        test('should give higher scores to preferred cuisines', () => {
            const italianRecipe = mockCookbookRecipes[0]; // Italian
            const asianRecipe = mockCookbookRecipes[2]; // Asian

            const italianScore = selector.scoreRecipeForContext(italianRecipe, mockMealContext, mockUserProfile, []);
            const asianScore = selector.scoreRecipeForContext(asianRecipe, mockMealContext, mockUserProfile, []);

            expect(italianScore).toBeGreaterThan(asianScore);
        });

        test('should penalize recently used recipes', () => {
            const recipe = mockCookbookRecipes[0];
            const recentlyUsed = ['recipe-1'];

            const scoreWithoutPenalty = selector.scoreRecipeForContext(recipe, mockMealContext, mockUserProfile, []);
            const scoreWithPenalty = selector.scoreRecipeForContext(recipe, mockMealContext, mockUserProfile, recentlyUsed);

            expect(scoreWithPenalty).toBeLessThan(scoreWithoutPenalty);
        });
    });

    describe('calculateUserAffinityScore', () => {
        test('should boost score for matching cuisine', () => {
            const italianRecipe = mockCookbookRecipes[0];
            const asianRecipe = mockCookbookRecipes[2];

            const italianScore = selector.calculateUserAffinityScore(italianRecipe, mockUserProfile);
            const asianScore = selector.calculateUserAffinityScore(asianRecipe, mockUserProfile);

            expect(italianScore).toBeGreaterThan(asianScore);
        });

        test('should boost score for matching protein', () => {
            const chickenRecipe = mockCookbookRecipes[0]; // Contains chicken
            const vegRecipe = mockCookbookRecipes[2]; // No preferred protein

            const chickenScore = selector.calculateUserAffinityScore(chickenRecipe, mockUserProfile);
            const vegScore = selector.calculateUserAffinityScore(vegRecipe, mockUserProfile);

            expect(chickenScore).toBeGreaterThan(vegScore);
        });

        test('should boost score for matching ingredients', () => {
            const profileWithTomato = {
                ...mockUserProfile,
                preferredIngredients: [{ ingredient: 'tomato', score: 8.0 }]
            };

            const tomatoRecipe = mockCookbookRecipes[0]; // Contains tomato sauce
            const noTomatoRecipe = mockCookbookRecipes[2]; // No tomato

            const tomatoScore = selector.calculateUserAffinityScore(tomatoRecipe, profileWithTomato);
            const noTomatoScore = selector.calculateUserAffinityScore(noTomatoRecipe, profileWithTomato);

            expect(tomatoScore).toBeGreaterThan(noTomatoScore);
        });
    });

    describe('helper methods', () => {
        test('should assess recipe complexity correctly', () => {
            const simpleRecipe = {
                ingredients: [{ item_name: 'egg' }, { item_name: 'bread' }],
                instructions: ['Step 1', 'Step 2']
            };

            const complexRecipe = {
                ingredients: Array.from({ length: 15 }, (_, i) => ({ item_name: `ingredient${i}` })),
                instructions: Array.from({ length: 10 }, (_, i) => `Step ${i + 1}`)
            };

            expect(selector.assessRecipeComplexity(simpleRecipe)).toBe('simple');
            expect(selector.assessRecipeComplexity(complexRecipe)).toBe('high');
        });

        test('should extract cook time from time strings', () => {
            expect(selector.extractCookTimeMinutes('45 minutes')).toBe(45);
            expect(selector.extractCookTimeMinutes('1 hour 30 minutes')).toBe(90);
            expect(selector.extractCookTimeMinutes('30 min')).toBe(30);
            expect(selector.extractCookTimeMinutes('invalid')).toBe(null);
        });

        test('should determine current season', () => {
            const season = selector.getCurrentSeason();
            expect(['spring', 'summer', 'fall', 'winter']).toContain(season);
        });
    });

    describe('formatSelectedRecipesForPrompt', () => {
        test('should format recipes for AI prompt', () => {
            const selectedRecipes = mockCookbookRecipes.slice(0, 2);
            const result = selector.formatSelectedRecipesForPrompt(selectedRecipes);

            expect(result).toContain('Selected cookbook recipes to include:');
            expect(result).toContain('Chicken Parmesan');
            expect(result).toContain('Fish Tacos');
            expect(result).toContain('Italian cuisine');
            expect(result).toContain('Mexican cuisine');
        });

        test('should handle empty recipe list', () => {
            const result = selector.formatSelectedRecipesForPrompt([]);

            expect(result).toBe('No cookbook recipes selected for this week.');
        });

        test('should limit ingredients shown in prompt', () => {
            const recipeWithManyIngredients = {
                ...mockCookbookRecipes[0],
                ingredients: Array.from({ length: 10 }, (_, i) => ({ item_name: `ingredient${i}` }))
            };

            const result = selector.formatSelectedRecipesForPrompt([recipeWithManyIngredients]);

            // Should only show first 5 ingredients
            const ingredientMatches = result.match(/ingredient\d+/g) || [];
            expect(ingredientMatches.length).toBeLessThanOrEqual(5);
        });
    });

    describe('performance and edge cases', () => {
        test('should handle large recipe collections efficiently', async () => {
            const largeRecipeCollection = Array.from({ length: 1000 }, (_, i) => ({
                recipeId: `recipe-${i}`,
                title: `Recipe ${i}`,
                cuisine: 'Generic',
                ingredients: [{ item_name: 'ingredient' }],
                total_time: '30 minutes',
                averageRating: 4.0,
                cookedCount: 0
            }));

            firestoreHelper.getCollection.mockResolvedValue(largeRecipeCollection);

            const startTime = Date.now();
            const result = await selector.selectOptimalCookbookRecipes(
                mockUserId, 10, mockUserProfile, {}, []
            );
            const endTime = Date.now();

            expect(result).toHaveLength(10);
            expect(endTime - startTime).toBeLessThan(1000); // Should complete within 1 second
        });

        test('should handle recipes with missing data gracefully', () => {
            const incompleteRecipe = {
                recipeId: 'incomplete',
                title: 'Incomplete Recipe'
                // Missing cuisine, ingredients, etc.
            };

            const score = selector.scoreRecipeForContext(incompleteRecipe, {}, {}, []);

            expect(typeof score).toBe('number');
            expect(score).toBeGreaterThanOrEqual(0);
            expect(score).toBeLessThanOrEqual(10);
        });
    });
}); 