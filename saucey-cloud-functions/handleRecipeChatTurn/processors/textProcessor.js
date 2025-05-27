// /handleRecipeChatTurn/processors/textProcessor.js

const geminiService = require('../services/geminiService');
const firestoreService = require('../services/firestoreService');
const { generateUniqueId } = require('@saucey/shared/utils/commonUtils.js'); 
const config = require('../config');

/**
 * Processes a textual interaction.
 *
 * @param {string} userPrompt - The user's current text input.
 * @param {string|null} currentRecipeJsonString - JSON string of the recipe being discussed, if any.
 * @param {string} userId - The ID of the user making the request.
 * @param {string|null} responseType - Optional: "titles_only" to request just recipe titles.
 * @param {Array<object>} chatHistory - Optional: Array of previous chat messages.
 * @param {string|null} preferredChefPersonalityKey - Optional: Key for the desired chef personality.
 * @returns {Promise<object>} An object containing recipe data, titles, conversational text, or an error.
 * Structure: { recipe?: object, recipeId?: string, titles?: string[], conversationalText?: string, error?: string, requiresSaving: boolean, isNewRecipe?: boolean }
 */
async function processTextualInteraction(userPrompt, currentRecipeJsonString, userId, responseType = null, chatHistory = [], preferredChefPersonalityKey = 'standard') { // Added preferredChefPersonalityKey
    if (!userPrompt && !currentRecipeJsonString && responseType !== "titles_only") {
        return { error: "No user prompt or current recipe provided.", requiresSaving: false };
    }
    if (responseType === "titles_only" && !userPrompt) {
        return { error: "User prompt is required for titles_only request.", requiresSaving: false };
    }

    let userPreferences = null;
    if (responseType !== "titles_only") { // Only fetch preferences if not a titles_only request
        try {
            userPreferences = await firestoreService.getUserPreferences(userId);
        } catch (prefError) {
            console.warn(`Could not fetch user preferences for ${userId}: ${prefError.message}. Proceeding without them.`);
        }
    }

    // Retrieve chef personality preamble
    const chefPreamble = config.CHEF_PERSONALITY_PROMPTS[preferredChefPersonalityKey] || config.CHEF_PERSONALITY_PROMPTS.standard;

    try {
        // Handle "titles_only" request type
        if (responseType === "titles_only") {
            console.log(`TextProcessor: Handling 'titles_only' request for prompt: "${userPrompt.substring(0,100)}..."`);
            // For titles_only, chatHistory and chefPreamble are generally not needed as it's a direct request for new ideas.
            // However, if personality should influence title *style*, chefPreamble could be passed to getRecipeTitlesOnly.
            // For now, keeping it simple.
            const titlesResponse = await geminiService.getRecipeTitlesOnly(userPrompt /*, chefPreamble */); // Optionally pass chefPreamble
            if (titlesResponse && Array.isArray(titlesResponse.titles)) {
                return { titles: titlesResponse.titles, requiresSaving: false };
            } else {
                console.error("TextProcessor: getRecipeTitlesOnly did not return the expected format.");
                return { error: "Failed to get titles in the expected format.", requiresSaving: false };
            }
        }

        // Original logic for full recipe or conversational text, now including chatHistory and chefPreamble
        const geminiResponse = await geminiService.getRecipeFromTextChat(
            userPrompt,
            currentRecipeJsonString,
            userPreferences,
            chatHistory, // Pass chatHistory to Gemini service
            chefPreamble // Pass the selected chefPreamble
        );

        if (geminiResponse && geminiResponse.conversationalText && Object.keys(geminiResponse).length === 1 && !geminiResponse.recipeId) {
            console.log("Text interaction resulted in a direct conversational response from Gemini.");
            return { conversationalText: geminiResponse.conversationalText, requiresSaving: false };
        } else if (geminiResponse && geminiResponse.recipeId && geminiResponse.title &&
                 Array.isArray(geminiResponse.ingredients) && Array.isArray(geminiResponse.instructions)) {
            
            let recipeData = { ...geminiResponse }; // Copy the response from Gemini
            let isNewRecipe = true;

            // Determine if it's a new recipe or an edit based on recipeId and currentRecipeJsonString
            if (currentRecipeJsonString) {
                const currentRecipe = JSON.parse(currentRecipeJsonString);
                if (currentRecipe.recipeId === recipeData.recipeId) {
                    isNewRecipe = false; // It's an edit of the current recipe
                    console.log(`TextProcessor: Gemini modified existing recipeId: ${recipeData.recipeId}`);
                } else {
                    // Gemini returned a recipe with a *different* ID or a new ID when one was expected.
                    // This means Gemini decided to create a new recipe based on the prompt,
                    // even if a currentRecipeJsonString was provided.
                    console.log(`TextProcessor: Gemini returned a recipe with new/different ID ${recipeData.recipeId} despite context of ${currentRecipe.recipeId}. Treating as new/variant.`);
                    recipeData.recipeId = recipeData.recipeId || generateUniqueId(); // Ensure new ID if Gemini didn't make one explicit or changed it
                }
            } else {
                // No currentRecipeJsonString, so it must be a new recipe if one is returned.
                recipeData.recipeId = recipeData.recipeId || generateUniqueId();
                 console.log(`TextProcessor: New recipe generated by Gemini with recipeId: ${recipeData.recipeId}`);
            }
            
            // Normalize and apply defaults to ensure schema consistency
            recipeData.title = recipeData.title || config.DEFAULT_RECIPE_TITLE;
            recipeData.description = recipeData.description || "";
            recipeData.cuisine = recipeData.cuisine || null;
            recipeData.category = recipeData.category || config.DEFAULT_RECIPE_CATEGORY;
            recipeData.difficulty = recipeData.difficulty || config.DEFAULT_DIFFICULTY;
            recipeData.prepTime = recipeData.prepTime || null;
            recipeData.cookTime = recipeData.cookTime || null;
            recipeData.totalTime = recipeData.totalTime || null;
            recipeData.servings = typeof recipeData.servings === 'number' ? recipeData.servings : config.DEFAULT_SERVINGS;
            recipeData.calories = recipeData.calories || null;
            recipeData.tipsAndVariations = recipeData.tipsAndVariations || [];
            recipeData.keywords = recipeData.keywords || [];
            recipeData.imageURL = recipeData.imageURL || null; // Gemini might provide this based on schema
            recipeData.isPublic = typeof recipeData.isPublic === 'boolean' ? recipeData.isPublic : false;
            recipeData.isSecretRecipe = typeof recipeData.isSecretRecipe === 'boolean' ? recipeData.isSecretRecipe : false;

            recipeData.ingredients = (recipeData.ingredients || []).map(ing => ({
                item_name: ing.item_name || config.DEFAULT_INGREDIENT_NAME,
                quantity: (typeof ing.quantity === 'number' && !isNaN(ing.quantity)) ? ing.quantity : null,
                unit: typeof ing.unit === 'string' ? ing.unit.trim() || null : null,
                isSecret: typeof ing.isSecret === 'boolean' ? ing.isSecret : false,
                category: typeof ing.category === 'string' && ing.category.trim() ? ing.category.trim() : config.DEFAULT_INGREDIENT_CATEGORY,
            }));

            recipeData.instructions = (recipeData.instructions || []).map(step => ({
                text: (typeof step.text === 'string' ? step.text.trim() : "") || config.UNKNOWN_STEP_TEXT,
                isSecret: typeof step.isSecret === 'boolean' ? step.isSecret : false,
            })).filter(step => step.text && (step.text !== config.UNKNOWN_STEP_TEXT || step.text.trim() !== "")); // Filter out truly empty steps

            console.log(`Text interaction resulted in structured recipe: ${recipeData.title} (ID: ${recipeData.recipeId}), New: ${isNewRecipe}`);
            return {
                recipe: recipeData,
                recipeId: recipeData.recipeId,
                requiresSaving: true, // Recipes from text chat that are structured are usually meant to be saved/updated
                isNewRecipe: isNewRecipe
            };
        } else if (geminiResponse && typeof geminiResponse === 'object' && Object.keys(geminiResponse).length > 0) {
            // Fallback for other (less ideal) structured responses
            if (geminiResponse.error) {
                console.error("TextProcessor: Gemini returned an error in its object:", geminiResponse.error);
                return { error: `AI Error: ${geminiResponse.error}`, requiresSaving: false };
            }
            const anyText = geminiResponse.text || geminiResponse.message || JSON.stringify(geminiResponse);
            console.warn("TextProcessor: Gemini response was an object but not a recognized recipe or direct conversational structure. Using fallback. Raw:", anyText.substring(0, 300));
            return { conversationalText: `I received an unexpected structured response: ${anyText.substring(0,300)}...`, requiresSaving: false };
        } else {
            console.warn("TextProcessor: Gemini response was not a recognized structure. Raw:", geminiResponse);
            return {
                conversationalText: "I received a response, but I'm not sure how to interpret it right now. Could you try rephrasing?",
                requiresSaving: false
            };
        }
    } catch (error) {
        console.error(`Error in processTextualInteraction for user ${userId}:`, error);
        return { error: error.message || "Failed to process text request.", requiresSaving: false };
    }
}

module.exports = {
    processTextualInteraction,
};