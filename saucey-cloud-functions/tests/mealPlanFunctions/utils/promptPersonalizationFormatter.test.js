const { describe, test, expect, beforeEach } = require('@jest/globals');
const PromptPersonalizationFormatter = require('../../../mealPlanFunctions/utils/promptPersonalizationFormatter');

describe('PromptPersonalizationFormatter', () => {
    let formatter;

    beforeEach(() => {
        formatter = new PromptPersonalizationFormatter();
    });

    const mockUserProfile = {
        cuisineAffinities: [
            { cuisine: 'Italian', score: 8.5 },
            { cuisine: 'Mexican', score: 7.2 },
            { cuisine: 'Asian', score: 6.8 }
        ],
        favoriteProteins: [
            { protein: 'chicken', score: 9.1 },
            { protein: 'fish', score: 7.5 }
        ],
        preferredIngredients: [
            { ingredient: 'tomato', score: 8.0 },
            { ingredient: 'garlic', score: 7.8 },
            { ingredient: 'basil', score: 7.2 }
        ],
        complexityPreference: 'medium',
        cookingPatterns: {
            frequency: 'regular',
            preferredDays: ['Sunday', 'Wednesday', 'Friday'],
            avgCookTime: 45
        }
    };

    const mockCookbookRecipes = [
        {
            title: 'Lemon Herb Baked Salmon',
            cuisine: 'Mediterranean',
            ingredients: [
                { item_name: 'salmon fillet' },
                { item_name: 'fresh lemon' },
                { item_name: 'mixed herbs' }
            ]
        },
        {
            title: 'Chicken Tikka Masala',
            cuisine: 'Indian',
            ingredients: [
                { item_name: 'chicken breast' },
                { item_name: 'tomato sauce' },
                { item_name: 'curry spices' }
            ]
        }
    ];

    const mockVarietyGuidance = {
        recentCuisines: ['Italian', 'Mexican'],
        recentProteins: ['chicken', 'beef'],
        recommendedCuisines: ['Asian', 'Mediterranean'],
        recommendedProteins: ['fish'],
        diversityScore: 7
    };

    describe('formatPersonalizationPrompt', () => {
        test('should format complete prompt with all sections', () => {
            const result = formatter.formatPersonalizationPrompt(
                mockUserProfile,
                mockCookbookRecipes,
                mockVarietyGuidance
            );

            expect(result).toContain('USER_PREFS:');
            expect(result).toContain('CUISINES:[Italian,Mexican,Asian]');
            expect(result).toContain('PROTEINS:[chicken,fish]');
            expect(result).toContain('COOKBOOK:');
            expect(result).toContain('VARIETY:');
            expect(result).toContain('PATTERNS:');
        });

        test('should handle empty cookbook recipes', () => {
            const result = formatter.formatPersonalizationPrompt(
                mockUserProfile,
                [],
                mockVarietyGuidance
            );

            expect(result).toContain('COOKBOOK:none_selected');
        });

        test('should handle empty variety guidance', () => {
            const result = formatter.formatPersonalizationPrompt(
                mockUserProfile,
                mockCookbookRecipes,
                {}
            );

            expect(result).toContain('USER_PREFS:');
            expect(result).toContain('COOKBOOK:');
            expect(result).not.toContain('VARIETY:');
        });

        test('should handle minimal user profile', () => {
            const minimalProfile = {
                complexityPreference: 'simple'
            };

            const result = formatter.formatPersonalizationPrompt(
                minimalProfile,
                [],
                {}
            );

            expect(result).toContain('COMPLEXITY:simple');
            expect(result).toContain('COOKBOOK:none_selected');
        });

        test('should handle formatting errors gracefully', () => {
            // Pass malformed data
            const result = formatter.formatPersonalizationPrompt(
                null,
                null,
                null
            );

            expect(result).toBe('USER_PREFS:{general_variety} COOKBOOK:none_selected');
        });
    });

    describe('formatCorePreferences', () => {
        test('should format cuisines correctly', () => {
            const result = formatter.formatCorePreferences(mockUserProfile);

            expect(result).toContain('CUISINES:[Italian,Mexican,Asian]');
        });

        test('should limit cuisines to max count', () => {
            const profileWithManyCuisines = {
                cuisineAffinities: Array.from({ length: 10 }, (_, i) => ({
                    cuisine: `Cuisine${i}`,
                    score: 8.0
                }))
            };

            const result = formatter.formatCorePreferences(profileWithManyCuisines);
            const cuisineMatch = result.match(/CUISINES:\[([^\]]+)\]/);
            const cuisineCount = cuisineMatch ? cuisineMatch[1].split(',').length : 0;

            expect(cuisineCount).toBeLessThanOrEqual(formatter.MAX_CUISINES);
        });

        test('should format proteins correctly', () => {
            const result = formatter.formatCorePreferences(mockUserProfile);

            expect(result).toContain('PROTEINS:[chicken,fish]');
        });

        test('should format ingredients correctly', () => {
            const result = formatter.formatCorePreferences(mockUserProfile);

            expect(result).toContain('INGREDIENTS:[tomato,garlic,basil]');
        });

        test('should include complexity preference', () => {
            const result = formatter.formatCorePreferences(mockUserProfile);

            expect(result).toContain('COMPLEXITY:medium');
        });

        test('should handle empty profile gracefully', () => {
            const result = formatter.formatCorePreferences({});

            expect(result).toBe('');
        });
    });

    describe('formatCookbookRecipes', () => {
        test('should format cookbook recipes with cuisine and ingredients', () => {
            const result = formatter.formatCookbookRecipes(mockCookbookRecipes);

            expect(result).toContain('"Lemon Herb Baked Salmon"(Mediterranean)[salmon,fresh,mixed]');
            expect(result).toContain('"Chicken Tikka Masala"(Indian)[chicken,tomato,curry]');
            expect(result).toContain('|');
        });

        test('should handle recipes without cuisine', () => {
            const recipesNoCuisine = [{
                title: 'Simple Pasta',
                ingredients: [{ item_name: 'pasta' }]
            }];

            const result = formatter.formatCookbookRecipes(recipesNoCuisine);

            expect(result).toContain('"Simple Pasta"[pasta]');
            expect(result).not.toContain('()');
        });

        test('should handle recipes without ingredients', () => {
            const recipesNoIngredients = [{
                title: 'Mystery Dish',
                cuisine: 'Unknown'
            }];

            const result = formatter.formatCookbookRecipes(recipesNoIngredients);

            expect(result).toContain('"Mystery Dish"(Unknown)');
        });

        test('should limit to max cookbook recipes', () => {
            const manyRecipes = Array.from({ length: 10 }, (_, i) => ({
                title: `Recipe ${i}`,
                cuisine: 'Test'
            }));

            const result = formatter.formatCookbookRecipes(manyRecipes);
            const recipeCount = (result.match(/\|/g) || []).length + 1;

            expect(recipeCount).toBeLessThanOrEqual(formatter.MAX_COOKBOOK_RECIPES);
        });

        test('should return none_selected for empty recipes', () => {
            const result = formatter.formatCookbookRecipes([]);

            expect(result).toBe('COOKBOOK:none_selected');
        });
    });

    describe('formatVarietyGuidance', () => {
        test('should format recent cuisines and proteins', () => {
            const result = formatter.formatVarietyGuidance(mockVarietyGuidance);

            expect(result).toContain('recent_cuisines:[Italian,Mexican]');
            expect(result).toContain('recent_proteins:[chicken,beef]');
        });

        test('should format recommendations', () => {
            const result = formatter.formatVarietyGuidance(mockVarietyGuidance);

            expect(result).toContain('try:[Asian,Mediterranean]');
        });

        test('should limit arrays to max counts', () => {
            const longGuidance = {
                recentCuisines: Array.from({ length: 10 }, (_, i) => `Cuisine${i}`),
                recentProteins: Array.from({ length: 10 }, (_, i) => `Protein${i}`),
                recommendedCuisines: Array.from({ length: 10 }, (_, i) => `RecCuisine${i}`)
            };

            const result = formatter.formatVarietyGuidance(longGuidance);

            const cuisineMatch = result.match(/recent_cuisines:\[([^\]]+)\]/);
            const proteinMatch = result.match(/recent_proteins:\[([^\]]+)\]/);
            const recMatch = result.match(/try:\[([^\]]+)\]/);

            expect(cuisineMatch[1].split(',').length).toBeLessThanOrEqual(4);
            expect(proteinMatch[1].split(',').length).toBeLessThanOrEqual(3);
            expect(recMatch[1].split(',').length).toBeLessThanOrEqual(3);
        });

        test('should return empty string for empty guidance', () => {
            const result = formatter.formatVarietyGuidance({});

            expect(result).toBe('');
        });
    });

    describe('formatCookingPatterns', () => {
        test('should format cooking patterns correctly', () => {
            const result = formatter.formatCookingPatterns(mockUserProfile);

            expect(result).toContain('freq:regular');
            expect(result).toContain('days:[Sunday,Wednesday,Friday]');
            expect(result).toContain('time:45min');
        });

        test('should handle partial cooking patterns', () => {
            const partialProfile = {
                cookingPatterns: {
                    frequency: 'occasional'
                }
            };

            const result = formatter.formatCookingPatterns(partialProfile);

            expect(result).toContain('freq:occasional');
            expect(result).not.toContain('days:');
            expect(result).not.toContain('time:');
        });

        test('should return empty string for no cooking patterns', () => {
            const result = formatter.formatCookingPatterns({});

            expect(result).toBe('');
        });
    });

    describe('token estimation and validation', () => {
        test('should estimate token count reasonably', () => {
            const prompt = 'USER_PREFS:{CUISINES:[Italian,Mexican] PROTEINS:[chicken]}';
            const tokens = formatter.estimateTokenCount(prompt);

            expect(tokens).toBeGreaterThan(0);
            expect(tokens).toBeLessThan(50); // Should be much more efficient than old format
        });

        test('should validate token limits', () => {
            const shortPrompt = 'USER_PREFS:{CUISINES:[Italian]}';
            const longPrompt = 'USER_PREFS:{' + 'VERY_LONG_CONTENT_WORD '.repeat(200) + '}'; // Much longer

            expect(formatter.isWithinTokenLimits(shortPrompt)).toBe(true);
            expect(formatter.isWithinTokenLimits(longPrompt)).toBe(false);
        });
    });

    describe('formatNaturalLanguagePrompt', () => {
        test('should create readable natural language fallback', () => {
            const result = formatter.formatNaturalLanguagePrompt(
                mockUserProfile,
                mockCookbookRecipes
            );

            expect(result).toContain('User enjoys');
            expect(result).toContain('Italian, Mexican, Asian');
            expect(result).toContain('prefers chicken, fish');
            expect(result).toContain('include cookbook recipes');
            expect(result).toContain('medium complexity preferred');
        });

        test('should handle minimal data gracefully', () => {
            const result = formatter.formatNaturalLanguagePrompt({}, []);

            expect(result).toBe('Generate varied, appealing meals.');
        });

        test('should limit cookbook recipes in natural language', () => {
            const manyRecipes = Array.from({ length: 10 }, (_, i) => ({
                title: `Recipe ${i}`
            }));

            const result = formatter.formatNaturalLanguagePrompt({}, manyRecipes);
            const recipeMatches = result.match(/"Recipe \d+"/g) || [];

            expect(recipeMatches.length).toBeLessThanOrEqual(3);
        });
    });

    describe('getFallbackPrompt', () => {
        test('should provide valid fallback prompt', () => {
            const result = formatter.getFallbackPrompt();

            expect(result).toBe('USER_PREFS:{general_variety} COOKBOOK:none_selected');
        });
    });

    describe('performance characteristics', () => {
        test('should be significantly more efficient than natural language format', () => {
            const structuredPrompt = formatter.formatPersonalizationPrompt(
                mockUserProfile,
                mockCookbookRecipes,
                mockVarietyGuidance
            );

            const naturalPrompt = formatter.formatNaturalLanguagePrompt(
                mockUserProfile,
                mockCookbookRecipes
            );

            const structuredTokens = formatter.estimateTokenCount(structuredPrompt);
            const naturalTokens = formatter.estimateTokenCount(naturalPrompt);

            // Structured format should use fewer tokens (more lenient test)
            expect(structuredTokens).toBeLessThan(naturalTokens * 0.9);
        });

        test('should maintain consistent output format', () => {
            const result1 = formatter.formatPersonalizationPrompt(
                mockUserProfile,
                mockCookbookRecipes,
                mockVarietyGuidance
            );

            const result2 = formatter.formatPersonalizationPrompt(
                mockUserProfile,
                mockCookbookRecipes,
                mockVarietyGuidance
            );

            expect(result1).toBe(result2); // Should be deterministic
        });
    });
}); 