const { logger } = require("firebase-functions/v2");
const firestoreHelper = require("@saucey/shared/services/firestoreHelper");

/**
 * @fileoverview Cookbook Recipe Selector for intelligent recipe selection
 * based on user preferences, meal context, and variety requirements.
 */

class CookbookRecipeSelector {

    constructor() {
        // Recipe source distribution ratios
        this.recipeSourceRatios = {
            'cookbookOnly': { cookbook: 1.0, ai: 0.0 },
            'balancedMix': { cookbook: 0.5, ai: 0.5 },
            'discoverNew': { cookbook: 0.2, ai: 0.8 }
        };
    }

    /**
     * Calculates how many cookbook vs AI recipes to use based on user preference
     * @param {string} recipeSourcePriority - User's recipe source preference
     * @param {number} totalMealSlots - Total number of meal slots to fill
     * @returns {object} Distribution of cookbook vs AI recipes
     */
    calculateRecipeDistribution(recipeSourcePriority, totalMealSlots) {
        const ratio = this.recipeSourceRatios[recipeSourcePriority] || this.recipeSourceRatios['balancedMix'];
        
        const cookbookCount = Math.floor(totalMealSlots * ratio.cookbook);
        const aiCount = totalMealSlots - cookbookCount; // Ensure total adds up
        
        logger.info(`CookbookRecipeSelector: Distribution for ${recipeSourcePriority}: ${cookbookCount} cookbook, ${aiCount} AI recipes`);
        
        return { cookbookCount, aiCount };
    }

    /**
     * Selects optimal cookbook recipes for a week's meal plan
     * @param {string} userId - User identifier
     * @param {number} recipesNeeded - Number of cookbook recipes to select
     * @param {object} userProfile - User preference profile
     * @param {object} mealContext - Meal planning context (target macros, meal types, etc.)
     * @param {string[]} recentlyUsedRecipeIds - Recipe IDs used in recent weeks
     * @returns {Promise<Array>} Selected cookbook recipes with scoring metadata
     */
    async selectOptimalCookbookRecipes(userId, recipesNeeded, userProfile, mealContext, recentlyUsedRecipeIds = []) {
        if (recipesNeeded <= 0) {
            return [];
        }

        logger.info(`CookbookRecipeSelector: Selecting ${recipesNeeded} cookbook recipes for user ${userId}`);

        try {
            // Fetch user's cookbook recipes
            const cookbookRecipes = await this.fetchUserCookbookRecipes(userId);
            
            if (cookbookRecipes.length === 0) {
                logger.warn(`CookbookRecipeSelector: No cookbook recipes found for user ${userId}`);
                return [];
            }

            logger.info(`CookbookRecipeSelector: Found ${cookbookRecipes.length} cookbook recipes for selection`);

            // Score all recipes for current context
            const scoredRecipes = cookbookRecipes.map(recipe => ({
                ...recipe,
                score: this.scoreRecipeForContext(recipe, mealContext, userProfile, recentlyUsedRecipeIds)
            }));

            // Sort by score and select top recipes
            const selectedRecipes = scoredRecipes
                .sort((a, b) => b.score - a.score)
                .slice(0, recipesNeeded);

            logger.info(`CookbookRecipeSelector: Selected ${selectedRecipes.length} recipes with scores: ${selectedRecipes.map(r => `${r.title}(${r.score.toFixed(2)})`).join(', ')}`);

            return selectedRecipes;

        } catch (error) {
            logger.error(`CookbookRecipeSelector: Error selecting cookbook recipes for ${userId}:`, error);
            return [];
        }
    }

    /**
     * Fetches user's saved cookbook recipes
     * @param {string} userId - User identifier
     * @returns {Promise<Array>} User's cookbook recipes
     */
    async fetchUserCookbookRecipes(userId) {
        try {
            const recipes = await firestoreHelper.getCollection(`users/${userId}/my_recipes`, {
                limit: 200, // Increased limit for better selection
                orderBy: [{ field: "createdAt", direction: "desc" }]
            });

            // Filter to only include complete recipes (not stubs)
            return (recipes || []).filter(recipe => 
                recipe.title && 
                recipe.ingredients && 
                recipe.ingredients.length > 0 &&
                !recipe.isStub
            );
        } catch (error) {
            logger.warn(`CookbookRecipeSelector: Error fetching cookbook recipes for ${userId}:`, error);
            return [];
        }
    }

    /**
     * Scores a recipe for current meal planning context
     * @param {object} recipe - Recipe to score
     * @param {object} mealContext - Current meal planning context
     * @param {object} userProfile - User preference profile
     * @param {string[]} recentlyUsedRecipeIds - Recently used recipe IDs
     * @returns {number} Recipe score (0-10)
     */
    scoreRecipeForContext(recipe, mealContext, userProfile, recentlyUsedRecipeIds) {
        let score = 0;

        // 1. User preference alignment (40% weight)
        score += this.calculateUserAffinityScore(recipe, userProfile) * 0.4;

        // 2. Meal context appropriateness (25% weight)
        score += this.calculateContextualScore(recipe, mealContext) * 0.25;

        // 3. Recent usage penalty (25% weight)
        score -= this.calculateRecencyPenalty(recipe.recipeId, recentlyUsedRecipeIds) * 0.25;

        // 4. Recipe quality indicators (10% weight)
        score += this.calculateQualityScore(recipe) * 0.1;

        // Ensure score is within 0-10 range
        return Math.max(0, Math.min(10, score));
    }

