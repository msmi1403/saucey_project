const { describe, test, expect, beforeEach } = require('@jest/globals');

// Mock all external dependencies
jest.mock('@saucey/shared/services/firestoreHelper', () => ({
    getDocument: jest.fn(),
    setDocument: jest.fn(),
    updateDocument: jest.fn(),
    getCollection: jest.fn()
}));

jest.mock('firebase-functions/v2', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    }
}));

// Import only what we can test reliably
// Removed complex service dependencies that require more setup

describe('Optimized Meal Plan Generation Integration', () => {
    let cacheManager;
    let promptFormatter;
    let cookbookSelector;
    let varietyTracker;
    let preferenceAnalyzer;

    const mockUserId = 'integration-test-user';
    const mockUserProfile = {
        userId: mockUserId,
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
        cookingPatterns: {
            frequency: 'regular',
            preferredDays: ['Sunday', 'Wednesday', 'Friday'],
            avgCookTime: 45
        },
        dataQuality: { hasGoodData: true }
    };

    const mockCookbookRecipes = [
        {
            recipeId: 'cookbook-1',
            title: 'Italian Chicken Parmesan',
            cuisine: 'Italian',
            ingredients: [
                { item_name: 'chicken breast' },
                { item_name: 'tomato sauce' },
                { item_name: 'mozzarella cheese' }
            ],
            total_time: '45 minutes',
            averageRating: 4.5,
            cookedCount: 2
        },
        {
            recipeId: 'cookbook-2',
            title: 'Mexican Fish Tacos',
            cuisine: 'Mexican',
            ingredients: [
                { item_name: 'white fish' },
                { item_name: 'corn tortillas' },
                { item_name: 'lime' }
            ],
            total_time: '30 minutes',
            averageRating: 4.2,
            cookedCount: 1
        }
    ];

    const mockRecentMeals = [
        {
            title: 'Pasta Carbonara',
            recipeId: 'recent-1',
            keyIngredients: ['pasta', 'eggs', 'bacon'],
            usedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) // 3 days ago
        },
        {
            title: 'Beef Stir Fry',
            recipeId: 'recent-2',
            keyIngredients: ['beef', 'vegetables', 'soy sauce'],
            usedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // 1 week ago
        }
    ];

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('End-to-End Optimized Workflow', () => {
        test('should complete full workflow with cached preferences', async () => {
            // Setup: Mock cached preferences (cache hit scenario)
            const cachedProfile = {
                profile: mockUserProfile,
                cacheMetadata: {
                    lastUpdated: Date.now() - (5 * 60 * 60 * 1000), // 5 hours ago
                    generatedAt: mockUserProfile.generatedAt
                }
            };

            firestoreHelper.getDocument.mockResolvedValue(cachedProfile);
            firestoreHelper.getCollection
                .mockResolvedValueOnce([]) // No recent activity for cache invalidation
                .mockResolvedValueOnce(mockRecentMeals) // Recent meals for variety tracking
                .mockResolvedValueOnce(mockCookbookRecipes); // User's cookbook recipes

            // Execute the workflow
            const startTime = Date.now();

            // Step 1: Get cached user preferences
            const userProfile = await cacheManager.getCachedUserPreferences(
                mockUserId,
                preferenceAnalyzer.generateUserPreferenceProfile.bind(preferenceAnalyzer)
            );

            // Step 2: Get recent meals for variety tracking
            const recentMeals = await varietyTracker.getRecentlyUsedRecipes(mockUserId, 4);

            // Step 3: Calculate recipe distribution (new ratios)
            const { cookbookCount, aiCount } = cookbookSelector.calculateRecipeDistribution('balancedMix', 10);

            // Step 4: Select optimal cookbook recipes
            const selectedCookbookRecipes = await cookbookSelector.selectOptimalCookbookRecipes(
                mockUserId,
                cookbookCount,
                userProfile,
                { targetMacros: { calories: 2000 } },
                recentMeals.map(m => m.recipeId)
            );

            // Step 5: Generate variety guidance
            const varietyGuidance = varietyTracker.generateVarietyGuidanceForPrompt(recentMeals);

            // Step 6: Format optimized prompt
            const personalizationPrompt = promptFormatter.formatPersonalizationPrompt(
                userProfile,
                selectedCookbookRecipes,
                varietyGuidance
            );

            const endTime = Date.now();

            // Assertions
            expect(userProfile).toEqual(mockUserProfile);
            expect(recentMeals).toHaveLength(2);
            expect(cookbookCount).toBe(7); // 70% of 10 with new ratios
            expect(aiCount).toBe(3); // 30% of 10
            expect(selectedCookbookRecipes).toHaveLength(2); // All available cookbook recipes selected
            expect(varietyGuidance).toHaveProperty('recentCuisines');
            expect(personalizationPrompt).toContain('USER_PREFS:');
            expect(personalizationPrompt).toContain('COOKBOOK:');

            // Performance assertion - should complete quickly with cache hit
            expect(endTime - startTime).toBeLessThan(100);

            // Verify cache was used (no fresh generation)
            expect(preferenceAnalyzer.generateUserPreferenceProfile).not.toHaveBeenCalled();
        });

        test('should complete full workflow without cache (fresh generation)', async () => {
            // Setup: No cache exists
            firestoreHelper.getDocument.mockResolvedValue(null);
            firestoreHelper.getCollection
                .mockResolvedValueOnce([]) // Empty cookbook for preference generation
                .mockResolvedValueOnce([]) // Empty cook logs
                .mockResolvedValueOnce([]) // Empty view history
                .mockResolvedValueOnce(mockRecentMeals) // Recent meals for variety
                .mockResolvedValueOnce(mockCookbookRecipes); // Cookbook recipes for selection

            // Mock preference generation
            const mockGenerateProfile = jest.fn().mockResolvedValue(mockUserProfile);

            const startTime = Date.now();

            // Execute workflow
            const userProfile = await cacheManager.getCachedUserPreferences(mockUserId, mockGenerateProfile);
            const recentMeals = await varietyTracker.getRecentlyUsedRecipes(mockUserId, 4);
            const { cookbookCount, aiCount } = cookbookSelector.calculateRecipeDistribution('discoverNew', 10);
            const selectedCookbookRecipes = await cookbookSelector.selectOptimalCookbookRecipes(
                mockUserId, cookbookCount, userProfile, {}, []
            );
            const varietyGuidance = varietyTracker.generateVarietyGuidanceForPrompt(recentMeals);
            const personalizationPrompt = promptFormatter.formatPersonalizationPrompt(
                userProfile, selectedCookbookRecipes, varietyGuidance
            );

            const endTime = Date.now();

            // Assertions
            expect(mockGenerateProfile).toHaveBeenCalledWith(mockUserId);
            expect(cookbookCount).toBe(4); // 40% of 10 with new discoverNew ratio
            expect(aiCount).toBe(6); // 60% of 10
            expect(firestoreHelper.setDocument).toHaveBeenCalled(); // Profile was cached

            // Should take longer without cache but still reasonable
            expect(endTime - startTime).toBeLessThan(500);
        });
    });

    describe('Token Efficiency Validation', () => {
        test('should generate more efficient prompts than legacy format', () => {
            const mockCookbookRecipes = [
                {
                    title: 'Italian Chicken Parmesan',
                    cuisine: 'Italian',
                    ingredients: [{ item_name: 'chicken' }, { item_name: 'tomato' }]
                }
            ];

            const mockVarietyGuidance = {
                recentCuisines: ['Italian'],
                recentProteins: ['chicken'],
                recommendedCuisines: ['Mexican']
            };

            const optimizedPrompt = promptFormatter.formatPersonalizationPrompt(
                mockUserProfile,
                mockCookbookRecipes,
                mockVarietyGuidance
            );

            const legacyPrompt = promptFormatter.formatNaturalLanguagePrompt(
                mockUserProfile,
                mockCookbookRecipes
            );

            const optimizedTokens = promptFormatter.estimateTokenCount(optimizedPrompt);
            const legacyTokens = promptFormatter.estimateTokenCount(legacyPrompt);

            expect(optimizedTokens).toBeLessThan(legacyTokens * 0.9); // At least 10% reduction
            expect(optimizedPrompt).toContain('USER_PREFS:');
            expect(optimizedPrompt).toContain('COOKBOOK:');
            expect(promptFormatter.isWithinTokenLimits(optimizedPrompt)).toBe(true);
        });

        test('should maintain prompt quality despite token optimization', () => {
            const varietyGuidance = varietyTracker.generateVarietyGuidanceForPrompt(mockRecentMeals);
            const prompt = promptFormatter.formatPersonalizationPrompt(
                mockUserProfile,
                mockCookbookRecipes,
                varietyGuidance
            );

            // Should contain all essential information
            expect(prompt).toContain('CUISINES:[Italian,Mexican]');
            expect(prompt).toContain('PROTEINS:[chicken,fish]');
            expect(prompt).toContain('COMPLEXITY:medium');
            expect(prompt).toContain('Italian Chicken Parmesan');
            expect(prompt).toContain('Mexican Fish Tacos');
            expect(prompt).toContain('recent_cuisines:');
            expect(prompt).toContain('freq:regular');
        });
    });

    describe('Recipe Ratio Validation', () => {
        test('should use updated ratios consistently', () => {
            // Test new ratios
            expect(cookbookSelector.recipeSourceRatios).toEqual({
                'cookbookOnly': { cookbook: 1.0, ai: 0.0 },
                'balancedMix': { cookbook: 0.7, ai: 0.3 },
                'discoverNew': { cookbook: 0.4, ai: 0.6 }
            });

            // Test distribution calculations
            const balancedResult = cookbookSelector.calculateRecipeDistribution('balancedMix', 10);
            expect(balancedResult).toEqual({ cookbookCount: 7, aiCount: 3 });

            const discoverResult = cookbookSelector.calculateRecipeDistribution('discoverNew', 10);
            expect(discoverResult).toEqual({ cookbookCount: 4, aiCount: 6 });
        });
    });

    describe('Cache Performance Validation', () => {
        test('should demonstrate caching benefits', async () => {
            // Test cache hit scenario
            const cachedProfile = {
                profile: mockUserProfile,
                cacheMetadata: { lastUpdated: Date.now() - 1000 }
            };
            firestoreHelper.getDocument.mockResolvedValue(cachedProfile);
            firestoreHelper.getCollection.mockResolvedValue([]);

            const mockGenerateFunction = jest.fn();
            const startTime = Date.now();
            const result = await cacheManager.getCachedUserPreferences(mockUserId, mockGenerateFunction);
            const endTime = Date.now();

            expect(result).toEqual(mockUserProfile);
            expect(mockGenerateFunction).not.toHaveBeenCalled(); // Cache hit
            expect(endTime - startTime).toBeLessThan(50); // Fast cache retrieval
        });

        test('should trigger background updates for stale cache', async () => {
            const staleCache = {
                profile: mockUserProfile,
                cacheMetadata: {
                    lastUpdated: Date.now() - (19 * 60 * 60 * 1000) // 19 hours ago (stale)
                }
            };

            firestoreHelper.getDocument.mockResolvedValue(staleCache);
            firestoreHelper.getCollection.mockResolvedValue([]);

            const mockGenerateFunction = jest.fn().mockResolvedValue(mockUserProfile);

            // Mock setImmediate to capture background update
            const originalSetImmediate = global.setImmediate;
            const backgroundUpdates = [];
            global.setImmediate = jest.fn((callback) => {
                backgroundUpdates.push(callback);
                callback(); // Execute immediately for test
            });

            await cacheManager.getCachedUserPreferences(mockUserId, mockGenerateFunction);

            expect(backgroundUpdates).toHaveLength(1);
            expect(global.setImmediate).toHaveBeenCalled();

            // Restore original
            global.setImmediate = originalSetImmediate;
        });
    });

    describe('Error Handling and Resilience', () => {
        test('should handle service failures gracefully', () => {
            // Test with corrupted data
            const fallbackPrompt = promptFormatter.formatPersonalizationPrompt(null, null, null);
            
            expect(fallbackPrompt).toBe('USER_PREFS:{general_variety} COOKBOOK:none_selected');
            expect(promptFormatter.isWithinTokenLimits(fallbackPrompt)).toBe(true);
        });
    });

    describe('Data Quality and Validation', () => {
        test('should maintain format consistency', () => {
            const mockRecipes = [{ title: 'Test Recipe', cuisine: 'Italian' }];
            const mockGuidance = { recentCuisines: ['Italian'] };

            // Multiple generations should be identical
            const prompt1 = promptFormatter.formatPersonalizationPrompt(mockUserProfile, mockRecipes, mockGuidance);
            const prompt2 = promptFormatter.formatPersonalizationPrompt(mockUserProfile, mockRecipes, mockGuidance);

            expect(prompt1).toBe(prompt2);
            expect(prompt1).toMatch(/^USER_PREFS:\{.*\}/);
        });

        test('should maintain data consistency across services', async () => {
            firestoreHelper.getCollection
                .mockResolvedValueOnce(mockRecentMeals)
                .mockResolvedValueOnce(mockCookbookRecipes);

            const recentMeals = await varietyTracker.getRecentlyUsedRecipes(mockUserId, 4);
            const varietyGuidance = varietyTracker.generateVarietyGuidanceForPrompt(recentMeals);
            const { cookbookCount } = cookbookSelector.calculateRecipeDistribution('balancedMix', 10);
            const selectedRecipes = await cookbookSelector.selectOptimalCookbookRecipes(
                mockUserId, cookbookCount, mockUserProfile, {}, recentMeals.map(m => m.recipeId)
            );

            // Verify data flows correctly between services
            expect(recentMeals.every(meal => meal.recipeId)).toBe(true);
            expect(varietyGuidance.recentCuisines).toBeDefined();
            expect(selectedRecipes.every(recipe => recipe.score !== undefined)).toBe(true);
            expect(selectedRecipes.length).toBeLessThanOrEqual(cookbookCount);
        });

        test('should validate core optimization features work together', () => {
            const mockRecipes = [{ title: 'Test Recipe', cuisine: 'Italian' }];
            const mockGuidance = { recentCuisines: ['Italian'] };

            // Test integration of components
            const prompt = promptFormatter.formatPersonalizationPrompt(mockUserProfile, mockRecipes, mockGuidance);

            // Verify everything works together
            expect(prompt).toContain('USER_PREFS:');
            expect(prompt).toContain('COOKBOOK:');
            expect(promptFormatter.isWithinTokenLimits(prompt)).toBe(true);
        });
    });
}); 