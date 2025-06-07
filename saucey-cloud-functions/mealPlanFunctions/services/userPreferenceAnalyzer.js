const { logger } = require("firebase-functions/v2");
const firestoreHelper = require("@saucey/shared/services/firestoreHelper");

/**
 * @fileoverview User Preference Analyzer for generating personalized meal plan preferences
 * based on user's cookbook recipes, cooking history, and viewing patterns.
 */

class UserPreferenceAnalyzer {
    
    /**
     * Generates a comprehensive user preference profile based on their activity
     * @param {string} userId - The user's unique identifier
     * @returns {Promise<object>} User preference profile with ingredients, cuisines, etc.
     */
    async generateUserPreferenceProfile(userId) {
        logger.info(`UserPreferenceAnalyzer: Generating preference profile for user ${userId}`);
        
        try {
            // Fetch user data in parallel for efficiency
            const [cookbookRecipes, recentCookLogs, viewHistory] = await Promise.all([
                this.fetchUserCookbookRecipes(userId),
                this.fetchRecentCookLogs(userId, 30), // Last 30 days
                this.fetchRecentViewHistory(userId, 50) // Last 50 views
            ]);

            logger.info(`UserPreferenceAnalyzer: Fetched ${cookbookRecipes.length} cookbook recipes, ${recentCookLogs.length} cook logs, ${viewHistory.length} view history entries`);

            // Generate preference profile
            const profile = {
                userId,
                generatedAt: Date.now(),
                
                // Ingredient preferences from cookbook
                preferredIngredients: this.extractIngredientPatterns(cookbookRecipes),
                
                // Protein preferences weighted by recent cooking
                favoriteProteins: this.analyzeProteinPreferences(cookbookRecipes, recentCookLogs),
                
                // Cuisine preferences from bookmarks and views
                cuisineAffinities: this.rankCuisinePreferences(cookbookRecipes, viewHistory),
                
                // Cooking patterns and frequency
                cookingPatterns: this.analyzeCookingPatterns(recentCookLogs),
                
                // Recipe complexity preference
                complexityPreference: this.deriveComplexityPreference(cookbookRecipes),
                
                // Recently engaged recipes (higher weight for recent activity)
                recentFavorites: this.getRecentlyEngagedRecipes(viewHistory, recentCookLogs),
                
                // Seasonal patterns if enough data
                seasonalPreferences: this.analyzeSeasonalPatterns(recentCookLogs, cookbookRecipes),
                
                // Data freshness indicators
                dataQuality: {
                    cookbookSize: cookbookRecipes.length,
                    recentActivity: recentCookLogs.length,
                    viewHistorySize: viewHistory.length,
                    hasGoodData: cookbookRecipes.length >= 3 || recentCookLogs.length >= 5
                }
            };

            logger.info(`UserPreferenceAnalyzer: Generated profile for ${userId} with ${profile.preferredIngredients.length} ingredient preferences and ${profile.cuisineAffinities.length} cuisine affinities`);
            return profile;

        } catch (error) {
            logger.error(`UserPreferenceAnalyzer: Error generating profile for ${userId}:`, error);
            // Return minimal fallback profile
            return this.createFallbackProfile(userId);
        }
    }

    /**
     * Fetches user's bookmarked/saved recipes from cookbook
     */
    async fetchUserCookbookRecipes(userId) {
        try {
            const recipes = await firestoreHelper.getCollection(`users/${userId}/my_recipes`, {
                limit: 100,
                orderBy: [{ field: "createdAt", direction: "desc" }]
            });
            return recipes || [];
        } catch (error) {
            logger.warn(`UserPreferenceAnalyzer: Error fetching cookbook recipes for ${userId}:`, error);
            return [];
        }
    }

