// saucey-cloud-functions/handleRecipeChatTurn/services/geminiService.js

const geminiClient = require('@saucey/shared/services/geminiClient.js'); 
const { extractJsonFromText } = require('@saucey/shared/utils/commonUtils.js'); 
const { modelsInitializationPromise } = require('@saucey/shared/services/geminiClient.js');
const imageProcessor = require('@saucey/shared/services/imageProcessor.js');

const config = require('../config');



// Default safety settings from the shared client can be used or overridden here if needed
const { HarmCategory, HarmBlockThreshold } = geminiClient; // For convenience
const recipeSafetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// Default generation config for natural conversation
const recipeDefaultGenerationConfig = {
    temperature: config.GEMINI_TEXT_TEMPERATURE,
    topP: 0.9,
    topK: 40,
    maxOutputTokens: config.GEMINI_TEXT_MAX_OUTPUT_TOKENS,
    // Remove JSON forcing - allow natural text responses
};

// Ensure the specific models for this service are requested from the shared client.
// Calling getModel is async and caches; subsequent calls are fast.
// This helps ensure they are ready or an error is caught early if misconfigured.
const recipeServiceModelsInitPromise = Promise.all([
    geminiClient.getModel(config.GEMINI_MODEL_NAME).catch(e => { console.error(`Failed to init recipe text model ${config.GEMINI_MODEL_NAME}: ${e.message}`); throw e; }),
    geminiClient.getModel(config.GEMINI_VISION_MODEL_NAME).catch(e => { console.error(`Failed to init recipe vision model ${config.GEMINI_VISION_MODEL_NAME}: ${e.message}`); throw e; })
]).catch(error => {
    console.error("FATAL: Recipe Gemini Service: Initialization of specific models from shared client failed during module load:", error.message);
    // This error will propagate and cause function calls to fail if models aren't available.
});


// Build comprehensive system instruction with all user context (set once per chat)
function buildRichSystemInstruction({
    userPreferences, 
    chefPreambleString, 
    ingredientContext = null
}) {
    let systemSections = [];

    // 1. Chef personality (existing)
    const chefPersonality = chefPreambleString || "You are a helpful, expert, and friendly cooking assistant.";
    systemSections.push(chefPersonality);

    // 2. User preferences (existing, moved up in priority)
    if (userPreferences) {
        let userContext = "\n--- USER PROFILE (remember this throughout our conversation) ---";
        
        if (userPreferences.preferredRecipeDifficulty && userPreferences.preferredRecipeDifficulty !== 'medium') {
            userContext += `\nRecipe Difficulty: Prefers ${userPreferences.preferredRecipeDifficulty} recipes`;
        }
        
        if (userPreferences.preferredCookTimePreference && userPreferences.preferredCookTimePreference !== '') {
            userContext += `\nCook Time: ${userPreferences.preferredCookTimePreference}`;
        }
        
        if (Array.isArray(userPreferences.allergensToAvoid) && userPreferences.allergensToAvoid.length) {
            userContext += `\nALLERGIES - NEVER USE: ${userPreferences.allergensToAvoid.join(', ')}`;
        }
        
        if (Array.isArray(userPreferences.dietaryPreferences) && userPreferences.dietaryPreferences.length) {
            userContext += `\nDietary Lifestyle: ${userPreferences.dietaryPreferences.join(', ')}`;
        }
        
        if (userPreferences.customDietaryNotes && userPreferences.customDietaryNotes.trim() !== '') {
            userContext += `\nSpecial Notes: ${userPreferences.customDietaryNotes}`;
        }
        
        systemSections.push(userContext);
        
        // NEW: Enhanced context with rating insights
        if (userPreferences.enhancedContext) {
            systemSections.push(`\n--- USER COOKING PATTERNS & PREFERENCES ---\n${userPreferences.enhancedContext}`);
        }
    }

    // 3. Recipe Guidelines (essential only)
    const recipeGuidelines = `
WHEN PROVIDING RECIPES:
- Keep titles clean and simple (e.g., "Spicy Chicken Curry")
- Never include dietary restrictions in parentheses in titles
- Acknowledge dietary needs naturally: "Here's a recipe that works with your dietary needs:"
- When helpful, include brief cooking tips in parentheses (especially for techniques that might be unfamiliar)
- When providing a complete recipe with ingredients and instructions, append [save] at the end
- When providing ingredient lists or shopping suggestions, append [Add to cart] at the end
- When providing complete recipes, also append [rate] to allow user feedback
- Full recipe tags: [save][Add to cart][rate]`;

    systemSections.push(recipeGuidelines);

    // 4. Kitchen inventory (existing, lowest priority)
    if (ingredientContext) {
        systemSections.push(`\n--- USER'S KITCHEN (remember this throughout our conversation) ---\n${ingredientContext}`);
    }

    return systemSections.join('\n\n');
}

