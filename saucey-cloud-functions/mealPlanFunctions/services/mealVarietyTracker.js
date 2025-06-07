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
        
        // Weights for different similarity factors
        this.similarityWeights = {
            exactTitleMatch: 0.9,
            proteinMatch: 0.6,
            cuisineMatch: 0.4,
            mainIngredientMatch: 0.5,
            cookingMethodMatch: 0.3
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

            // Fetch recent meal plans
            const recentMealPlans = await firestoreHelper.getCollection(`users/${userId}/meal_plans`, {
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
     * @param {object} proposedMeal - The meal being considered
     * @param {Array} recentMeals - Recently used meals
     * @returns {number} Variety score (0-10, higher = more variety)
     */
    calculateVarietyScore(proposedMeal, recentMeals) {
        if (recentMeals.length === 0) {
            return 10; // Maximum variety if no recent meals
        }

        let totalSimilarity = 0;
        let weightedComparisons = 0;

        recentMeals.forEach((recentMeal, index) => {
            // Weight recent meals more heavily (exponential decay)
            const recencyWeight = Math.exp(-0.1 * index);
            
            const similarity = this.calculateMealSimilarity(proposedMeal, recentMeal);
            totalSimilarity += similarity * recencyWeight;
            weightedComparisons += recencyWeight;
        });

        const averageSimilarity = weightedComparisons > 0 ? totalSimilarity / weightedComparisons : 0;
        
        // Convert similarity to variety score (inverse relationship)
        const varietyScore = Math.max(0, 10 - (averageSimilarity * 10));
        
        logger.debug(`MealVarietyTracker: Variety score for "${proposedMeal.title}": ${varietyScore.toFixed(2)}`);
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

        // Exact title match (very high similarity)
        if (this.normalizeTitle(meal1.title) === this.normalizeTitle(meal2.title)) {
            similarity = Math.max(similarity, this.similarityWeights.exactTitleMatch);
        }

        // Protein analysis
        const protein1 = this.extractProtein(meal1.title, meal1.keyIngredients);
        const protein2 = this.extractProtein(meal2.title, meal2.keyIngredients);
        if (protein1 && protein2 && protein1 === protein2) {
            similarity = Math.max(similarity, this.similarityWeights.proteinMatch);
        }

        // Cuisine analysis
        const cuisine1 = this.extractCuisine(meal1.title);
        const cuisine2 = this.extractCuisine(meal2.title);
        if (cuisine1 && cuisine2 && cuisine1 === cuisine2) {
            similarity = Math.max(similarity, this.similarityWeights.cuisineMatch);
        }

        // Main ingredient analysis
        const mainIngredient1 = this.extractMainIngredient(meal1.title, meal1.keyIngredients);
        const mainIngredient2 = this.extractMainIngredient(meal2.title, meal2.keyIngredients);
        if (mainIngredient1 && mainIngredient2 && mainIngredient1 === mainIngredient2) {
            similarity = Math.max(similarity, this.similarityWeights.mainIngredientMatch);
        }

        // Cooking method analysis
        const method1 = this.extractCookingMethod(meal1.title);
        const method2 = this.extractCookingMethod(meal2.title);
        if (method1 && method2 && method1 === method2) {
            similarity = Math.max(similarity, this.similarityWeights.cookingMethodMatch);
        }

        return similarity;
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
     * Generates variety context for AI prompt
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
     * @returns {Array} Filtered and ranked meal suggestions
     */
    filterByVariety(mealSuggestions, recentMeals, maxSuggestions = 10) {
        if (mealSuggestions.length === 0) {
            return [];
        }

        // Calculate variety scores for all suggestions
        const scoredSuggestions = mealSuggestions.map(suggestion => ({
            ...suggestion,
            varietyScore: this.calculateVarietyScore(suggestion, recentMeals)
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