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

// Default generation config specific to recipe tasks, using values from this function's config
const recipeDefaultGenerationConfig = {
    temperature: config.GEMINI_TEXT_TEMPERATURE,
    topP: 0.9,
    topK: 40,
    maxOutputTokens: config.GEMINI_TEXT_MAX_OUTPUT_TOKENS,
    responseMimeType: "application/json", // Common for recipe structured output
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


// This function remains specific to handleRecipeChatTurn's context building
function buildCurrentUserTurnContextualPrompt(userQuery, currentRecipeJsonString, userPreferences, chefPreamble, userIngredients = null) {
    let promptSections = [];
    const standardChefPreamble = config.CHEF_PERSONALITY_PROMPTS.standard || "You are a helpful, expert, and friendly cooking assistant.";

    // Determine the effective preamble based on preferredChefPersonalityKey
    let effectivePreamble = chefPreamble; // This is already the resolved preamble string passed in
    if (!effectivePreamble || effectivePreamble.trim() === "" || effectivePreamble === standardChefPreamble) {
        if (standardChefPreamble.trim() !== "") {
            promptSections.push(standardChefPreamble);
        }
    } else {
        promptSections.push(effectivePreamble);
    }

    if (promptSections.length > 0) {
      promptSections.push("\nNow, regarding the user's request...");
    }

    promptSections.push(`User's current request: "${userQuery}"`);

    if (currentRecipeJsonString) {
      promptSections.push("\nFor context, here is a recipe currently being discussed or considered for modification (referred to as 'Current Recipe JSON' in system instructions):");
      promptSections.push("```json\n" + currentRecipeJsonString + "\n```");
    }

    // Add ingredient context
    if (userIngredients && userIngredients.ingredients && Array.isArray(userIngredients.ingredients) && userIngredients.ingredients.length > 0) {
      const ingredientsByLocation = {};
      userIngredients.ingredients.forEach(ingredient => {
        if (!ingredientsByLocation[ingredient.location]) {
          ingredientsByLocation[ingredient.location] = [];
        }
        const ingredientText = ingredient.quantity ? `${ingredient.name} (${ingredient.quantity})` : ingredient.name;
        ingredientsByLocation[ingredient.location].push(ingredientText);
      });

      let ingredientsContext = "\nUser's Available Ingredients:";
      Object.entries(ingredientsByLocation).forEach(([location, ingredients]) => {
        const locationDisplay = location.charAt(0).toUpperCase() + location.slice(1);
        ingredientsContext += `\n- ${locationDisplay}: ${ingredients.join(', ')}`;
      });
      
      ingredientsContext += `\n\nIMPORTANT: When suggesting recipes, prioritize ingredients the user already has. If the recipe requires ingredients they don't have, suggest substitutions using their available ingredients or mention which ingredients they'd need to buy.`;
      
      promptSections.push(ingredientsContext);
    }

    if (userPreferences) {
      let preferencesText = "";
      if (Array.isArray(userPreferences.selected_filters) && userPreferences.selected_filters.length) {
        preferencesText += `\n- User's Dietary Preferences: ${userPreferences.selected_filters.join(', ')}.`;
      }
      if (userPreferences.custom_notes) {
        preferencesText += `\n- User's Other Notes: ${userPreferences.custom_notes}.`;
      }
      if (preferencesText) {
        promptSections.push(`\nPlease consider the following user preferences if relevant to the request:${preferencesText}`);
      }
    }
    
    promptSections.push(`\nBased on all the provided context (conversation history, this current request, any 'Current Recipe JSON' above, and user preferences), please generate a response. Strictly follow the JSON output schema and behavioral guidelines defined in the overall system instructions.`);
    // The validation check part of the prompt:
    promptSections.push(`\nAfter you output the primary JSON, re-print that JSON in a fenced code block and append on a new line: "✅ VALID JSON" if it strictly conforms to the schema, or "❌ INVALID JSON" otherwise.`);
    return promptSections.join('\n\n');
}


async function getRecipeFromTextChat(userQuery, currentRecipeJsonString, userPreferences, chatHistory = [], chefPreambleString = config.CHEF_PERSONALITY_PROMPTS.standard, userIngredients = null) {
    await recipeServiceModelsInitPromise;

    const currentUserTurnPromptText = buildCurrentUserTurnContextualPrompt(userQuery, currentRecipeJsonString, userPreferences, chefPreambleString, userIngredients);
    const formattedApiHistory = chatHistory.map(msg => ({
        role: msg.role,
        parts: msg.parts.map(p => ({ text: p.text }))
    })).filter(Boolean);

    const contentsForApi = [
        ...formattedApiHistory,
        { role: "user", parts: [{ text: currentUserTurnPromptText }] }
    ];

    console.log(`Recipe Gemini Service (Text Chat): Sending ${formattedApiHistory.length} history turns. Using model ${config.GEMINI_MODEL_NAME}.`);

    try {
        // Call the shared client's generic generateContent method
        const response = await geminiClient.generateContent({
            modelName: config.GEMINI_MODEL_NAME,
            contents: contentsForApi,
            systemInstruction: { parts: [{ text: config.DETAILED_RECIPE_JSON_SCHEMA_PROMPT.system }] },
            generationConfig: recipeDefaultGenerationConfig,
            safetySettings: recipeSafetySettings,
        });
        
        const responseText = response.text();
        console.log(`Raw Recipe Gemini text response: ${responseText.substring(0, 500)}...`);
        return extractJsonFromText(responseText); // From shared utils
    } catch (error) {
        console.error("Error in getRecipeFromTextChat (Recipe Service):", error.message);
        throw error;
    }
}

async function getRecipeFromImage(imageDataBase64, imageMimeType, userQuery, chefPreambleString = config.CHEF_PERSONALITY_PROMPTS.standard) {
    await recipeServiceModelsInitPromise;

    // Use shared image processor for validation and preparation
    const imageProcessingResult = imageProcessor.prepareImageForGemini(imageDataBase64, imageMimeType);
    if (imageProcessingResult.error) {
        throw new Error(`Image processing failed: ${imageProcessingResult.error}`);
    }

    const systemPromptText = config.DETAILED_RECIPE_JSON_SCHEMA_PROMPT.system;
    const standardChefPreamble = config.CHEF_PERSONALITY_PROMPTS.standard || "You are a helpful, expert, and friendly cooking assistant.";
    let personalityInstruction = "";

    if (chefPreambleString && chefPreambleString.trim() !== "" && chefPreambleString !== standardChefPreamble) {
      personalityInstruction = chefPreambleString + "\n\nNow, considering the image provided and the user's query:\n";
    } else if (standardChefPreamble.trim() !== "") {
        personalityInstruction = standardChefPreamble + "\n\nNow, considering the image provided and the user's query:\n";
    }
    
    // Reconstruct the userInstructionSegment from your original geminiService.js
    let userInstructionSegment = `${personalityInstruction}User's query about the provided image: "${userQuery || "Please analyze this image and suggest a recipe if applicable, or answer related questions."}"

Evaluate the user's query in conjunction with the image content:
1. If the query asks for a recipe that can be reasonably derived from or inspired by the image (e.g., ingredients shown, a depicted dish):
   Generate a creative and delicious recipe. Return the *complete new recipe* strictly following the JSON schema defined in the system instructions. Ensure you generate and include a new "recipeId".

2. If the query is a general question about the image that does not require a full recipe (e.g., "is this ripe?", "what type of fruit is this?"):
   Provide a helpful and direct answer. Return this answer using ONLY the "conversationalText" field in the JSON response, as described in the system instructions. Do not include a "recipeId" or other recipe fields in this case.

Always respond with a JSON object.
After you output the JSON, re-print it in a fenced code block and append on a new line: "✅ VALID JSON" if it strictly conforms to the schema, or "❌ INVALID JSON" otherwise.`;

    const visionUserQueryParts = [
        { text: userInstructionSegment },
        imageProcessingResult.geminiFormat
    ];
    
    console.log(`Recipe Gemini Service (Vision): Processing image. Using model ${config.GEMINI_VISION_MODEL_NAME}.`);

    try {
        const response = await geminiClient.generateContent({
            modelName: config.GEMINI_VISION_MODEL_NAME,
            contents: [{ role: "user", parts: visionUserQueryParts }],
            systemInstruction: { parts: [{ text: systemPromptText }] },
            generationConfig: recipeDefaultGenerationConfig,
            safetySettings: recipeSafetySettings,
        });
        const responseText = response.text();
        console.log(`Raw Recipe Gemini vision response: ${responseText.substring(0, 500)}...`);
        return extractJsonFromText(responseText);
    } catch (error) {
        console.error("Error in getRecipeFromImage (Recipe Service):", error.message);
        throw error;
    }
}

async function getRecipeFromPageText(pageTextContent, userInstructions, sourceUrl, chefPreambleString = config.CHEF_PERSONALITY_PROMPTS.standard) {
    await recipeServiceModelsInitPromise;

    const systemPromptText = config.DETAILED_RECIPE_JSON_SCHEMA_PROMPT.system;
    const standardChefPreamble = config.CHEF_PERSONALITY_PROMPTS.standard || "You are a helpful, expert, and friendly cooking assistant.";
    let personalityInstruction = "";

    if (chefPreambleString && chefPreambleString.trim() !== "" && chefPreambleString !== standardChefPreamble) {
      personalityInstruction = chefPreambleString + "\n\nNow, considering the following text extracted from a webpage and the user's query:\n";
    } else if (standardChefPreamble.trim() !== "") {
        personalityInstruction = standardChefPreamble + "\n\nNow, considering the following text extracted from a webpage and the user's query:\n";
    }

    let userTurnText = `${personalityInstruction}`;
    userTurnText += `Source URL (for context only, content below is extracted): ${sourceUrl}\n`;
    if (userInstructions && userInstructions.trim() !== "") {
        userTurnText += `User's specific instructions for this URL: "${userInstructions}"\n\n`;
    }
    userTurnText += "Extracted Page Content:\n---\n" + pageTextContent + "\n---";
    
    console.log(`Recipe Gemini Service (Page Text): Sending request for URL ${sourceUrl}. Using model ${config.GEMINI_MODEL_NAME}. Text length: ${pageTextContent.length}`);

    try {
        const response = await geminiClient.generateContent({
            modelName: config.GEMINI_MODEL_NAME,
            contents: [{ role: "user", parts: [{ text: userTurnText }] }],
            systemInstruction: { parts: [{ text: systemPromptText }] },
            generationConfig: config.recipeDefaultGenerationConfig,
            safetySettings: config.recipeSafetySettings,
        });
        
        const responseText = response.text();
        console.log(`Raw Recipe Gemini (from page text) response for ${sourceUrl}: ${responseText.substring(0, 500)}...`);
        return extractJsonFromText(responseText);
    } catch (error) {
        console.error(`Error in getRecipeFromPageText for URL ${sourceUrl} (Recipe Service):`, error.message);
        throw error;
    }
}

async function getRecipeTitlesOnly(userQuery, chefPreambleString = config.CHEF_PERSONALITY_PROMPTS.standard) {
    await recipeServiceModelsInitPromise;
    const standardChefPreamble = config.CHEF_PERSONALITY_PROMPTS.standard || "You are a helpful, expert, and friendly cooking assistant.";
    let personalityInstruction = "";
    if (chefPreambleString && chefPreambleString.trim() !== "" && chefPreambleString !== standardChefPreamble) {
      personalityInstruction = chefPreambleString + "\n\nBased on this persona, and the user's request:\n";
    } else if (standardChefPreamble.trim() !== "") {
        personalityInstruction = standardChefPreamble + "\n\nBased on this persona, and the user's request:\n";
    }
    const prompt = `${personalityInstruction}${userQuery}\n\nYou are a helpful culinary chef (or the persona described above). Generate concise, appealing, and distinct recipe titles based on the user query and your persona.\nPlease provide the answer ONLY as a JSON object with a single key "titles" which contains an array of these string titles. For example:\n{\n  "titles": ["Quick Chicken Stir-fry", "Spicy Shrimp Tacos", "Creamy Tomato Pasta"]\n}\nDo not include any other text, commentary, or markdown formatting like \`\`\`json. Just the JSON object.`;

    console.log(`Recipe Gemini Service (Titles Only): Processing. Using model ${config.GEMINI_MODEL_NAME}.`);
    try {
        const response = await geminiClient.generateContent({
            modelName: config.GEMINI_MODEL_NAME,
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { ...recipeDefaultGenerationConfig }, // Uses default, expecting JSON
            safetySettings: recipeSafetySettings,
        });
        const responseText = response.text();
        console.log(`Raw Recipe Gemini titles-only response: ${responseText.substring(0, 500)}...`);
        const parsedJson = extractJsonFromText(responseText);

        if (parsedJson && Array.isArray(parsedJson.titles)) {
            return parsedJson;
        } else {
            console.error("Recipe Gemini Service (getRecipeTitlesOnly) response was valid JSON but did not contain a 'titles' array.", parsedJson);
            if (typeof responseText === 'string') { // Fallback from original
                const lines = responseText.split('\n').map(line => line.trim().replace(/^- /, '').replace(/^"|"$/g, '').replace(/^'\s*|\s*'$/g, '')).filter(line => !line.startsWith('{') && !line.startsWith('}') && line.length > 2 && line.length < 100);
                if (lines.length > 0 && lines.length <= 5) {
                    console.warn("Falling back to plain text line extraction for titles due to incorrect JSON structure. Lines found:", lines);
                    return { titles: lines };
                }
            }
            throw new Error("AI service response for titles was not in the expected JSON format: {'titles': [...]}.");
        }
    } catch (error) {
        console.error("Error in getRecipeTitlesOnly (Recipe Service):", error.message);
        throw error;
    }
}

async function correctRecipeJson(originalUserQuery, erroneousJsonString, ajvErrors, preferredChefPersonalityKey, chatHistory = []) {
    await recipeServiceModelsInitPromise;
    const chefPreambleString = config.CHEF_PERSONALITY_PROMPTS[preferredChefPersonalityKey] || config.CHEF_PERSONALITY_PROMPTS.standard;
    const systemPromptText = config.DETAILED_RECIPE_JSON_SCHEMA_PROMPT.system;

    let correctionPrompt = `${chefPreambleString}\n\nThe previous attempt to generate a recipe JSON based on the user's request resulted in a JSON object that failed schema validation. Please correct it.`;
    correctionPrompt += `\n\nOriginal User Request Context: "${originalUserQuery}"`;
    correctionPrompt += `\n\nErroneous JSON Output:\n\`\`\`json\n${erroneousJsonString}\n\`\`\``;

    const formattedApiHistory = chatHistory.map(msg => ({
        role: msg.role,
        parts: msg.parts.map(p => ({ text: p.text }))
    })).filter(Boolean);

    const contentsForApi = [
        ...formattedApiHistory,
        { role: "user", parts: [{ text: correctionPrompt }] }
    ];

    console.log(`Recipe Gemini Service (Correct Recipe JSON): Sending ${formattedApiHistory.length} history turns. Using model ${config.GEMINI_MODEL_NAME}.`);

    try {
        const response = await geminiClient.generateContent({
            modelName: config.GEMINI_MODEL_NAME,
            contents: contentsForApi,
            systemInstruction: { parts: [{ text: systemPromptText }] },
            generationConfig: recipeDefaultGenerationConfig,
            safetySettings: recipeSafetySettings,
        });
        
        const responseText = response.text();
        console.log(`Raw Recipe Gemini correct recipe JSON response: ${responseText.substring(0, 500)}...`);
        return extractJsonFromText(responseText);
    } catch (error) {
        console.error("Error in correctRecipeJson (Recipe Service):", error.message);
        throw error;
    }
}

module.exports = {
    getRecipeFromTextChat,
    getRecipeFromImage,
    getRecipeFromPageText,
    getRecipeTitlesOnly,
    correctRecipeJson,
    // buildCurrentUserTurnContextualPrompt, // Only if it needs to be exported, typically a helper
};