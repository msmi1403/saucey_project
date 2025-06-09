// /handleRecipeChatTurn/processors/imageProcessor.js

const geminiService = require('../services/geminiService');
const { isValidImageMimeTypeForRecipes } = require('../recipeUtils'); // For recipe-specific MIME validation
const { generateUniqueId } = require('../../shared/utils/commonUtils');
const config = require('../config'); // Require config to access CHEF_PERSONALITY_PROMPTS
const sharedImageProcessor = require('../../shared/services/imageProcessor');

// Use shared validateImageURL function
const validateImageURL = sharedImageProcessor.validateImageURL;

/**
 * Processes an image input (as base64) along with a user prompt.
 * Sends the image data directly to Gemini Vision for analysis/recipe generation.
 */
async function processImageInput(imageDataBase64, imageMimeType, userPrompt, userId, currentRecipeJsonString, preferredChefPersonalityKey = 'standard') { // MODIFIED: Added preferredChefPersonalityKey
    // Use shared image processor for validation (but keep recipe-specific MIME type check)
    const imageProcessingResult = sharedImageProcessor.processImageInput(
        imageDataBase64, 
        imageMimeType, 
        'handleRecipeChatTurn'
    );
    
    if (!imageProcessingResult.success) {
        return { error: imageProcessingResult.error, requiresSaving: false };
    }

    // Additional recipe-specific MIME type validation
    if (!isValidImageMimeTypeForRecipes(imageMimeType)) {
        return { error: `Invalid image MIME type for recipes: ${imageMimeType}. Supported: ${config.SUPPORTED_IMAGE_MIME_TYPES.join(', ')}`, requiresSaving: false };
    }

    try {
        console.log(`processImageInput: Processing inline image for user ${userId} with personality ${preferredChefPersonalityKey}...`); // MODIFIED: Log personality

        let visionUserQuery = userPrompt || "Describe this image and suggest a recipe if applicable, or answer any questions about it.";
        if (currentRecipeJsonString) {
            console.log(`processImageInput: Current recipe JSON provided. Prompt: "${visionUserQuery}"`);
        }

        // MODIFIED: Get chefPreamble
        const chefPreamble = config.CHEF_PERSONALITY_PROMPTS[preferredChefPersonalityKey] || config.CHEF_PERSONALITY_PROMPTS.standard;

        // MODIFIED: Pass chefPreamble to Gemini
        const geminiResponse = await geminiService.getRecipeFromImage(
            imageDataBase64,
            imageMimeType,
            visionUserQuery,
            chefPreamble // MODIFIED: Pass the chefPreamble
        );
        
        if (geminiResponse && geminiResponse.conversationalText && Object.keys(geminiResponse).length === 1 && !geminiResponse.recipeId) {
            console.log("Image input resulted in a direct conversational response from Gemini.");
            return { conversationalText: geminiResponse.conversationalText, requiresSaving: false };
        }
        else if (geminiResponse && geminiResponse.recipeId && geminiResponse.title &&
                 Array.isArray(geminiResponse.ingredients) && Array.isArray(geminiResponse.instructions)) {
            
            let recipeData = { ...geminiResponse }; 
            recipeData.recipeId = recipeData.recipeId || generateUniqueId();
            
            recipeData.source = recipeData.source || 'gemini_image_prompt';
            recipeData.title = recipeData.title || config.DEFAULT_RECIPE_TITLE;
            recipeData.description = recipeData.description || "";
            recipeData.cuisine = recipeData.cuisine || null;
            recipeData.category = recipeData.category || config.DEFAULT_RECIPE_CATEGORY;
            recipeData.difficulty = recipeData.difficulty || config.DEFAULT_DIFFICULTY;
            recipeData.prepTime = recipeData.prepTime || null;
            recipeData.cookTime = recipeData.cookTime || null;
            recipeData.totalTime = recipeData.totalTime || null;
            recipeData.servings = recipeData.servings || config.DEFAULT_SERVINGS;
            recipeData.calories = recipeData.calories || null;
            recipeData.tipsAndVariations = recipeData.tipsAndVariations || [];
            recipeData.keywords = recipeData.keywords || [];
            // Validate imageURL to ensure it's a real URL, not descriptive text
            recipeData.imageURL = validateImageURL(recipeData.imageURL);
            recipeData.isPublic = typeof recipeData.isPublic === 'boolean' ? recipeData.isPublic : false;
            recipeData.isSecretRecipe = typeof recipeData.isSecretRecipe === 'boolean' ? recipeData.isSecretRecipe : false;

            recipeData.ingredients = (recipeData.ingredients || []).map(ing => ({
                item_name: ing.item_name || config.DEFAULT_INGREDIENT_NAME,
                quantity: (typeof ing.quantity === 'number' && !isNaN(ing.quantity)) ? ing.quantity : null,
                unit: typeof ing.unit === 'string' ? ing.unit.trim() || null : null,
                isSecret: typeof ing.isSecret === 'boolean' ? ing.isSecret : false,
                category: typeof ing.category === 'string' ? ing.category.trim() || config.DEFAULT_INGREDIENT_CATEGORY : config.DEFAULT_INGREDIENT_CATEGORY,
            }));

            recipeData.instructions = (recipeData.instructions || []).map(step => ({
                text: (typeof step.text === 'string' ? step.text.trim() : "") || config.UNKNOWN_STEP_TEXT,
                isSecret: typeof step.isSecret === 'boolean' ? step.isSecret : false,
            })).filter(step => step.text && (step.text !== config.UNKNOWN_STEP_TEXT || step.text.trim() !== ""));

            console.log(`Image input resulted in structured recipe: ${recipeData.title} (ID: ${recipeData.recipeId})`);
            return {
                recipe: recipeData,
                recipeId: recipeData.recipeId,
                requiresSaving: true,
                isNewRecipe: !currentRecipeJsonString 
            };
        }
         else if (geminiResponse && (geminiResponse.description || geminiResponse.text || geminiResponse.message)) {
             console.warn("Image input: Gemini response was not a full recipe or direct conversational text. Using description/text/message as conversational fallback.");
             return { conversationalText: geminiResponse.conversationalText || geminiResponse.description || geminiResponse.text || geminiResponse.message, requiresSaving: false };
        }
         else if (geminiResponse && geminiResponse.error) {
            console.error("Gemini returned an error for image processing:", geminiResponse.error);
            return { error: `AI Error: ${geminiResponse.error}`, requiresSaving: false };
        }
         else {
            console.warn("Image processing: Gemini response was not a recognized recipe or structured text. Raw:", JSON.stringify(geminiResponse).substring(0, 500));
            return {
                conversationalText: "I analyzed the image, but I'm not sure how to turn that into a full recipe right now. Could you provide more details or ask differently?",
                requiresSaving: false
            };
        }

    } catch (error) {
        console.error(`Error in processImageInput for user ${userId}:`, error);
        let errorMessage = error.message || "Failed to process image request.";
        if (error.response && error.response.data && error.response.data.error && error.response.data.error.message) {
            errorMessage = `Gemini API Error: ${error.response.data.error.message}`;
        }
        return { error: errorMessage, requiresSaving: false };
    }
}

module.exports = {
    processImageInput,
};