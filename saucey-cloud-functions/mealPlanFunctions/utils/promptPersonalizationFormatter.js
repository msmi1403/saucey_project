/**
 * @fileoverview Prompt Personalization Formatter for optimizing AI token usage
 * Converts detailed user profiles into compact, structured format for AI consumption
 */

class PromptPersonalizationFormatter {

    constructor() {
        this.MAX_INGREDIENTS = 8;
        this.MAX_CUISINES = 5;
        this.MAX_PROTEINS = 4;
        this.MAX_COOKBOOK_RECIPES = 6;
    }

    /**
     * Formats user profile and context into compact AI prompt section
     * @param {object} userProfile - User preference profile
     * @param {Array} selectedCookbookRecipes - Selected cookbook recipes
     * @param {object} varietyGuidance - Variety tracking guidance
     * @returns {string} Compact personalization prompt
     */
    formatPersonalizationPrompt(userProfile, selectedCookbookRecipes = [], varietyGuidance = {}) {
        try {
            const sections = [];

            // Core preferences (structured format)
            const corePrefs = this.formatCorePreferences(userProfile);
            if (corePrefs) sections.push(corePrefs);

            // Cookbook integration
            const cookbookSection = this.formatCookbookRecipes(selectedCookbookRecipes);
            if (cookbookSection) sections.push(cookbookSection);

            // Variety guidance
            const varietySection = this.formatVarietyGuidance(varietyGuidance);
            if (varietySection) sections.push(varietySection);

            // Cooking patterns
            const patternsSection = this.formatCookingPatterns(userProfile);
            if (patternsSection) sections.push(patternsSection);

            return sections.join(' ');

        } catch (error) {
            console.warn('PromptPersonalizationFormatter: Error formatting prompt:', error);
            return this.getFallbackPrompt();
        }
    }

    /**
     * Formats core user preferences in structured format
     * @param {object} userProfile - User preference profile
     * @returns {string} Formatted core preferences
     */
    formatCorePreferences(userProfile) {
        const prefs = [];

        // Top cuisines (compact format)
        if (userProfile.cuisineAffinities?.length > 0) {
            const topCuisines = userProfile.cuisineAffinities
                .slice(0, this.MAX_CUISINES)
                .map(c => c.cuisine)
                .join(',');
            prefs.push(`CUISINES:[${topCuisines}]`);
        }

        // Preferred proteins (compact format)
        if (userProfile.favoriteProteins?.length > 0) {
            const topProteins = userProfile.favoriteProteins
                .slice(0, this.MAX_PROTEINS)
                .map(p => p.protein)
                .join(',');
            prefs.push(`PROTEINS:[${topProteins}]`);
        }

        // Key ingredients (compact format)
        if (userProfile.preferredIngredients?.length > 0) {
            const topIngredients = userProfile.preferredIngredients
                .slice(0, this.MAX_INGREDIENTS)
                .map(i => i.ingredient)
                .join(',');
            prefs.push(`INGREDIENTS:[${topIngredients}]`);
        }

        // Complexity preference
        if (userProfile.complexityPreference) {
            prefs.push(`COMPLEXITY:${userProfile.complexityPreference}`);
        }

        return prefs.length > 0 ? `USER_PREFS:{${prefs.join(' ')}}` : '';
    }

    /**
     * Formats cookbook recipes in compact format
     * @param {Array} selectedRecipes - Selected cookbook recipes
     * @returns {string} Formatted cookbook section
     */
    formatCookbookRecipes(selectedRecipes) {
        if (!selectedRecipes || selectedRecipes.length === 0) {
            return 'COOKBOOK:none_selected';
        }

        const recipeDescriptions = selectedRecipes
            .slice(0, this.MAX_COOKBOOK_RECIPES)
            .map(recipe => {
                // Extract key identifiers efficiently
                const cuisine = recipe.cuisine ? `(${recipe.cuisine})` : '';
                const keyIngredients = recipe.ingredients?.slice(0, 3)
                    .map(i => i.item_name?.split(' ')[0]) // First word only
                    .filter(Boolean)
                    .join(',') || '';
                
                return `"${recipe.title}"${cuisine}${keyIngredients ? `[${keyIngredients}]` : ''}`;
            });

        return `COOKBOOK:{${recipeDescriptions.join(' | ')}}`;
    }

