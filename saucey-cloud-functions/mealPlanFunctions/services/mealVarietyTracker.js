const { logger } = require("firebase-functions/v2");
const firestoreHelper = require("@saucey/shared/services/firestoreHelper");

/**
 * @fileoverview Meal Variety Tracker for preventing repetitive meals
 * across weeks and ensuring diverse meal planning.
 */

class MealVarietyTracker {

    constructor() {
        // How many weeks back to check for variety
        this.varietyWindowWeeks = 4;
        
        // Weights for different similarity factors - MADE MORE AGGRESSIVE
        this.similarityWeights = {
            exactTitleMatch: 1.0,        // Increased from 0.9 - exact matches get maximum penalty
            proteinMatch: 0.7,           // Increased from 0.6 
            cuisineMatch: 0.5,           // Increased from 0.4
            mainIngredientMatch: 0.6,    // Increased from 0.5
            cookingMethodMatch: 0.4      // Increased from 0.3
        };
    }

    /**
     * Gets recently used recipes to avoid repetition
     * @param {string} userId - User identifier
     * @param {number} weeksBack - Number of weeks to look back
     * @returns {Promise<Array>} Recently used recipe data
     */
    async getRecentlyUsedRecipes(userId, weeksBack = 4) {
        try {
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - (weeksBack * 7));

            logger.info(`MealVarietyTracker: Fetching recent recipes for user ${userId} from ${cutoffDate.toISOString()}`);

            // FIXED: Use correct collection path - mealPlans (no underscore) 
            // This matches the path used in fetchMealPlan.handler.js and saveMealPlan operations
            const recentMealPlans = await firestoreHelper.getCollection(`users/${userId}/mealPlans`, {
                where: [{ field: "createdAt", operator: ">=", value: cutoffDate }],
                orderBy: [{ field: "createdAt", direction: "desc" }],
                limit: 10 // Limit to recent plans
            });

            const recentRecipes = [];
            
            // Extract all recipe titles and metadata from recent plans
            for (const plan of recentMealPlans) {
                if (plan.days && Array.isArray(plan.days)) {
                    for (const day of plan.days) {
                        if (day.meals) {
                            for (const [mealType, meals] of Object.entries(day.meals)) {
                                if (Array.isArray(meals)) {
                                    for (const meal of meals) {
                                        if (meal.title) {
                                            recentRecipes.push({
                                                title: meal.title,
                                                recipeId: meal.recipeId,
                                                source: meal.source,
                                                keyIngredients: meal.keyIngredients || [],
                                                mealType,
                                                planDate: day.date,
                                                planId: plan.planId
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            logger.info(`MealVarietyTracker: Found ${recentRecipes.length} recent recipes for variety checking`);
            return recentRecipes;

        } catch (error) {
            logger.warn(`MealVarietyTracker: Error fetching recent recipes for ${userId}:`, error);
            return [];
        }
    }

    /**
     * Calculates variety score for a proposed meal against recent meals
     * WITH SMART COOKBOOK-ONLY FALLBACK for limited recipe collections
     * @param {object} proposedMeal - The meal being considered
     * @param {Array} recentMeals - Recently used meals
     * @param {object} context - Additional context for smart fallbacks
     * @returns {number} Variety score (0-10, higher = more variety)
     */
    calculateVarietyScore(proposedMeal, recentMeals, context = {}) {
        if (recentMeals.length === 0) {
            return 10; // Maximum variety if no recent meals
        }

        let maxSimilarity = 0; // Use MAX similarity instead of average
        
        recentMeals.forEach((recentMeal, index) => {
            // Weight recent meals MUCH more heavily - MADE MORE AGGRESSIVE
            const recencyWeight = Math.exp(-0.05 * index); // Changed from -0.1 to -0.05 (slower decay = stronger penalty)
            
            const similarity = this.calculateMealSimilarity(proposedMeal, recentMeal);
            
            // Apply exponential penalty for high similarity - NEW AGGRESSIVE APPROACH
            const penalizedSimilarity = similarity > 0.8 ? similarity * 1.5 : similarity; // Extra penalty for very similar meals
            
            // Take the MAXIMUM weighted similarity (worst case dominates)
            const weightedSimilarity = penalizedSimilarity * recencyWeight;
            maxSimilarity = Math.max(maxSimilarity, weightedSimilarity);
        });

        // SMART COOKBOOK-ONLY FALLBACK
        // If user has limited cookbook recipes and cookbook-only preference, allow controlled repetition
        const isLimitedCookbookOnly = this.shouldUseLimitedCookbookFallback(context, recentMeals);
        
        if (isLimitedCookbookOnly) {
            // Use less aggressive scoring for limited cookbook scenario
            return this.calculateLimitedCookbookVarietyScore(maxSimilarity, recentMeals.length);
        }

        // Convert similarity to variety score with AGGRESSIVE scaling (normal case)
        let varietyScore = Math.max(0, 10 - (maxSimilarity * 12)); // Using max similarity instead of average
        
        // Additional penalty for exact matches - NUCLEAR OPTION
        if (maxSimilarity >= 0.9) {
            varietyScore = Math.max(0, varietyScore - 5); // Extra -5 penalty for near-exact matches
        }
        
        logger.debug(`MealVarietyTracker: Variety score for "${proposedMeal.title}": ${varietyScore.toFixed(2)} (max similarity: ${maxSimilarity.toFixed(2)})`);
        return varietyScore;
    }

    /**
     * Determines if we should use the limited cookbook fallback scoring
     * @param {object} context - Meal planning context
     * @param {Array} recentMeals - Recent meals for analysis
     * @returns {boolean} Whether to use limited cookbook fallback
     */
    shouldUseLimitedCookbookFallback(context, recentMeals) {
        // Check if this is cookbook-only mode with limited recipes
        const isCookbookOnly = context.recipeSourcePriority === 'cookbookOnly';
        const totalAvailableRecipes = context.totalAvailableCookbookRecipes || 0;
        const mealsNeeded = context.totalMealSlotsNeeded || 7;
        
        // If cookbook-only and recipes available are less than meals needed
        if (isCookbookOnly && totalAvailableRecipes > 0 && totalAvailableRecipes < mealsNeeded) {
            logger.info(`MealVarietyTracker: Using limited cookbook fallback - ${totalAvailableRecipes} recipes for ${mealsNeeded} meals`);
            return true;
        }
        
        return false;
    }

    /**
     * Calculates variety score for limited cookbook scenarios
     * Allows controlled repetition while still encouraging variety
     * @param {number} maxSimilarity - Maximum similarity score
     * @param {number} recentMealCount - Number of recent meals
     * @returns {number} Adjusted variety score for limited cookbook
     */
    calculateLimitedCookbookVarietyScore(maxSimilarity, recentMealCount) {
        // Less aggressive scaling for limited cookbook
        let varietyScore = Math.max(0, 10 - (maxSimilarity * 8)); // Reduced from *12 to *8
        
        // Milder penalty for exact matches in limited scenarios
        if (maxSimilarity >= 0.9) {
            varietyScore = Math.max(0, varietyScore - 2); // Reduced from -5 to -2
        }
        
        // Bonus for waiting longer between repetitions (applied BEFORE minimum)
        if (recentMealCount >= 3) {
            varietyScore += 2; // Increased from +1 to +2 for better differentiation
        }
        
        // Ensure minimum score of 1.0 to allow eventual repetition
        varietyScore = Math.max(1.0, varietyScore);
        
        logger.debug(`MealVarietyTracker: Limited cookbook variety score: ${varietyScore.toFixed(2)} (max similarity: ${maxSimilarity.toFixed(2)}, recent meals: ${recentMealCount})`);
        return varietyScore;
    }

    /**
     * Calculates similarity between two meals
     * @param {object} meal1 - First meal to compare
     * @param {object} meal2 - Second meal to compare
     * @returns {number} Similarity score (0-1)
     */
    calculateMealSimilarity(meal1, meal2) {
        let similarity = 0;

        // Exact title match (MAXIMUM similarity - this should be definitive)
        if (this.normalizeTitle(meal1.title) === this.normalizeTitle(meal2.title)) {
            return 1.0; // Exact match = 100% similarity, no need to check anything else
        }

        // If not exact match, check other factors (use additive approach with caps)
        
        // Protein analysis
        const protein1 = this.extractProtein(meal1.title, meal1.keyIngredients);
        const protein2 = this.extractProtein(meal2.title, meal2.keyIngredients);
        if (protein1 && protein2 && protein1 === protein2) {
            similarity += this.similarityWeights.proteinMatch;
        }

        // Cuisine analysis
        const cuisine1 = this.extractCuisine(meal1.title);
        const cuisine2 = this.extractCuisine(meal2.title);
        if (cuisine1 && cuisine2 && cuisine1 === cuisine2) {
            similarity += this.similarityWeights.cuisineMatch;
        }

        // Main ingredient analysis
        const mainIngredient1 = this.extractMainIngredient(meal1.title, meal1.keyIngredients);
        const mainIngredient2 = this.extractMainIngredient(meal2.title, meal2.keyIngredients);
        if (mainIngredient1 && mainIngredient2 && mainIngredient1 === mainIngredient2) {
            similarity += this.similarityWeights.mainIngredientMatch;
        }

        // Cooking method analysis
        const method1 = this.extractCookingMethod(meal1.title);
        const method2 = this.extractCookingMethod(meal2.title);
        if (method1 && method2 && method1 === method2) {
            similarity += this.similarityWeights.cookingMethodMatch;
        }

        // Cap similarity at 1.0 but allow it to accumulate for very similar meals
        return Math.min(1.0, similarity);
    }

    /**
     * Helper methods for meal analysis
     */

    normalizeTitle(title) {
        return title?.toLowerCase().trim().replace(/[^\w\s]/g, '') || '';
    }

    extractProtein(title, keyIngredients = []) {
        const proteins = ['chicken', 'beef', 'pork', 'fish', 'salmon', 'tuna', 'shrimp', 'lobster', 'crab', 'tofu', 'tempeh', 'turkey', 'duck', 'lamb', 'venison'];
        const text = `${title} ${keyIngredients.join(' ')}`.toLowerCase();
        
        return proteins.find(protein => text.includes(protein)) || null;
    }

    extractCuisine(title) {
        const cuisines = {
            'italian': ['pasta', 'pizza', 'risotto', 'lasagna', 'caprese', 'marinara'],
            'mexican': ['taco', 'burrito', 'enchilada', 'quesadilla', 'salsa', 'guacamole'],
            'asian': ['stir fry', 'fried rice', 'noodles', 'curry', 'teriyaki', 'tempura'],
            'indian': ['curry', 'tandoori', 'biryani', 'masala', 'tikka', 'dal'],
            'mediterranean': ['hummus', 'falafel', 'tzatziki', 'olive', 'feta', 'pita'],
            'thai': ['pad thai', 'tom yum', 'green curry', 'thai basil', 'coconut'],
            'chinese': ['kung pao', 'sweet and sour', 'lo mein', 'general tso', 'orange chicken'],
            'japanese': ['sushi', 'miso', 'teriyaki', 'tempura', 'ramen', 'soba'],
            'french': ['coq au vin', 'bouillabaisse', 'ratatouille', 'crème', 'sauce'],
            'american': ['burger', 'bbq', 'mac and cheese', 'fried chicken', 'coleslaw']
        };

        // Add null safety
        if (!title) {
            return null;
        }

        const titleLower = title.toLowerCase();
        
        for (const [cuisine, keywords] of Object.entries(cuisines)) {
            if (keywords.some(keyword => titleLower.includes(keyword))) {
                return cuisine;
            }
        }
        
        return null;
    }

    extractMainIngredient(title, keyIngredients = []) {
        const mainIngredients = ['tomato', 'mushroom', 'spinach', 'broccoli', 'cauliflower', 'zucchini', 'eggplant', 'pepper', 'onion', 'garlic', 'avocado', 'cheese', 'egg', 'rice', 'pasta', 'potato', 'sweet potato', 'quinoa', 'lentil', 'bean'];
        const text = `${title} ${keyIngredients.join(' ')}`.toLowerCase();
        
        return mainIngredients.find(ingredient => text.includes(ingredient)) || null;
    }

    extractCookingMethod(title) {
        const methods = {
            'grilled': ['grilled', 'bbq', 'barbecue'],
            'fried': ['fried', 'crispy', 'crunchy'],
            'baked': ['baked', 'roasted', 'oven'],
            'sautéed': ['sautéed', 'pan-fried', 'skillet'],
            'steamed': ['steamed', 'poached'],
            'braised': ['braised', 'slow-cooked', 'stewed'],
            'raw': ['salad', 'sushi', 'ceviche', 'carpaccio']
        };

        const titleLower = title.toLowerCase();
        
        for (const [method, keywords] of Object.entries(methods)) {
            if (keywords.some(keyword => titleLower.includes(keyword))) {
                return method;
            }
        }
        
        return null;
    }

    /**
     * Creates explicit exclusion list for prompt engineering
     * @param {Array} recentMeals - Recently used meals
     * @param {number} exclusionThreshold - Similarity threshold for exclusion (default 0.7)
     * @returns {Array} List of recipe titles to explicitly avoid
     */
    generateExclusionList(recentMeals, exclusionThreshold = 0.7) {
        if (recentMeals.length === 0) return [];

        const exclusions = new Set();
        
        // Add exact recent recipes to exclusion list
        recentMeals.slice(0, 10).forEach(meal => {
            if (meal.title) {
                exclusions.add(meal.title);
                
                // Also add normalized variations to catch similar titles
                const normalized = this.normalizeTitle(meal.title);
                if (normalized !== meal.title) {
                    exclusions.add(normalized);
                }
            }
        });

        return Array.from(exclusions);
    }

    /**
     * Generates comprehensive variety guidance for prompt with exclusions
     * @param {Array} recentMeals - Recently used meals
     * @returns {object} Enhanced variety guidance with exclusions
     */
    generateVarietyGuidanceForPrompt(recentMeals) {
        if (recentMeals.length === 0) {
            return {
                recentCuisines: [],
                recentProteins: [],
                recommendedCuisines: ['Italian', 'Asian', 'Mexican'],
                diversityScore: 10,
                explicitExclusions: []
            };
        }

        // Extract recent patterns
        const recentProteins = new Set();
        const recentCuisines = new Set();
        const recentMethods = new Set();

        recentMeals.slice(0, 15).forEach(meal => {
            const protein = this.extractProtein(meal.title, meal.keyIngredients);
            const cuisine = this.extractCuisine(meal.title);
            const method = this.extractCookingMethod(meal.title);
            
            if (protein) recentProteins.add(protein);
            if (cuisine) recentCuisines.add(cuisine);
            if (method) recentMethods.add(method);
        });

        // Suggest variety based on what's missing
        const allCuisines = ['Italian', 'Asian', 'Mexican', 'Mediterranean', 'American', 'Indian', 'Thai'];
        const recommendedCuisines = allCuisines.filter(cuisine => 
            !Array.from(recentCuisines).some(recent => 
                recent.toLowerCase().includes(cuisine.toLowerCase())
            )
        ).slice(0, 3);

        const allProteins = ['chicken', 'beef', 'pork', 'fish', 'vegetarian'];
        const recommendedProteins = allProteins.filter(protein => 
            !recentProteins.has(protein)
        ).slice(0, 2);

        return {
            recentCuisines: Array.from(recentCuisines).slice(0, 4),
            recentProteins: Array.from(recentProteins).slice(0, 3),
            recentMethods: Array.from(recentMethods).slice(0, 3),
            recommendedCuisines,
            recommendedProteins,
            diversityScore: this.calculateDiversityScore(recentMeals),
            explicitExclusions: this.generateExclusionList(recentMeals)  // NEW - explicit exclusions
        };
    }

    /**
     * Calculates overall diversity score for recent meals
     * @param {Array} recentMeals - Recently used meals
     * @returns {number} Diversity score (0-10)
     */
    calculateDiversityScore(recentMeals) {
        if (recentMeals.length === 0) return 10;

        const proteins = new Set();
        const cuisines = new Set();
        const methods = new Set();
        const titles = new Set();

        recentMeals.forEach(meal => {
            proteins.add(this.extractProtein(meal.title, meal.keyIngredients));
            cuisines.add(this.extractCuisine(meal.title));
            methods.add(this.extractCookingMethod(meal.title));
            titles.add(this.normalizeTitle(meal.title));
        });

        // Calculate diversity ratios
        const proteinDiversity = proteins.size / Math.min(recentMeals.length, 8);
        const cuisineDiversity = cuisines.size / Math.min(recentMeals.length, 6);
        const methodDiversity = methods.size / Math.min(recentMeals.length, 5);
        const titleDiversity = titles.size / recentMeals.length;

        const averageDiversity = (proteinDiversity + cuisineDiversity + methodDiversity + titleDiversity) / 4;
        return Math.round(averageDiversity * 10);
    }

    /**
     * Generates variety context for AI prompt (legacy method)
     * @param {Array} recentMeals - Recently used meals
     * @returns {string} Formatted context for AI prompt
     */
    generateVarietyContextForPrompt(recentMeals) {
        if (recentMeals.length === 0) {
            return "No recent meal history available. Feel free to suggest any appropriate recipes.";
        }

        // Group recent meals by type for analysis
        const recentProteins = new Set();
        const recentCuisines = new Set();
        const recentTitles = [];

        recentMeals.slice(0, 15).forEach(meal => { // Focus on most recent
            const protein = this.extractProtein(meal.title, meal.keyIngredients);
            const cuisine = this.extractCuisine(meal.title);
            
            if (protein) recentProteins.add(protein);
            if (cuisine) recentCuisines.add(cuisine);
            recentTitles.push(meal.title);
        });

        const contextParts = [];

        // Recent proteins
        if (recentProteins.size > 0) {
            contextParts.push(`Recently used proteins: ${Array.from(recentProteins).join(', ')}`);
        }

        // Recent cuisines
        if (recentCuisines.size > 0) {
            contextParts.push(`Recently featured cuisines: ${Array.from(recentCuisines).join(', ')}`);
        }

        // Most recent specific meals
        if (recentTitles.length > 0) {
            const recentMealsList = recentTitles.slice(0, 8).join(', ');
            contextParts.push(`Recent specific meals: ${recentMealsList}`);
        }

        const context = contextParts.join('. ') + '.';
        
        return `VARIETY GUIDANCE: ${context} Please suggest different proteins, cuisines, or cooking styles to provide variety and avoid repetition.`;
    }

    /**
     * Filters and ranks meal suggestions by variety
     * @param {Array} mealSuggestions - Proposed meal suggestions
     * @param {Array} recentMeals - Recently used meals
     * @param {number} maxSuggestions - Maximum number to return
     * @param {object} context - Additional context for smart fallbacks
     * @returns {Array} Filtered and ranked meal suggestions
     */
    filterByVariety(mealSuggestions, recentMeals, maxSuggestions = 10, context = {}) {
        if (mealSuggestions.length === 0) {
            return [];
        }

        // Calculate variety scores for all suggestions
        const scoredSuggestions = mealSuggestions.map(suggestion => ({
            ...suggestion,
            varietyScore: this.calculateVarietyScore(suggestion, recentMeals, context)
        }));

        // Sort by variety score (highest first) and return top suggestions
        const filteredSuggestions = scoredSuggestions
            .sort((a, b) => b.varietyScore - a.varietyScore)
            .slice(0, maxSuggestions);

        logger.info(`MealVarietyTracker: Filtered ${mealSuggestions.length} suggestions to ${filteredSuggestions.length} based on variety`);

        return filteredSuggestions;
    }

    /**
     * Stores meal usage for future variety tracking
     * @param {string} userId - User identifier
     * @param {string} planId - Meal plan identifier
     * @param {Array} generatedMeals - Meals that were generated
     */
    async recordMealUsage(userId, planId, generatedMeals) {
        try {
            const usageRecord = {
                userId,
                planId,
                generatedAt: new Date(),
                meals: generatedMeals.map(meal => ({
                    title: meal.title,
                    recipeId: meal.recipeId,
                    source: meal.source,
                    keyIngredients: meal.keyIngredients || [],
                    mealType: meal.mealType,
                    varietyScore: meal.varietyScore
                }))
            };

            // Store in a collection for variety tracking
            // NOTE: This creates a separate usage tracking collection - different from main mealPlans
            await firestoreHelper.saveDocument(
                `users/${userId}/meal_usage_history`,
                planId,
                usageRecord
            );

            logger.info(`MealVarietyTracker: Recorded usage of ${generatedMeals.length} meals for plan ${planId}`);

        } catch (error) {
            logger.warn(`MealVarietyTracker: Error recording meal usage for plan ${planId}:`, error);
        }
    }

    /**
     * Gets diversity statistics for user's recent meal planning
     * @param {string} userId - User identifier
     * @returns {Promise<object>} Diversity statistics
     */
    async getDiversityStats(userId) {
        try {
            const recentMeals = await this.getRecentlyUsedRecipes(userId, 4);
            
            if (recentMeals.length === 0) {
                return {
                    totalMeals: 0,
                    uniqueProteins: 0,
                    uniqueCuisines: 0,
                    diversityScore: 10 // Perfect diversity when no history
                };
            }

            const proteins = new Set();
            const cuisines = new Set();
            const titles = new Set();

            recentMeals.forEach(meal => {
                const protein = this.extractProtein(meal.title, meal.keyIngredients);
                const cuisine = this.extractCuisine(meal.title);
                
                if (protein) proteins.add(protein);
                if (cuisine) cuisines.add(cuisine);
                titles.add(this.normalizeTitle(meal.title));
            });

            // Calculate diversity score based on variety
            const proteinDiversity = proteins.size / Math.min(recentMeals.length, 10); // Max expected different proteins
            const cuisineDiversity = cuisines.size / Math.min(recentMeals.length, 8); // Max expected different cuisines
            const titleDiversity = titles.size / recentMeals.length; // Unique titles vs total meals

            const diversityScore = ((proteinDiversity + cuisineDiversity + titleDiversity) / 3) * 10;

            return {
                totalMeals: recentMeals.length,
                uniqueProteins: proteins.size,
                uniqueCuisines: cuisines.size,
                uniqueTitles: titles.size,
                diversityScore: Math.min(10, diversityScore),
                topProteins: Array.from(proteins).slice(0, 5),
                topCuisines: Array.from(cuisines).slice(0, 5)
            };

        } catch (error) {
            logger.warn(`MealVarietyTracker: Error calculating diversity stats for ${userId}:`, error);
            return {
                totalMeals: 0,
                uniqueProteins: 0,
                uniqueCuisines: 0,
                diversityScore: 5
            };
        }
    }
}

module.exports = { MealVarietyTracker }; 