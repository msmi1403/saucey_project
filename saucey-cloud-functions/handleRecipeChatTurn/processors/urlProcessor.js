// /handleRecipeChatTurn/processors/urlProcessor.js

const { fetchRecipeJsonLd } = require('../utils/fetchRecipeJsonLd');
const { normalizeRecipe } = require('../utils/normalizerecipe');
const geminiService = require('../services/geminiService');
const firestoreService = require('../services/firestoreService');

const { generateUniqueId } = require('@saucey/shared/utils/commonUtils.js'); 

const config = require('../config'); // Require config to access CHEF_PERSONALITY_PROMPTS

/**
 * Fetches a recipe from a URL, normalizes it, and then uses Gemini
 * to re-structure and potentially modify it according to the user's prompt
 * and the application's detailed JSON schema.
 */
async function processUrlInput(sourceUrl, userPrompt = null, userId, preferredChefPersonalityKey = 'standard') { // MODIFIED: Added preferredChefPersonalityKey
    console.log(`processUrlInput: Starting for URL: ${sourceUrl}. User prompt: "${userPrompt || 'N/A'}". Personality: ${preferredChefPersonalityKey}`); // MODIFIED: Log personality

    try {
        const rawRecipeJsonLd = await fetchRecipeJsonLd(sourceUrl);
        console.log(`processUrlInput: Raw recipe JSON-LD fetched for ${sourceUrl}`);

        const normalizedRecipeFromUrl = normalizeRecipe(rawRecipeJsonLd);
        console.log(`processUrlInput: Initial normalization complete for: ${normalizedRecipeFromUrl.name}`);

        let effectiveUserQuery = userPrompt;
        if (!userPrompt || userPrompt.trim() === "") {
            effectiveUserQuery = `This recipe was imported from a URL. Please review its content (name: '${normalizedRecipeFromUrl.name}') and reformat it strictly according to the standard output schema. Ensure all essential recipe details are captured and correctly structured.`;
        }
        effectiveUserQuery += ` (Original source: ${sourceUrl})`;

        let userPreferences = null;
        try {
            userPreferences = await firestoreService.getUserPreferences(userId);
        } catch (prefError) {
            console.warn(`urlProcessor: Could not fetch user preferences for ${userId}: ${prefError.message}. Proceeding without them.`);
        }

        // MODIFIED: Get chefPreamble
        const chefPreamble = config.CHEF_PERSONALITY_PROMPTS[preferredChefPersonalityKey] || config.CHEF_PERSONALITY_PROMPTS.standard;

        // MODIFIED: Pass chefPreamble to Gemini
        const geminiResult = await geminiService.getRecipeFromTextChat(
            effectiveUserQuery,
            JSON.stringify(normalizedRecipeFromUrl),
            userPreferences,
            [], // Assuming no prior chat history is passed for a fresh URL import
            chefPreamble // MODIFIED: Pass the chefPreamble
        );

        if (geminiResult && geminiResult.conversationalText && Object.keys(geminiResult).length === 1) {
            console.warn(`urlProcessor: Gemini returned conversational text for URL ${sourceUrl}: ${geminiResult.conversationalText}`);
            return {
                conversationalText: `Regarding the URL ${sourceUrl}: ${geminiResult.conversationalText}`,
                requiresSaving: false,
                isNewRecipe: false,
            };
        } else if (geminiResult && geminiResult.title && Array.isArray(geminiResult.ingredients) && Array.isArray(geminiResult.instructions)) {
            let finalRecipe = { ...geminiResult };
            finalRecipe.recipeId = finalRecipe.recipeId || normalizedRecipeFromUrl.recipeId || generateUniqueId();
            finalRecipe.title = finalRecipe.title || normalizedRecipeFromUrl.name || config.DEFAULT_RECIPE_TITLE;
            
            console.log(`urlProcessor: Gemini processed URL content into schema-compliant recipe: ${finalRecipe.title}`);
            return {
                recipe: finalRecipe,
                requiresSaving: true,
                isNewRecipe: true,
            };
        } else {
            console.error(`urlProcessor: Unexpected response structure from geminiService.getRecipeFromTextChat for URL ${sourceUrl}. Response:`, geminiResult);
            throw new Error(`Failed to process recipe from URL ${sourceUrl} into the required schema after Gemini processing.`);
        }

    } catch (error) {
        console.error(`Error in processUrlInput for ${sourceUrl}:`, error);
        return {
            error: error.message || `Failed to process URL: ${sourceUrl}`,
            requiresSaving: false,
            isNewRecipe: false,
        };
    }
}

module.exports = { processUrlInput };