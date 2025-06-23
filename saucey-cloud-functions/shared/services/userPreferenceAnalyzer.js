const { logger } = require("firebase-functions/v2");
const firestoreHelper = require("./firestoreHelper");

console.log('🧪 SHARED SERVICE TEST: userPreferenceAnalyzer.js loaded at', new Date().toISOString());

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
            const [cookbookRecipes, recentCookLogs, viewHistory, recipeRatings] = await Promise.all([
                this.fetchUserCookbookRecipes(userId),
                this.fetchRecentCookLogs(userId, 30), // Last 30 days
                this.fetchRecentViewHistory(userId, 50), // Last 50 views
                this.fetchRecipeRatings(userId) // NEW: Fetch rating data
            ]);

            logger.info(`UserPreferenceAnalyzer: Fetched ${cookbookRecipes.length} cookbook recipes, ${recentCookLogs.length} cook logs, ${viewHistory.length} view history entries, ${recipeRatings.length} ratings`);

            // Generate preference profile with balanced approach
            const profile = {
                userId,
                generatedAt: Date.now(),
                
                // Ingredient preferences from cookbook with rating boosts
                preferredIngredients: this.extractIngredientPatternsWithRatings(cookbookRecipes, recipeRatings),
                
                // Protein preferences weighted by recent cooking + ratings
                favoriteProteins: this.analyzeProteinPreferencesWithRatings(cookbookRecipes, recentCookLogs, recipeRatings),
                
                // Cuisine preferences from bookmarks, views, and ratings
                cuisineAffinities: this.rankCuisinePreferencesWithRatings(cookbookRecipes, viewHistory, recipeRatings),
                
                // Cooking patterns and frequency
                cookingPatterns: this.analyzeCookingPatterns(recentCookLogs),
                
                // Recipe complexity preference
                complexityPreference: this.deriveComplexityPreference(cookbookRecipes),
                
                // Recently engaged recipes (higher weight for recent activity)
                recentFavorites: this.getRecentlyEngagedRecipes(viewHistory, recentCookLogs),
                
                // Seasonal patterns if enough data
                seasonalPreferences: this.analyzeSeasonalPatterns(recentCookLogs, cookbookRecipes),
                
                // NEW: Rating insights for LLM context
                ratingInsights: this.generateRatingInsights(recipeRatings),
                
                // Data freshness indicators
                dataQuality: {
                    cookbookSize: cookbookRecipes.length,
                    recentActivity: recentCookLogs.length,
                    viewHistorySize: viewHistory.length,
                    ratingsCount: recipeRatings.length,
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
     * Fetches user's recipe ratings from chat interactions
     */
    async fetchRecipeRatings(userId) {
        try {
            const ratings = await firestoreHelper.getCollection(`users/${userId}/recipe_ratings`, {
                orderBy: [{ field: "ratedAt", direction: "desc" }],
                limit: 100
            });
            return ratings || [];
        } catch (error) {
            logger.warn(`UserPreferenceAnalyzer: Error fetching recipe ratings for ${userId}:`, error);
            return [];
        }
    }

    /**
     * Extracts common ingredients from cookbook recipes with rating boosts
     * Balanced approach: All viewed recipes count, liked recipes get modest boost
     */
    extractIngredientPatternsWithRatings(recipes, ratings) {
        const ingredientFrequency = new Map();
        
        // Create lookup for liked recipes (modest boost, not overweight)
        const likedRecipeIds = new Set(
            ratings.filter(r => r.rating === 'liked').map(r => r.recipeId)
        );
        
        recipes.forEach(recipe => {
            if (recipe.ingredients && Array.isArray(recipe.ingredients)) {
                // Base weight for all viewed recipes
                const baseWeight = 1;
                // Modest boost for liked recipes (not overwhelming)
                const ratingBoost = likedRecipeIds.has(recipe.recipeId) ? 0.5 : 0;
                const totalWeight = baseWeight + ratingBoost;
                
                recipe.ingredients.forEach(ingredient => {
                    const name = ingredient.item_name?.toLowerCase().trim();
                    if (name && name.length > 2) {
                        ingredientFrequency.set(name, (ingredientFrequency.get(name) || 0) + totalWeight);
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
     * Analyzes protein preferences with ratings and cooking activity
     * Balanced approach: Views + cooking + rating boosts
     */
    analyzeProteinPreferencesWithRatings(recipes, cookLogs, ratings) {
        const proteinKeywords = ['chicken', 'beef', 'pork', 'fish', 'salmon', 'shrimp', 'tofu', 'turkey', 'lamb'];
        const proteinScores = new Map();
        
        // Create lookup for liked recipes
        const likedRecipeIds = new Set(
            ratings.filter(r => r.rating === 'liked').map(r => r.recipeId)
        );
        
        // Score from cookbook recipes (base preference from viewing)
        recipes.forEach(recipe => {
            const title = recipe.title?.toLowerCase() || '';
            const ingredients = recipe.ingredients?.map(i => i.item_name?.toLowerCase()).join(' ') || '';
            const content = `${title} ${ingredients}`;
            
            // Base weight for all viewed recipes
            const baseWeight = 1;
            // Modest boost for liked recipes
            const ratingBoost = likedRecipeIds.has(recipe.recipeId) ? 0.5 : 0;
            const totalWeight = baseWeight + ratingBoost;
            
            proteinKeywords.forEach(protein => {
                if (content.includes(protein)) {
                    proteinScores.set(protein, (proteinScores.get(protein) || 0) + totalWeight);
                }
            });
        });

        // Strong boost for recently cooked proteins (action > viewing)
        cookLogs.forEach(log => {
            const title = log.recipeTitle?.toLowerCase() || '';
            proteinKeywords.forEach(protein => {
                if (title.includes(protein)) {
                    proteinScores.set(protein, (proteinScores.get(protein) || 0) + 3); // Cooking still gets highest weight
                }
            });
        });

        return Array.from(proteinScores.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([protein, score]) => ({ protein, score }));
    }

    /**
     * Ranks cuisine preferences from bookmarks, views, and ratings
     * Balanced approach: Views + rating boosts
     */
    rankCuisinePreferencesWithRatings(recipes, viewHistory, ratings) {
        const cuisineScores = new Map();
        
        // Create lookup for liked recipes
        const likedRecipeIds = new Set(
            ratings.filter(r => r.rating === 'liked').map(r => r.recipeId)
        );
        
        // Score from saved recipes (base preference from saving)
        recipes.forEach(recipe => {
            if (recipe.cuisine) {
                const cuisine = recipe.cuisine.toLowerCase();
                // Base weight for all saved recipes
                const baseWeight = 2;
                // Modest boost for liked recipes
                const ratingBoost = likedRecipeIds.has(recipe.recipeId) ? 1 : 0;
                const totalWeight = baseWeight + ratingBoost;
                
                cuisineScores.set(cuisine, (cuisineScores.get(cuisine) || 0) + totalWeight);
            }
        });

        // Score from view history (lighter weight for browsing behavior)
        viewHistory.forEach(entry => {
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
            // Skip entries without valid recipeId
            if (!entry.recipeId) {
                return;
            }
            
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
            // Skip logs without valid recipeId
            if (!log.recipeId) {
                return;
            }
            
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
            }))
            .filter(recipe => recipe.recipeId); // Final safety filter
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
            sections.push(`User cooks ${profile.cookingPatterns.frequency === 'high' ? 'often' : profile.cookingPatterns.frequency === 'low' ? 'occasionally' : 'regularly'} and prefers ${profile.complexityPreference} complexity recipes.`);
        }

        // Preferred ingredients
        if (profile.preferredIngredients.length > 0) {
            const topIngredients = profile.preferredIngredients.slice(0, 8).map(i => i.ingredient);
            sections.push(`Often uses: ${topIngredients.join(', ')}.`);
        }

        // Protein preferences
        if (profile.favoriteProteins.length > 0) {
            const topProteins = profile.favoriteProteins.slice(0, 5).map(p => p.protein);
            sections.push(`Likes ${topProteins.join(', ')}.`);
        }

        // Cuisine preferences
        if (profile.cuisineAffinities.length > 0) {
            const topCuisines = profile.cuisineAffinities.slice(0, 4).map(c => c.cuisine);
            sections.push(`Enjoys ${topCuisines.join(', ')} flavors.`);
        }

        // Recent favorites
        if (profile.recentFavorites.length > 0) {
            const recentTitles = profile.recentFavorites.slice(0, 5).map(r => r.title).filter(Boolean);
            if (recentTitles.length > 0) {
                sections.push(`Recently made: ${recentTitles.join(', ')}.`);
            }
        }

        // NEW: Rating insights for better LLM context
        if (profile.ratingInsights && profile.ratingInsights.hasRatingData) {
            if (profile.ratingInsights.recentLikedTitles.length > 0) {
                sections.push(`Recently liked recipes: ${profile.ratingInsights.recentLikedTitles.slice(0, 5).join(', ')}.`);
            }
            
            // Add engagement context
            if (profile.ratingInsights.engagementLevel === 'high') {
                sections.push(`User actively rates recipes (${profile.ratingInsights.totalLikes} likes).`);
            }
        }

        return sections.join(' ');
    }

    /**
     * Builds ingredient context for AI prompts from user's current kitchen inventory
     * @param {string} userId - User ID
     * @returns {Promise<string|null>} Formatted ingredient context or null if no data
     */
    async buildIngredientContext(userId) {
        if (!userId) {
            logger.warn('UserPreferenceAnalyzer: No userId provided for ingredient context');
            return null;
        }

        try {
            logger.info(`UserPreferenceAnalyzer: Building ingredient context for user ${userId}`);
            const ingredientsDoc = await this._fetchUserIngredients(userId);
            if (!ingredientsDoc) {
                logger.info(`UserPreferenceAnalyzer: No ingredients document found for user ${userId}`);
                return null; // Silent fallback
            }

            const { availableSpices, availableSauces, recentIngredients } = this._parseAndFilterIngredients(ingredientsDoc);

            // Return null if no usable ingredients (silent fallback)
            if (availableSpices.length === 0 && availableSauces.length === 0 && recentIngredients.length === 0) {
                logger.info(`UserPreferenceAnalyzer: No usable ingredients found for user ${userId}`);
                return null;
            }

            const context = this._formatIngredientContextForAI(availableSpices, availableSauces, recentIngredients);
            logger.info(`UserPreferenceAnalyzer: Built ingredient context for user ${userId}: ${context ? 'success' : 'failed'}`);
            return context;

        } catch (error) {
            logger.error('UserPreferenceAnalyzer: Error building ingredient context:', error);
            return null; // Silent fallback on error
        }
    }

    /**
     * Fetches user ingredients from Firestore
     * @private
     */
    async _fetchUserIngredients(userId) {
        try {
            const ingredientsDoc = await firestoreHelper.getDocument(`users/${userId}/ingredients`, 'current');
            logger.info(`UserPreferenceAnalyzer: Fetched ingredients document for user ${userId}: ${ingredientsDoc ? 'found' : 'not found'}`);
            
            if (ingredientsDoc) {
                logger.info(`UserPreferenceAnalyzer: Document contents - ingredients: ${ingredientsDoc.ingredients?.length || 0}, spices: ${ingredientsDoc.spices?.length || 0}, sauces: ${ingredientsDoc.sauces?.length || 0}`);
            }
            
            return ingredientsDoc;
        } catch (error) {
            logger.error(`UserPreferenceAnalyzer: Error fetching ingredients for user ${userId}:`, error);
            return null;
        }
    }

    /**
     * Parses and filters ingredients based on freshness rules
     * @private
     */
    _parseAndFilterIngredients(ingredientsDoc) {
        const now = Date.now();
        const FRESHNESS_THRESHOLD = 21 * 24 * 60 * 60 * 1000; // 3 weeks in milliseconds

        // Check document freshness
        const lastUpdated = ingredientsDoc.lastUpdated?.toDate?.() || new Date(ingredientsDoc.lastUpdated || 0);
        const isRecent = (now - lastUpdated.getTime()) < FRESHNESS_THRESHOLD;

        logger.info(`UserPreferenceAnalyzer: Ingredient document age - lastUpdated: ${lastUpdated.toISOString()}, isRecent: ${isRecent}`);

        // Parse available spices/sauces (persistent items)
        const availableSpices = (ingredientsDoc.spices || [])
            .filter(item => item.isAvailable === true)
            .map(item => item.name)
            .filter(Boolean);

        const availableSauces = (ingredientsDoc.sauces || [])
            .filter(item => item.isAvailable === true)
            .map(item => item.name)
            .filter(Boolean);

        // Parse recent ingredients (consumable items - only if recent)
        const recentIngredients = isRecent 
            ? (ingredientsDoc.ingredients || [])
                .filter(item => item.isAvailable === true)
                .map(item => item.quantity ? `${item.name} (${item.quantity})` : item.name)
                .filter(Boolean)
            : [];

        logger.info(`UserPreferenceAnalyzer: Filtered ingredients - spices: ${availableSpices.length}, sauces: ${availableSauces.length}, recent: ${recentIngredients.length}`);

        return { availableSpices, availableSauces, recentIngredients };
    }

    /**
     * Formats ingredient data for AI prompt (Option B format)
     * @private
     */
    _formatIngredientContextForAI(availableSpices, availableSauces, recentIngredients) {
        const spicesAndCondiments = [...availableSpices, ...availableSauces];
        
        let context = "Available in kitchen:\n";
        
        if (spicesAndCondiments.length > 0) {
            context += `Spices & Condiments: ${spicesAndCondiments.join(', ')}\n`;
        }
        
        if (recentIngredients.length > 0) {
            context += `Fresh Ingredients: ${recentIngredients.join(', ')}\n`;
        }
        
        return context.trim();
    }

    /**
     * Generates rating insights for LLM context
     * Provides specific information about liked/disliked recipes for better AI recommendations
     */
    generateRatingInsights(ratings) {
        if (ratings.length === 0) {
            return {
                likedRecipes: [],
                totalLikes: 0,
                totalDislikes: 0,
                recentLikedTitles: [],
                hasRatingData: false
            };
        }

        const likedRatings = ratings.filter(r => r.rating === 'liked');
        const dislikedRatings = ratings.filter(r => r.rating === 'disliked');
        
        // Get recent liked recipe titles for LLM context
        const recentLikedTitles = likedRatings
            .slice(0, 8) // Most recent 8 liked recipes
            .map(r => r.recipeTitle)
            .filter(Boolean);

        return {
            likedRecipes: likedRatings.map(r => ({
                title: r.recipeTitle,
                ratedAt: r.ratedAt,
                source: r.source
            })),
            totalLikes: likedRatings.length,
            totalDislikes: dislikedRatings.length,
            recentLikedTitles,
            hasRatingData: true,
            engagementLevel: ratings.length >= 5 ? 'high' : ratings.length >= 2 ? 'medium' : 'low'
        };
    }
}

module.exports = { UserPreferenceAnalyzer }; 