    /**
     * Fetches recent cooking activity logs
     */
    async fetchRecentCookLogs(userId, days = 30) {
        try {
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - days);
            
            const cookLogs = await firestoreHelper.getCollection(`users/${userId}/cook_log`, {
                where: [{ field: "cookedDate", operator: ">=", value: cutoffDate }],
                orderBy: [{ field: "cookedDate", direction: "desc" }],
                limit: 50
            });
            return cookLogs || [];
        } catch (error) {
            logger.warn(`UserPreferenceAnalyzer: Error fetching cook logs for ${userId}:`, error);
            return [];
        }
    }

    /**
     * Fetches recent recipe viewing history
     */
    async fetchRecentViewHistory(userId, limit = 50) {
        try {
            const viewHistory = await firestoreHelper.getCollection(`users/${userId}/view_history`, {
                orderBy: [{ field: "viewedAt", direction: "desc" }],
                limit
            });
            return viewHistory || [];
        } catch (error) {
            logger.warn(`UserPreferenceAnalyzer: Error fetching view history for ${userId}:`, error);
            return [];
        }
    }

    /**
     * Extracts common ingredients from cookbook recipes
     */
    extractIngredientPatterns(recipes) {
        const ingredientFrequency = new Map();
        
        recipes.forEach(recipe => {
            if (recipe.ingredients && Array.isArray(recipe.ingredients)) {
                recipe.ingredients.forEach(ingredient => {
                    const name = ingredient.item_name?.toLowerCase().trim();
                    if (name && name.length > 2) {
                        ingredientFrequency.set(name, (ingredientFrequency.get(name) || 0) + 1);
                    }
                });
            }
        });

        // Return top ingredients sorted by frequency
        return Array.from(ingredientFrequency.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 15)
            .map(([ingredient, count]) => ({ ingredient, frequency: count }));
    }

    /**
     * Analyzes protein preferences with recency weighting
     */
    analyzeProteinPreferences(recipes, cookLogs) {
        const proteinKeywords = ['chicken', 'beef', 'pork', 'fish', 'salmon', 'shrimp', 'tofu', 'turkey', 'lamb'];
        const proteinScores = new Map();
        
        // Score from cookbook recipes (base preference)
        recipes.forEach(recipe => {
            const title = recipe.title?.toLowerCase() || '';
            const ingredients = recipe.ingredients?.map(i => i.item_name?.toLowerCase()).join(' ') || '';
            const content = `${title} ${ingredients}`;
            
            proteinKeywords.forEach(protein => {
                if (content.includes(protein)) {
                    proteinScores.set(protein, (proteinScores.get(protein) || 0) + 1);
                }
            });
        });

        // Boost scores for recently cooked proteins (higher weight)
        cookLogs.forEach(log => {
            const title = log.recipeTitle?.toLowerCase() || '';
            proteinKeywords.forEach(protein => {
                if (title.includes(protein)) {
                    proteinScores.set(protein, (proteinScores.get(protein) || 0) + 3); // 3x weight for cooked
                }
            });
        });

        return Array.from(proteinScores.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([protein, score]) => ({ protein, score }));
    }

    /**
     * Ranks cuisine preferences from bookmarks and views
     */
    rankCuisinePreferences(recipes, viewHistory) {
        const cuisineScores = new Map();
        
        // Score from saved recipes
        recipes.forEach(recipe => {
            if (recipe.cuisine) {
                const cuisine = recipe.cuisine.toLowerCase();
                cuisineScores.set(cuisine, (cuisineScores.get(cuisine) || 0) + 2);
            }
        });

        // Score from view history (lighter weight)
        viewHistory.forEach(entry => {
            // Extract cuisine from recipe title or other fields if available
            const title = entry.recipeTitle?.toLowerCase() || '';
            const cuisineHints = ['italian', 'mexican', 'asian', 'indian', 'thai', 'chinese', 'mediterranean', 'french', 'japanese', 'korean'];
            
            cuisineHints.forEach(cuisine => {
                if (title.includes(cuisine)) {
                    cuisineScores.set(cuisine, (cuisineScores.get(cuisine) || 0) + 1);
                }
            });
        });

        return Array.from(cuisineScores.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([cuisine, score]) => ({ cuisine, score }));
    }

    /**
     * Analyzes cooking frequency and patterns
     */
    analyzeCookingPatterns(cookLogs) {
        if (cookLogs.length === 0) return { frequency: 'unknown', pattern: 'unknown' };

        const now = new Date();
        const recentCooks = cookLogs.filter(log => {
            const cookDate = log.cookedDate?.toDate ? log.cookedDate.toDate() : new Date(log.cookedDate);
            const daysDiff = (now - cookDate) / (1000 * 60 * 60 * 24);
            return daysDiff <= 14; // Last 2 weeks
        });

        const frequency = recentCooks.length >= 7 ? 'high' : recentCooks.length >= 3 ? 'medium' : 'low';
        
        return {
            frequency,
            recentCookCount: recentCooks.length,
            totalCookCount: cookLogs.length,
            pattern: this.detectCookingPattern(cookLogs)
        };
    }

    /**
     * Detects cooking patterns (weekend warrior, daily cooker, etc.)
     */
    detectCookingPattern(cookLogs) {
        if (cookLogs.length < 5) return 'insufficient_data';
        
        const weekendCooks = cookLogs.filter(log => {
            const cookDate = log.cookedDate?.toDate ? log.cookedDate.toDate() : new Date(log.cookedDate);
            const dayOfWeek = cookDate.getDay();
            return dayOfWeek === 0 || dayOfWeek === 6; // Sunday or Saturday
        });

        const weekendRatio = weekendCooks.length / cookLogs.length;
        
        if (weekendRatio > 0.7) return 'weekend_warrior';
        if (weekendRatio < 0.3) return 'weekday_cook';
        return 'balanced';
    }

    /**
     * Derives complexity preference from saved recipes
     */
    deriveComplexityPreference(recipes) {
        if (recipes.length === 0) return 'medium';
        
        let complexityScore = 0;
        let scoredRecipes = 0;

        recipes.forEach(recipe => {
            const instructionCount = recipe.instructions?.length || 0;
            const ingredientCount = recipe.ingredients?.length || 0;
            
            if (instructionCount > 0 || ingredientCount > 0) {
                let recipeComplexity = 0;
                
                // More instructions = more complex
                if (instructionCount >= 8) recipeComplexity += 2;
                else if (instructionCount >= 5) recipeComplexity += 1;
                
                // More ingredients = more complex
                if (ingredientCount >= 12) recipeComplexity += 2;
                else if (ingredientCount >= 7) recipeComplexity += 1;
                
                complexityScore += recipeComplexity;
                scoredRecipes++;
            }
        });

        if (scoredRecipes === 0) return 'medium';
        
        const avgComplexity = complexityScore / scoredRecipes;
        
        if (avgComplexity >= 2.5) return 'high';
        if (avgComplexity >= 1.5) return 'medium';
        return 'simple';
    }

    /**
     * Gets recently engaged recipes with time-weighted scoring
     */
    getRecentlyEngagedRecipes(viewHistory, cookLogs) {
        const recipeEngagement = new Map();
        const now = Date.now();
        
        // Process view history with decay
        viewHistory.forEach(entry => {
            const viewDate = entry.viewedAt?.toMillis ? entry.viewedAt.toMillis() : entry.viewedAt;
            const daysSince = (now - viewDate) / (1000 * 60 * 60 * 24);
            const weight = Math.exp(-0.1 * daysSince); // Exponential decay
            
            const existing = recipeEngagement.get(entry.recipeId) || { views: 0, cooks: 0, weight: 0 };
            existing.views += 1;
            existing.weight += weight;
            existing.title = entry.recipeTitle;
            recipeEngagement.set(entry.recipeId, existing);
        });

        // Process cook logs with higher weight
        cookLogs.forEach(log => {
            const cookDate = log.cookedDate?.toMillis ? log.cookedDate.toMillis() : log.cookedDate;
            const daysSince = (now - cookDate) / (1000 * 60 * 60 * 24);
            const weight = Math.exp(-0.05 * daysSince) * 3; // Slower decay, higher base weight
            
            const existing = recipeEngagement.get(log.recipeId) || { views: 0, cooks: 0, weight: 0 };
            existing.cooks += 1;
            existing.weight += weight;
            existing.title = log.recipeTitle || existing.title;
            recipeEngagement.set(log.recipeId, existing);
        });

        return Array.from(recipeEngagement.entries())
            .sort((a, b) => b[1].weight - a[1].weight)
            .slice(0, 10)
            .map(([recipeId, data]) => ({
                recipeId,
                title: data.title,
                engagement: data.weight,
                views: data.views,
                cooks: data.cooks
            }));
    }

    /**
     * Analyzes seasonal cooking patterns
     */
    analyzeSeasonalPatterns(cookLogs, recipes) {
        // Simple seasonal analysis - could be expanded
        const seasonalKeywords = {
            spring: ['asparagus', 'peas', 'artichoke', 'spring'],
            summer: ['tomato', 'zucchini', 'corn', 'berries', 'grill'],
            fall: ['pumpkin', 'squash', 'apple', 'sweet potato'],
            winter: ['stew', 'soup', 'roast', 'comfort', 'hearty']
        };

        const seasonalScores = { spring: 0, summer: 0, fall: 0, winter: 0 };
        
        recipes.forEach(recipe => {
            const content = `${recipe.title} ${recipe.ingredients?.map(i => i.item_name).join(' ')}`.toLowerCase();
            
            Object.entries(seasonalKeywords).forEach(([season, keywords]) => {
                keywords.forEach(keyword => {
                    if (content.includes(keyword)) {
                        seasonalScores[season]++;
                    }
                });
            });
        });

        return seasonalScores;
    }

    /**
     * Creates a fallback profile when user data is insufficient
     */
    createFallbackProfile(userId) {
        return {
            userId,
            generatedAt: Date.now(),
            preferredIngredients: [],
            favoriteProteins: [
                { protein: 'chicken', score: 1 },
                { protein: 'salmon', score: 1 }
            ],
            cuisineAffinities: [
                { cuisine: 'italian', score: 1 },
                { cuisine: 'mediterranean', score: 1 }
            ],
            cookingPatterns: { frequency: 'unknown', pattern: 'unknown' },
            complexityPreference: 'medium',
            recentFavorites: [],
            seasonalPreferences: { spring: 0, summer: 0, fall: 0, winter: 0 },
            dataQuality: {
                cookbookSize: 0,
                recentActivity: 0,
                viewHistorySize: 0,
                hasGoodData: false
            }
        };
    }

    /**
     * Formats preference profile for AI prompt consumption
     */
    formatProfileForPrompt(profile) {
        const sections = [];

        // User cooking style
        if (profile.dataQuality.hasGoodData) {
            sections.push(`This user is a ${profile.cookingPatterns.frequency} frequency cook with ${profile.complexityPreference} complexity preference.`);
        }

        // Preferred ingredients
        if (profile.preferredIngredients.length > 0) {
            const topIngredients = profile.preferredIngredients.slice(0, 8).map(i => i.ingredient);
            sections.push(`Frequently used ingredients: ${topIngredients.join(', ')}.`);
        }

        // Protein preferences
        if (profile.favoriteProteins.length > 0) {
            const topProteins = profile.favoriteProteins.slice(0, 5).map(p => p.protein);
            sections.push(`Preferred proteins: ${topProteins.join(', ')}.`);
        }

        // Cuisine preferences
        if (profile.cuisineAffinities.length > 0) {
            const topCuisines = profile.cuisineAffinities.slice(0, 4).map(c => c.cuisine);
            sections.push(`Favored cuisines: ${topCuisines.join(', ')}.`);
        }

        // Recent favorites
        if (profile.recentFavorites.length > 0) {
            const recentTitles = profile.recentFavorites.slice(0, 5).map(r => r.title).filter(Boolean);
            if (recentTitles.length > 0) {
                sections.push(`Recently engaged with: ${recentTitles.join(', ')}.`);
            }
        }

        return sections.join(' ');
    }
}

module.exports = { UserPreferenceAnalyzer }; 