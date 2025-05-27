// /handleRecipeChatTurn/processors/urlProcessor.js

const { fetchRecipeJsonLd } = require('../utils/fetchRecipeJsonLd');
const { normalizeRecipe } = require('../utils/normalizerecipe');
const { extractRelevantTextFromHtmlNode } = require('../utils/htmlTextExtractor');
const geminiService = require('../services/geminiService');
const firestoreService = require('../services/firestoreService');
const { generateUniqueId } = require('@saucey/shared/utils/commonUtils.js');
const config = require('../config');

/**
 * Fetches a recipe from a URL, normalizes it, and then uses Gemini
 * to re-structure and potentially modify it according to the user's prompt
 * and the application's detailed JSON schema.
 */
async function processUrlInput(sourceUrl, userPrompt = null, userId, preferredChefPersonalityKey = 'standard') {
    console.log(`processUrlInput: Starting for URL: ${sourceUrl}. User prompt: "${userPrompt || 'N/A'}". Personality: ${preferredChefPersonalityKey}`);

    try {
        const { recipe: rawRecipeJsonLd, htmlContent } = await fetchRecipeJsonLd(sourceUrl);
        let recipeToProcess = null;
        let processingSource = 'json-ld'; // To track where the primary data came from

        if (rawRecipeJsonLd) {
            console.log(`processUrlInput: Raw recipe JSON-LD fetched for ${sourceUrl}`);
            const normalized = normalizeRecipe(rawRecipeJsonLd);
            if (normalized && normalized.name) { // Check if normalization produced something useful
               recipeToProcess = normalized;
               console.log(`processUrlInput: Initial normalization of JSON-LD complete for: ${recipeToProcess.name}`);
            } else {
                console.warn(`processUrlInput: JSON-LD found but normalization failed or yielded empty result for ${sourceUrl}.`);
            }
        }

        let userPreferences = null;
        try {
            userPreferences = await firestoreService.getUserPreferences(userId);
        } catch (prefError) {
            console.warn(`urlProcessor: Could not fetch user preferences for ${userId}: ${prefError.message}. Proceeding without them.`);
        }
        const chefPreamble = config.CHEF_PERSONALITY_PROMPTS[preferredChefPersonalityKey] || config.CHEF_PERSONALITY_PROMPTS.standard;

        let geminiResult;

        if (recipeToProcess) {
            // Option 1: JSON-LD was found and normalized, send to Gemini for review/reformatting
            let effectiveUserQuery = userPrompt;
            if (!userPrompt || userPrompt.trim() === "") {
                effectiveUserQuery = `This recipe was imported from a URL using its structured data (JSON-LD). Please review its content (name: '${recipeToProcess.name}') and reformat it strictly according to the standard output schema. Ensure all essential recipe details are captured and correctly structured.`;
            }
            effectiveUserQuery += ` (Original source: ${sourceUrl})`;

            geminiResult = await geminiService.getRecipeFromTextChat(
                effectiveUserQuery,
                JSON.stringify(recipeToProcess),
                userPreferences,
                [], 
                chefPreamble
            );
        } else if (htmlContent && htmlContent.trim() !== "") {
            // Option 2: No usable JSON-LD, try extracting text from HTML and sending to Gemini
            console.warn(`processUrlInput: No usable JSON-LD found or normalized for ${sourceUrl}. Attempting fallback with cleaned HTML text.`);
            processingSource = 'html-text';
            const cleanedHtmlText = extractRelevantTextFromHtmlNode(htmlContent);

            if (!cleanedHtmlText || cleanedHtmlText.trim().length < 50) { // Arbitrary short length check
                console.error(`processUrlInput: Fallback failed - cleaned HTML text for ${sourceUrl} is too short or empty.`);
                throw new Error(`Failed to extract sufficient text content from the URL ${sourceUrl} for recipe generation.`);
            }

            geminiResult = await geminiService.getRecipeFromPageText(
                cleanedHtmlText,
                userPrompt, // Pass original user prompt for context
                sourceUrl,
                chefPreamble
            );
        } else {
            // Option 3: No JSON-LD and no HTML content (should be rare if fetchRecipeJsonLd works correctly)
            console.error(`processUrlInput: No JSON-LD and no HTML content available for ${sourceUrl}. Cannot process.`);
            throw new Error(`Unable to retrieve any content (JSON-LD or HTML) from the URL: ${sourceUrl}`);
        }

        // Process Gemini Result
        if (geminiResult && geminiResult.conversationalText && Object.keys(geminiResult).length === 1 && !geminiResult.recipeId) {
            console.warn(`urlProcessor: Gemini returned conversational text for URL ${sourceUrl} (source: ${processingSource}): ${geminiResult.conversationalText}`);
            return {
                conversationalText: `Regarding the URL ${sourceUrl}: ${geminiResult.conversationalText}`,
                requiresSaving: false,
                isNewRecipe: false,
            };
        } else if (geminiResult && geminiResult.title && Array.isArray(geminiResult.ingredients) && Array.isArray(geminiResult.instructions)) {
            let finalRecipe = { ...geminiResult };
            finalRecipe.recipeId = finalRecipe.recipeId || (recipeToProcess ? recipeToProcess.recipeId : null) || generateUniqueId();
            finalRecipe.title = finalRecipe.title || (recipeToProcess ? recipeToProcess.name : null) || config.DEFAULT_RECIPE_TITLE;
            
            console.log(`urlProcessor: Gemini (from ${processingSource}) processed URL content into schema-compliant recipe: ${finalRecipe.title}`);
            return {
                recipe: finalRecipe,
                requiresSaving: true,
                isNewRecipe: true, // Always true for URL imports as we generate a new ID or use one from normalized data
            };
        } else {
            console.error(`urlProcessor: Unexpected response structure from Gemini service for URL ${sourceUrl} (source: ${processingSource}). Response:`, geminiResult);
            throw new Error(`Failed to process recipe from URL ${sourceUrl} into the required schema after Gemini processing (source: ${processingSource}).`);
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