    /**
     * Calculates how well a recipe aligns with user preferences
     * @param {object} recipe - Recipe to evaluate
     * @param {object} userProfile - User preference profile
     * @returns {number} Affinity score (0-10)
     */
    calculateUserAffinityScore(recipe, userProfile) {
        let score = 5; // Base score

        // Cuisine preference match
        if (recipe.cuisine && userProfile.cuisineAffinities) {
            const cuisineMatch = userProfile.cuisineAffinities.find(
                c => c.cuisine.toLowerCase() === recipe.cuisine.toLowerCase()
            );
            if (cuisineMatch) {
                score += Math.min(3, cuisineMatch.score * 0.5); // Up to +3 points
            }
        }

        // Protein preference match
        if (recipe.title && userProfile.favoriteProteins) {
            const recipeTitle = recipe.title.toLowerCase();
            const proteinMatch = userProfile.favoriteProteins.find(
                p => recipeTitle.includes(p.protein)
            );
            if (proteinMatch) {
                score += Math.min(2, proteinMatch.score * 0.3); // Up to +2 points
            }
        }

        // Ingredient preference match
        if (recipe.ingredients && userProfile.preferredIngredients) {
            const recipeIngredients = recipe.ingredients.map(i => 
                i.item_name?.toLowerCase() || ''
            ).join(' ');
            
            let ingredientMatches = 0;
            userProfile.preferredIngredients.slice(0, 10).forEach(prefIngredient => {
                if (recipeIngredients.includes(prefIngredient.ingredient)) {
                    ingredientMatches++;
                }
            });
            
            score += Math.min(2, ingredientMatches * 0.3); // Up to +2 points
        }

        // Complexity preference match
        if (userProfile.complexityPreference) {
            const recipeComplexity = this.assessRecipeComplexity(recipe);
            const complexityMatch = this.getComplexityMatchScore(recipeComplexity, userProfile.complexityPreference);
            score += complexityMatch; // Up to +1 point
        }

        // Recent engagement boost
        if (userProfile.recentFavorites) {
            const recentMatch = userProfile.recentFavorites.find(
                rf => rf.recipeId === recipe.recipeId
            );
            if (recentMatch) {
                score += Math.min(2, recentMatch.engagement * 0.1); // Up to +2 points
            }
        }

        return Math.max(0, Math.min(10, score));
    }

    /**
     * Calculates contextual appropriateness for current meal planning
     * @param {object} recipe - Recipe to evaluate
     * @param {object} mealContext - Meal planning context
     * @returns {number} Contextual score (0-10)
     */
    calculateContextualScore(recipe, mealContext) {
        let score = 5; // Base score

        // Macro similarity (if target macros provided)
        if (mealContext.targetMacros && recipe.calories) {
            const targetCalories = mealContext.targetMacros.calories || 600;
            const recipeCalories = parseInt(recipe.calories) || 600;
            const caloriesDiff = Math.abs(targetCalories - recipeCalories);
            const caloriesScore = Math.max(0, 5 - (caloriesDiff / 100)); // Penalty for large differences
            score += caloriesScore * 0.4; // Up to +2 points
        }

        // Meal type appropriateness
        if (mealContext.mealType && recipe.category) {
            const mealTypeMatch = this.isMealTypeAppropriate(recipe.category, mealContext.mealType);
            if (mealTypeMatch) {
                score += 1.5; // +1.5 points for appropriate meal type
            }
        }

        // Cooking time preference
        if (mealContext.maxCookTime && recipe.total_time) {
            const cookTime = this.extractCookTimeMinutes(recipe.total_time);
            if (cookTime && cookTime <= mealContext.maxCookTime) {
                score += 1; // +1 point for fitting time constraint
            } else if (cookTime && cookTime > mealContext.maxCookTime * 1.5) {
                score -= 2; // -2 points for being significantly over time
            }
        }

        // Seasonal appropriateness (simple implementation)
        const currentSeason = this.getCurrentSeason();
        if (this.isRecipeSeasonallyAppropriate(recipe, currentSeason)) {
            score += 0.5; // +0.5 points for seasonal match
        }

        return Math.max(0, Math.min(10, score));
    }