    /**
     * Formats variety guidance into compact prompt format
     * @param {object} varietyGuidance - Variety guidance data
     * @returns {string} Compact variety guidance prompt
     */
    formatVarietyGuidance(varietyGuidance) {
        const parts = [];

        // Add explicit exclusions as HARD CONSTRAINTS - NEW AGGRESSIVE APPROACH
        if (varietyGuidance.explicitExclusions && varietyGuidance.explicitExclusions.length > 0) {
            const exclusions = varietyGuidance.explicitExclusions.slice(0, 8); // Limit to prevent token bloat
            parts.push(`AVOID_EXACTLY:[${exclusions.join(', ')}]`);
        }

        // Existing guidance but made more directive
        if (varietyGuidance.recentProteins && varietyGuidance.recentProteins.length > 0) {
            parts.push(`RECENT_PROTEINS:[${varietyGuidance.recentProteins.join(', ')}]`);
        }

        if (varietyGuidance.recentCuisines && varietyGuidance.recentCuisines.length > 0) {
            parts.push(`RECENT_CUISINES:[${varietyGuidance.recentCuisines.join(', ')}]`);
        }

        if (varietyGuidance.recommendedProteins && varietyGuidance.recommendedProteins.length > 0) {
            parts.push(`PRIORITIZE_PROTEINS:[${varietyGuidance.recommendedProteins.join(', ')}]`);
        }

        if (varietyGuidance.recommendedCuisines && varietyGuidance.recommendedCuisines.length > 0) {
            parts.push(`PRIORITIZE_CUISINES:[${varietyGuidance.recommendedCuisines.join(', ')}]`);
        }

        if (varietyGuidance.diversityScore !== undefined) {
            parts.push(`DIVERSITY_SCORE:${varietyGuidance.diversityScore}`);
        }

        return parts.join(' ');
    }

    /**
     * Formats cooking patterns compactly
     * @param {object} userProfile - User preference profile
     * @returns {string} Formatted cooking patterns
     */
    formatCookingPatterns(userProfile) {
        if (!userProfile.cookingPatterns) {
            return '';
        }

        const patterns = [];
        const cp = userProfile.cookingPatterns;

        if (cp.frequency) {
            patterns.push(`freq:${cp.frequency}`);
        }

        if (cp.preferredDays?.length > 0) {
            const days = cp.preferredDays.slice(0, 3).join(',');
            patterns.push(`days:[${days}]`);
        }

        if (cp.avgCookTime) {
            patterns.push(`time:${cp.avgCookTime}min`);
        }

        return patterns.length > 0 ? `PATTERNS:{${patterns.join(' ')}}` : '';
    }

    /**
     * Generates fallback prompt when formatting fails
     * @returns {string} Basic fallback prompt
     */
    getFallbackPrompt() {
        return 'USER_PREFS:{general_variety} COOKBOOK:none_selected';
    }

    /**
     * Estimates token count for the formatted prompt
     * @param {string} formattedPrompt - The formatted prompt string
     * @returns {number} Estimated token count
     */
    estimateTokenCount(formattedPrompt) {
        // Rough estimation: ~0.75 tokens per word for structured format
        const wordCount = formattedPrompt.split(/\s+/).length;
        return Math.ceil(wordCount * 0.75);
    }

    /**
     * Validates that prompt is within reasonable token limits
     * @param {string} formattedPrompt - The formatted prompt
     * @returns {boolean} Whether prompt is within limits
     */
    isWithinTokenLimits(formattedPrompt) {
        const estimatedTokens = this.estimateTokenCount(formattedPrompt);
        return estimatedTokens <= 120; // Conservative limit for personalization section
    }

    /**
     * Creates a natural language fallback when structured format might be too dense
     * @param {object} userProfile - User preference profile
     * @param {Array} selectedCookbookRecipes - Selected cookbook recipes
     * @returns {string} Natural language prompt (more tokens but clearer)
     */
    formatNaturalLanguagePrompt(userProfile, selectedCookbookRecipes = []) {
        const elements = [];

        // User preferences
        if (userProfile.cuisineAffinities?.length > 0) {
            const topCuisines = userProfile.cuisineAffinities
                .slice(0, 3)
                .map(c => c.cuisine)
                .join(', ');
            elements.push(`User enjoys ${topCuisines} cuisine`);
        }

        if (userProfile.favoriteProteins?.length > 0) {
            const proteins = userProfile.favoriteProteins
                .slice(0, 3)
                .map(p => p.protein)
                .join(', ');
            elements.push(`prefers ${proteins}`);
        }

        // Cookbook recipes
        if (selectedCookbookRecipes.length > 0) {
            const recipeNames = selectedCookbookRecipes
                .slice(0, 3)
                .map(r => `"${r.title}"`)
                .join(', ');
            elements.push(`include cookbook recipes: ${recipeNames}`);
        }

        // Complexity
        if (userProfile.complexityPreference) {
            elements.push(`${userProfile.complexityPreference} complexity preferred`);
        }

        return elements.length > 0 ? elements.join('. ') + '.' : 'Generate varied, appealing meals.';
    }
}

module.exports = PromptPersonalizationFormatter; 