// Simple user message builder (just the essentials per turn)
function buildSimpleUserMessage({
    userQuery,
    currentRecipeJsonString = null,
    scrapedPageContent = null,
    sourceUrl = null
}) {
    let messageParts = [userQuery];

    // Only add dynamic context that changes per message
    if (currentRecipeJsonString) {
        messageParts.push(`\nCurrent recipe being discussed:\n\`\`\`json\n${currentRecipeJsonString}\n\`\`\``);
    }

    if (scrapedPageContent && sourceUrl) {
        messageParts.push(`\nContent from webpage (${sourceUrl}):\n---\n${scrapedPageContent}\n---`);
    }

    return messageParts.join('\n\n');
}

/**
 * Simplified chat function - rich system instruction, simple user messages
 */
async function getUnifiedChatResponse({
    userQuery, 
    currentRecipeJsonString, 
    userPreferences, 
    chatHistory = [], 
    chefPreambleString = config.CHEF_PERSONALITY_PROMPTS.standard, 
    ingredientContext = null,
    imageDataBase64 = null,
    imageMimeType = null,
    scrapedPageContent = null,
    sourceUrl = null
}) {
    await recipeServiceModelsInitPromise;

    // Build rich system instruction with ALL user context (set once, remembered forever)
    const systemInstructionText = buildRichSystemInstruction({
        userPreferences,
        chefPreambleString,
        ingredientContext
    });

    // Build simple user message (just the query + dynamic context)
    const userMessageText = buildSimpleUserMessage({
        userQuery,
        currentRecipeJsonString,
        scrapedPageContent,
        sourceUrl
    });

    const formattedApiHistory = chatHistory.map(msg => ({
        role: msg.role,
        parts: msg.parts.map(p => ({ text: p.text }))
    })).filter(Boolean);

    // Prepare the user parts - text is always included
    let userParts = [{ text: userMessageText }];

    // Add image if provided
    if (imageDataBase64 && imageMimeType) {
        const imageProcessingResult = imageProcessor.prepareImageForGemini(imageDataBase64, imageMimeType);
        if (imageProcessingResult.success) {
            userParts.push(imageProcessingResult.imagePart);
            console.log(`Unified Chat: Including image in conversation (${imageMimeType})`);
        } else {
            console.warn(`Unified Chat: Image processing failed: ${imageProcessingResult.error}`);
        }
    }

    const contentsForApi = [
        ...formattedApiHistory,
        { role: "user", parts: userParts }
    ];

    // Determine which model to use based on whether image is included
    const modelName = (imageDataBase64 && imageMimeType) ? config.GEMINI_VISION_MODEL_NAME : config.GEMINI_MODEL_NAME;

    console.log(`Unified Chat: Sending ${formattedApiHistory.length} history turns. Using model ${modelName}. Has image: ${!!(imageDataBase64 && imageMimeType)}. Has scraped content: ${!!scrapedPageContent}`);

    try {
        // Use rich system instruction with all user context
        const response = await geminiClient.generateContent({
            modelName: modelName,
            contents: contentsForApi,
            systemInstruction: { 
                parts: [{ text: systemInstructionText }] 
            },
            generationConfig: recipeDefaultGenerationConfig,
            safetySettings: recipeSafetySettings,
        });
        
        const responseText = response.text();
        console.log(`Unified Chat response: ${responseText.substring(0, 500)}...`);
        
        return { conversationalText: responseText.trim() };
    } catch (error) {
        console.error("Error in getUnifiedChatResponse:", error.message);
        throw error;
    }
}



module.exports = {
    getUnifiedChatResponse, // New unified function
};