    /**
     * Calculates penalty for recently used recipes
     * @param {string} recipeId - Recipe ID to check
     * @param {string[]} recentlyUsedRecipeIds - Recently used recipe IDs
     * @returns {number} Recency penalty (0-10)
     */
    calculateRecencyPenalty(recipeId, recentlyUsedRecipeIds) {
        if (!recentlyUsedRecipeIds.includes(recipeId)) {
            return 0; // No penalty
        }

        // Heavy penalty for recent usage
        const recentIndex = recentlyUsedRecipeIds.indexOf(recipeId);
        if (recentIndex < 5) {
            return 8; // Very high penalty for very recent usage
        } else if (recentIndex < 10) {
            return 5; // High penalty for recent usage
        } else {
            return 2; // Moderate penalty for older usage
        }
    }

    /**
     * Calculates recipe quality score
     * @param {object} recipe - Recipe to evaluate
     * @returns {number} Quality score (0-10)
     */
    calculateQualityScore(recipe) {
        let score = 5; // Base score

        // Has rating
        if (recipe.averageRating && recipe.averageRating > 0) {
            score += (recipe.averageRating - 3) * 0.5; // Boost for good ratings
        }

        // Has been cooked before (cookedCount)
        if (recipe.cookedCount && recipe.cookedCount > 0) {
            score += Math.min(1, recipe.cookedCount * 0.2); // Up to +1 point
        }

        // Recipe completeness
        const hasIngredients = recipe.ingredients && recipe.ingredients.length > 0;
        const hasInstructions = recipe.instructions && recipe.instructions.length > 0;
        const hasImage = recipe.imageURL && recipe.imageURL.length > 0;
        
        if (hasIngredients && hasInstructions) {
            score += 1;
        }
        if (hasImage) {
            score += 0.5;
        }

        return Math.max(0, Math.min(10, score));
    }

    /**
     * Helper methods for scoring calculations
     */

    assessRecipeComplexity(recipe) {
        const ingredientCount = recipe.ingredients?.length || 0;
        const instructionCount = recipe.instructions?.length || 0;
        
        if (ingredientCount >= 12 || instructionCount >= 8) return 'high';
        if (ingredientCount >= 7 || instructionCount >= 5) return 'medium';
        return 'simple';
    }

    getComplexityMatchScore(recipeComplexity, userPreference) {
        if (recipeComplexity === userPreference) return 1;
        if ((recipeComplexity === 'medium' && userPreference !== 'high') ||
            (recipeComplexity !== 'high' && userPreference === 'medium')) return 0.5;
        return 0;
    }

    isMealTypeAppropriate(recipeCategory, mealType) {
        const categoryMap = {
            'breakfast': ['breakfast', 'brunch'],
            'lunch': ['lunch', 'salad', 'sandwich', 'soup'],
            'dinner': ['dinner', 'main', 'entree', 'pasta', 'meat', 'seafood'],
            'snack': ['snack', 'appetizer', 'dessert']
        };
        
        const appropriateCategories = categoryMap[mealType?.toLowerCase()] || [];
        return appropriateCategories.some(cat => 
            recipeCategory?.toLowerCase().includes(cat)
        );
    }

    extractCookTimeMinutes(totalTimeString) {
        if (!totalTimeString) return null;
        
        const timeMatch = totalTimeString.match(/(\d+)/);
        return timeMatch ? parseInt(timeMatch[1]) : null;
    }

    getCurrentSeason() {
        const month = new Date().getMonth();
        if (month >= 2 && month <= 4) return 'spring';
        if (month >= 5 && month <= 7) return 'summer';
        if (month >= 8 && month <= 10) return 'fall';
        return 'winter';
    }

    isRecipeSeasonallyAppropriate(recipe, season) {
        const seasonalKeywords = {
            spring: ['spring', 'asparagus', 'peas', 'fresh', 'light'],
            summer: ['summer', 'grill', 'barbecue', 'tomato', 'berry', 'cold'],
            fall: ['fall', 'autumn', 'pumpkin', 'squash', 'apple', 'warm'],
            winter: ['winter', 'stew', 'soup', 'roast', 'comfort', 'hearty']
        };

        const keywords = seasonalKeywords[season] || [];
        const recipeText = `${recipe.title} ${recipe.ingredients?.map(i => i.item_name).join(' ')}`.toLowerCase();
        
        return keywords.some(keyword => recipeText.includes(keyword));
    }

    /**
     * Formats selected cookbook recipes for AI prompt inclusion
     * @param {Array} selectedRecipes - Selected cookbook recipes
     * @returns {string} Formatted string for AI prompt
     */
    formatSelectedRecipesForPrompt(selectedRecipes) {
        if (selectedRecipes.length === 0) {
            return "No cookbook recipes selected for this week.";
        }

        const recipeDescriptions = selectedRecipes.map(recipe => {
            const ingredients = recipe.ingredients?.slice(0, 5).map(i => i.item_name).join(', ') || 'N/A';
            return `"${recipe.title}" (${recipe.cuisine || 'General'} cuisine, key ingredients: ${ingredients})`;
        });

        return `Selected cookbook recipes to include: ${recipeDescriptions.join(', ')}.`;
    }
}

module.exports = { CookbookRecipeSelector }; 