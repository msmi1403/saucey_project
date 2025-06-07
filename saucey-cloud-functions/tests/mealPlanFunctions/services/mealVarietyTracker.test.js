const { describe, test, expect, beforeEach } = require('@jest/globals');

// Mock firestoreHelper
jest.mock('@saucey/shared/services/firestoreHelper', () => ({
    getCollection: jest.fn(),
    saveDocument: jest.fn()
}));

// Mock logger
jest.mock('firebase-functions/v2', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }
}));

const { MealVarietyTracker } = require('../../../mealPlanFunctions/services/mealVarietyTracker');
const firestoreHelper = require('@saucey/shared/services/firestoreHelper');

describe('MealVarietyTracker - Recipe Repetition Prevention', () => {
    let tracker;
    const mockUserId = 'test-user-123';

    beforeEach(() => {
        tracker = new MealVarietyTracker();
        jest.clearAllMocks();
    });

    // This is the CORE test - does it actually prevent "Lemon Herb Baked Salmon" repetition?
    describe('Recipe Repetition Prevention (Core Functionality)', () => {
        test('should heavily penalize exact recipe repetition', () => {
            const recentMeals = [
                { title: 'Lemon Herb Baked Salmon', keyIngredients: ['salmon', 'lemon'] },
                { title: 'Chicken Parmesan', keyIngredients: ['chicken', 'cheese'] },
                { title: 'Beef Tacos', keyIngredients: ['beef', 'tortillas'] }
            ];

            // Propose the same salmon recipe again
            const proposedMeal = { title: 'Lemon Herb Baked Salmon', keyIngredients: ['salmon', 'lemon'] };
            const varietyScore = tracker.calculateVarietyScore(proposedMeal, recentMeals);

            // Should get a very low variety score (high similarity = low variety)
            expect(varietyScore).toBeLessThan(2); // Very low variety score
        });

        test('should give high variety scores to completely different recipes', () => {
            const recentMeals = [
                { title: 'Lemon Herb Baked Salmon', keyIngredients: ['salmon', 'lemon'] },
                { title: 'Chicken Parmesan', keyIngredients: ['chicken', 'cheese'] },
                { title: 'Beef Tacos', keyIngredients: ['beef', 'tortillas'] }
            ];

            // Propose a completely different recipe
            const proposedMeal = { title: 'Thai Vegetable Curry', keyIngredients: ['vegetables', 'coconut milk'] };
            const varietyScore = tracker.calculateVarietyScore(proposedMeal, recentMeals);

            // Should get a high variety score
            expect(varietyScore).toBeGreaterThan(7); // High variety score
        });

        test('should detect similarity even with slight recipe name variations', () => {
            const recentMeals = [
                { title: 'Lemon Herb Baked Salmon', keyIngredients: ['salmon', 'lemon'] }
            ];

            // Test variations that should still be detected as similar
            const variations = [
                { title: 'Herb-Crusted Baked Salmon', keyIngredients: ['salmon', 'herbs'] },
                { title: 'Baked Salmon with Lemon', keyIngredients: ['salmon', 'lemon'] },
                { title: 'Lemon Garlic Salmon', keyIngredients: ['salmon', 'lemon'] }
            ];

            variations.forEach(variation => {
                const varietyScore = tracker.calculateVarietyScore(variation, recentMeals);
                // Should be penalized for similarity (low variety score)
                expect(varietyScore).toBeLessThan(5);
            });
        });
    });

    describe('Meal Similarity Detection', () => {
        test('should detect exact title matches as highly similar', () => {
            const meal1 = { title: 'Lemon Herb Baked Salmon' };
            const meal2 = { title: 'Lemon Herb Baked Salmon' };

            const similarity = tracker.calculateMealSimilarity(meal1, meal2);
            
            // Should be very high similarity (close to 0.9 for exact match)
            expect(similarity).toBeGreaterThan(0.8);
        });

        test('should detect protein similarity', () => {
            const meal1 = { title: 'Grilled Chicken Breast', keyIngredients: ['chicken'] };
            const meal2 = { title: 'Chicken Parmesan', keyIngredients: ['chicken'] };

            const similarity = tracker.calculateMealSimilarity(meal1, meal2);
            
            // Should detect chicken protein similarity
            expect(similarity).toBeGreaterThan(0.5);
        });

        test('should detect cuisine similarity', () => {
            const meal1 = { title: 'Italian Pasta Marinara' };
            const meal2 = { title: 'Italian Chicken Piccata' };

            const similarity = tracker.calculateMealSimilarity(meal1, meal2);
            
            // Should detect Italian cuisine similarity
            expect(similarity).toBeGreaterThan(0.3);
        });

        test('should assign low similarity to completely different meals', () => {
            const meal1 = { title: 'Thai Vegetable Curry', keyIngredients: ['vegetables'] };
            const meal2 = { title: 'Mexican Beef Tacos', keyIngredients: ['beef'] };

            const similarity = tracker.calculateMealSimilarity(meal1, meal2);
            
            // Should be very low similarity
            expect(similarity).toBeLessThan(0.3);
        });
    });

    describe('Variety Guidance Generation', () => {
        test('should recommend avoiding recently used cuisines', () => {
            const recentMeals = [
                { title: 'Italian Pasta', keyIngredients: ['pasta'] },
                { title: 'Italian Pizza', keyIngredients: ['cheese'] },
                { title: 'Italian Risotto', keyIngredients: ['rice'] }
            ];

            const guidance = tracker.generateVarietyGuidanceForPrompt(recentMeals);

            expect(guidance.recentCuisines).toContain('Italian');
            expect(guidance.recommendedCuisines).not.toContain('Italian');
            expect(guidance.recommendedCuisines.length).toBeGreaterThan(0);
        });

        test('should recommend avoiding recently used proteins', () => {
            const recentMeals = [
                { title: 'Grilled Chicken', keyIngredients: ['chicken'] },
                { title: 'Chicken Stir Fry', keyIngredients: ['chicken'] },
                { title: 'BBQ Chicken', keyIngredients: ['chicken'] }
            ];

            const guidance = tracker.generateVarietyGuidanceForPrompt(recentMeals);

            expect(guidance.recentProteins).toContain('chicken');
            expect(guidance.recommendedProteins).not.toContain('chicken');
        });

        test('should provide default recommendations when no recent meals', () => {
            const guidance = tracker.generateVarietyGuidanceForPrompt([]);

            expect(guidance.recentCuisines).toEqual([]);
            expect(guidance.recentProteins).toEqual([]);
            expect(guidance.recommendedCuisines).toContain('Italian');
            expect(guidance.diversityScore).toBe(10);
        });
    });

    describe('Cross-Week Variety Testing (Real World Scenario)', () => {
        test('should prevent the same recipe from appearing across multiple weeks', async () => {
            // Simulate recent meal plans with "Lemon Herb Baked Salmon" appearing multiple times
            const mockMealPlans = [
                {
                    planId: 'week1',
                    createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 1 week ago
                    days: [{
                        date: '2024-01-08',
                        meals: {
                            dinner: [{ title: 'Lemon Herb Baked Salmon', recipeId: 'salmon-123' }]
                        }
                    }]
                },
                {
                    planId: 'week2', 
                    createdAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000), // 2 weeks ago
                    days: [{
                        date: '2024-01-01',
                        meals: {
                            dinner: [{ title: 'Lemon Herb Baked Salmon', recipeId: 'salmon-123' }]
                        }
                    }]
                }
            ];

            firestoreHelper.getCollection.mockResolvedValue(mockMealPlans);

            // Get recent meals
            const recentMeals = await tracker.getRecentlyUsedRecipes(mockUserId, 4);

            // Should find the repeated salmon recipe
            expect(recentMeals.length).toBe(2);
            expect(recentMeals.filter(meal => meal.title === 'Lemon Herb Baked Salmon')).toHaveLength(2);

            // Test variety score for suggesting it again
            const proposedSalmon = { title: 'Lemon Herb Baked Salmon', keyIngredients: ['salmon'] };
            const varietyScore = tracker.calculateVarietyScore(proposedSalmon, recentMeals);

            // Should heavily penalize this repetitive choice
            expect(varietyScore).toBeLessThan(1);

            // Verify correct collection path was used - FIXED: mealPlans not meal_plans
            expect(firestoreHelper.getCollection).toHaveBeenCalledWith(
                `users/${mockUserId}/mealPlans`,
                expect.objectContaining({
                    where: expect.arrayContaining([
                        expect.objectContaining({ field: "createdAt" })
                    ])
                })
            );
        });

        test('should demonstrate meal filtering by variety', () => {
            const recentMeals = [
                { title: 'Lemon Herb Baked Salmon', keyIngredients: ['salmon'] },
                { title: 'Chicken Parmesan', keyIngredients: ['chicken'] }
            ];

            const mealSuggestions = [
                { title: 'Lemon Herb Baked Salmon', keyIngredients: ['salmon'] }, // Repeat
                { title: 'Chicken Alfredo', keyIngredients: ['chicken'] }, // Similar protein
                { title: 'Thai Beef Curry', keyIngredients: ['beef'] }, // Different
                { title: 'Vegetable Stir Fry', keyIngredients: ['vegetables'] } // Different
            ];

            const filteredSuggestions = tracker.filterByVariety(mealSuggestions, recentMeals, 2);

            // Should prioritize different meals
            expect(filteredSuggestions).toHaveLength(2);
            expect(filteredSuggestions[0].title).not.toBe('Lemon Herb Baked Salmon');
            expect(filteredSuggestions[0].varietyScore).toBeGreaterThan(filteredSuggestions[1].varietyScore);
        });
    });

    describe('Diversity Score Calculation', () => {
        test('should give high diversity score for varied meals', () => {
            const variedMeals = [
                { title: 'Thai Curry', keyIngredients: ['vegetables'] },
                { title: 'Mexican Tacos', keyIngredients: ['beef'] },
                { title: 'Italian Pasta', keyIngredients: ['chicken'] },
                { title: 'Indian Dal', keyIngredients: ['lentils'] }
            ];

            const diversityScore = tracker.calculateDiversityScore(variedMeals);
            expect(diversityScore).toBeGreaterThan(7);
        });

        test('should give low diversity score for repetitive meals', () => {
            const repetitiveMeals = [
                { title: 'Chicken Breast', keyIngredients: ['chicken'] },
                { title: 'Chicken Thighs', keyIngredients: ['chicken'] },
                { title: 'Chicken Wings', keyIngredients: ['chicken'] },
                { title: 'Grilled Chicken', keyIngredients: ['chicken'] }
            ];

            const diversityScore = tracker.calculateDiversityScore(repetitiveMeals);
            expect(diversityScore).toBeLessThan(4);
        });
    });

    describe('Error Handling', () => {
        test('should handle empty recent meals gracefully', async () => {
            firestoreHelper.getCollection.mockResolvedValue([]);

            const recentMeals = await tracker.getRecentlyUsedRecipes(mockUserId, 4);
            expect(recentMeals).toEqual([]);

            const varietyScore = tracker.calculateVarietyScore({ title: 'Any Recipe' }, []);
            expect(varietyScore).toBe(10); // Maximum variety when no history
        });

        test('should handle malformed meal data', () => {
            const recentMeals = [
                { title: null, keyIngredients: [] },
                { keyIngredients: ['chicken'] }, // No title
                {} // Empty object
            ];

            const proposedMeal = { title: 'Test Recipe' };
            
            // Should not throw and return a reasonable score
            expect(() => tracker.calculateVarietyScore(proposedMeal, recentMeals)).not.toThrow();
            const score = tracker.calculateVarietyScore(proposedMeal, recentMeals);
            expect(score).toBeGreaterThanOrEqual(0);
            expect(score).toBeLessThanOrEqual(10);
        });

        test('should handle context parameter gracefully', () => {
            const recentMeals = [{ title: 'Test Recipe', keyIngredients: ['test'] }];
            const proposedMeal = { title: 'Test Recipe', keyIngredients: ['test'] };
            
            // Test with various context scenarios
            expect(() => tracker.calculateVarietyScore(proposedMeal, recentMeals)).not.toThrow(); // No context
            expect(() => tracker.calculateVarietyScore(proposedMeal, recentMeals, {})).not.toThrow(); // Empty context
            expect(() => tracker.calculateVarietyScore(proposedMeal, recentMeals, { invalid: 'data' })).not.toThrow(); // Invalid context
            
            const score1 = tracker.calculateVarietyScore(proposedMeal, recentMeals);
            const score2 = tracker.calculateVarietyScore(proposedMeal, recentMeals, {});
            
            expect(score1).toBe(score2); // Should be same with empty context
        });
    });

    describe('Real-World Integration', () => {
        test('should work with the actual meal planning workflow', async () => {
            // Mock a realistic scenario
            const mockMealPlans = [
                {
                    planId: 'current-week',
                    createdAt: new Date(),
                    days: [
                        {
                            date: '2024-01-15',
                            meals: {
                                dinner: [{ title: 'Lemon Herb Baked Salmon', recipeId: 'salmon-1' }],
                                lunch: [{ title: 'Caesar Salad', recipeId: 'salad-1' }]
                            }
                        },
                        {
                            date: '2024-01-16', 
                            meals: {
                                dinner: [{ title: 'Chicken Parmesan', recipeId: 'chicken-1' }]
                            }
                        }
                    ]
                }
            ];

            firestoreHelper.getCollection.mockResolvedValue(mockMealPlans);

            // Step 1: Get recent meals
            const recentMeals = await tracker.getRecentlyUsedRecipes(mockUserId, 4);
            
            // Step 2: Generate variety guidance
            const guidance = tracker.generateVarietyGuidanceForPrompt(recentMeals);
            
            // Step 3: Test proposed new meals
            const proposedMeals = [
                { title: 'Lemon Herb Baked Salmon' }, // Repeat - should score low
                { title: 'Thai Green Curry' } // New - should score high
            ];

            const salmonScore = tracker.calculateVarietyScore(proposedMeals[0], recentMeals);
            const curryScore = tracker.calculateVarietyScore(proposedMeals[1], recentMeals);

            // Verify the system works as expected
            expect(recentMeals.length).toBeGreaterThan(0);
            expect(guidance).toHaveProperty('recentProteins');
            expect(salmonScore).toBeLessThan(curryScore); // New meal should score higher
            expect(salmonScore).toBeLessThan(3); // Repeat should be heavily penalized
            expect(curryScore).toBeGreaterThan(7); // New meal should score high
        });
    });

    describe('Limited Cookbook Fallback (Edge Case)', () => {
        test('should allow controlled repetition when cookbook-only with limited recipes', () => {
            const recentMeals = [
                { title: 'Chicken Breast Recipe', keyIngredients: ['chicken'] },
                { title: 'Beef Stir Fry', keyIngredients: ['beef'] }
            ];

            const proposedMeal = { title: 'Chicken Breast Recipe', keyIngredients: ['chicken'] }; // Exact repeat

            // Test 1: Normal mode (should heavily penalize)
            const normalContext = { recipeSourcePriority: 'balancedMix' };
            const normalScore = tracker.calculateVarietyScore(proposedMeal, recentMeals, normalContext);
            expect(normalScore).toBeLessThan(1); // Very low score

            // Test 2: Limited cookbook mode (should allow with reduced penalty)
            const limitedContext = {
                recipeSourcePriority: 'cookbookOnly',
                totalAvailableCookbookRecipes: 3,
                totalMealSlotsNeeded: 7
            };
            const limitedScore = tracker.calculateVarietyScore(proposedMeal, recentMeals, limitedContext);
            expect(limitedScore).toBeGreaterThanOrEqual(1.0); // Minimum score of 1.0 for eventual repetition
            expect(limitedScore).toBeGreaterThan(normalScore); // Should be higher than normal mode
        });

        test('should not use fallback when cookbook has enough recipes', () => {
            const recentMeals = [
                { title: 'Recipe 1', keyIngredients: ['chicken'] }
            ];

            const proposedMeal = { title: 'Recipe 1', keyIngredients: ['chicken'] };

            // Has enough recipes, so should use normal aggressive scoring
            const context = {
                recipeSourcePriority: 'cookbookOnly',
                totalAvailableCookbookRecipes: 10, // More than enough
                totalMealSlotsNeeded: 7
            };
            
            const score = tracker.calculateVarietyScore(proposedMeal, recentMeals, context);
            expect(score).toBeLessThan(1); // Should use normal aggressive scoring
        });

        test('should not use fallback for non-cookbook-only modes', () => {
            const recentMeals = [
                { title: 'Recipe 1', keyIngredients: ['chicken'] }
            ];

            const proposedMeal = { title: 'Recipe 1', keyIngredients: ['chicken'] };

            // Limited recipes but not cookbook-only mode
            const context = {
                recipeSourcePriority: 'balancedMix', // Not cookbook-only
                totalAvailableCookbookRecipes: 3,
                totalMealSlotsNeeded: 7
            };
            
            const score = tracker.calculateVarietyScore(proposedMeal, recentMeals, context);
            expect(score).toBeLessThan(1); // Should use normal aggressive scoring
        });

        test('should provide better scores for spaced repetitions in limited cookbook', () => {
            const proposedMeal = { title: 'Limited Recipe', keyIngredients: ['chicken'] };

            // Test with different numbers of recent meals (spacing)
            const recentMealsShort = [
                { title: 'Limited Recipe', keyIngredients: ['chicken'] }
            ];

            const recentMealsLong = [
                { title: 'Limited Recipe', keyIngredients: ['chicken'] },
                { title: 'Other Recipe 1', keyIngredients: ['beef'] },
                { title: 'Other Recipe 2', keyIngredients: ['fish'] },
                { title: 'Other Recipe 3', keyIngredients: ['pork'] }
            ];

            const limitedContext = {
                recipeSourcePriority: 'cookbookOnly',
                totalAvailableCookbookRecipes: 4,
                totalMealSlotsNeeded: 7
            };

            const shortSpacingScore = tracker.calculateVarietyScore(proposedMeal, recentMealsShort, limitedContext);
            const longSpacingScore = tracker.calculateVarietyScore(proposedMeal, recentMealsLong, limitedContext);

            // Longer spacing should get better score (more recent meals = bonus)
            expect(longSpacingScore).toBeGreaterThan(shortSpacingScore);
        });
    });
}); 