// saucey-cloud-functions/handleRecipeChatTurn/services/geminiService.js

const geminiClient = require('@saucey/shared/services/geminiClient.js'); 
const { extractJsonFromText } = require('@saucey/shared/utils/commonUtils.js'); 

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
const modelsInitializationPromise = Promise.all([
    geminiClient.getModel(config.GEMINI_MODEL_NAME).catch(e => { console.error(`Failed to init recipe text model ${config.GEMINI_MODEL_NAME}: ${e.message}`); throw e; }),
    geminiClient.getModel(config.GEMINI_VISION_MODEL_NAME).catch(e => { console.error(`Failed to init recipe vision model ${config.GEMINI_VISION_MODEL_NAME}: ${e.message}`); throw e; })
]).catch(error => {
    console.error("FATAL: Recipe Gemini Service: Initialization of specific models from shared client failed during module load:", error.message);
    // This error will propagate and cause function calls to fail if models aren't available.
});


// This function remains specific to handleRecipeChatTurn's context building
function buildCurrentUserTurnContextualPrompt(userQuery, currentRecipeJsonString, userPreferences, chefPreamble) {
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


async function getRecipeFromTextChat(userQuery, currentRecipeJsonString, userPreferences, chatHistory = [], chefPreambleString = config.CHEF_PERSONALITY_PROMPTS.standard) {
    await modelsInitializationPromise;

    const currentUserTurnPromptText = buildCurrentUserTurnContextualPrompt(userQuery, currentRecipeJsonString, userPreferences, chefPreambleString);
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
    await modelsInitializationPromise;

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
        { inlineData: { mimeType: imageMimeType, data: imageDataBase64 } }
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
    await modelsInitializationPromise;
    const systemPromptText = config.DETAILED_RECIPE_JSON_SCHEMA_PROMPT.system;
    const standardChefPreamble = config.CHEF_PERSONALITY_PROMPTS.standard || "You are a helpful, expert, and friendly cooking assistant.";
    let personalityInstruction = "";
     if (chefPreambleString && chefPreambleString.trim() !== "" && chefPreambleString !== standardChefPreamble) {
      personalityInstruction = chefPreambleString + "\n\nNow, considering the extracted page content and user's instructions:\n";
    } else if (standardChefPreamble.trim() !== "") {
        personalityInstruction = standardChefPreamble + "\n\nNow, considering the extracted page content and user's instructions:\n";
    }

    let userTurnText = `${personalityInstruction}The following text was extracted from a webpage (${sourceUrl || 'unknown source'}). Please extract the recipe details from it and structure it as a recipe JSON object according to the schema provided in the system instructions. Prioritize accuracy and completeness based on the provided text.\n\nExtracted Page Content:\n"""\n${pageTextContent.substring(0, 15000)}\n"""\n`;
    if (userInstructions && userInstructions.trim() !== "") {
        userTurnText += `\n\nApply the following user modifications/instructions to the extracted recipe: "${userInstructions}"`;
    }
    userTurnText += `\n\nRemember to generate a new "recipeId" for this imported recipe. After you output the JSON, re-print it in a fenced code block and append on a new line: "✅ VALID JSON" if it strictly conforms to the schema, or "❌ INVALID JSON" otherwise.`;

    console.log(`Recipe Gemini Service (Page Text): Processing. Using model ${config.GEMINI_MODEL_NAME}.`);
    try {
        const response = await geminiClient.generateContent({
            modelName: config.GEMINI_MODEL_NAME,
            contents: [{ role: "user", parts: [{ text: userTurnText }] }],
            systemInstruction: { parts: [{ text: systemPromptText }] },
            generationConfig: recipeDefaultGenerationConfig,
            safetySettings: recipeSafetySettings,
        });
        const responseText = response.text();
        console.log(`Raw Recipe Gemini page text response: ${responseText.substring(0, 500)}...`);
        return extractJsonFromText(responseText);
    } catch (error) {
        console.error(`Error in getRecipeFromPageText for URL ${sourceUrl} (Recipe Service):`, error.message);
        throw error;
    }
}

async function getRecipeTitlesOnly(userQuery, chefPreambleString = config.CHEF_PERSONALITY_PROMPTS.standard) {
    await modelsInitializationPromise;
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
    await modelsInitializationPromise;
    const chefPreambleString = config.CHEF_PERSONALITY_PROMPTS[preferredChefPersonalityKey] || config.CHEF_PERSONALITY_PROMPTS.standard;
    const systemPromptText = config.DETAILED_RECIPE_JSON_SCHEMA_PROMPT.system;

    let correctionPrompt = `${chefPreambleString}\n\nThe previous attempt to generate a recipe JSON based on the user's request resulted in a JSON object that failed schema validation. Please correct it.`;
    correctionPrompt += `\n\nOriginal User Request Context: "${originalUserQuery}"`;
    correctionPrompt += `\n\nErroneous JSON Output:\n\`\`\`json\n${erroneousJsonString}\n\`\`\``;
    correctionPrompt += `\n\nValidation Errors (from Ajv):\n\`\`\`json\n${JSON.stringify(ajvErrors, null, 2)}\n\`\`\``;
    correctionPrompt += `\n\nPlease analyze the errors and the original JSON. Your task is to fix the JSON so that it strictly conforms to the schema provided in the main system instructions and accurately reflects the original user request. Ensure all data types and structures are correct as per the schema. Maintain the original intent and data as much as possible, only making changes necessary to fix the validation errors and ensure schema compliance.`;
    correctionPrompt += `\n\nOutput ONLY the corrected, complete, and valid JSON object. Do not include any other commentary, apologies, or introductory text.`;
    correctionPrompt += `\nAfter you output the corrected JSON, re-print that JSON in a fenced code block and append on a new line: "✅ VALID JSON" if it strictly conforms to the schema, or "❌ INVALID JSON" otherwise.`;

    const formattedApiHistory = chatHistory.map(msg => ({
        role: msg.role, parts: msg.parts.map(p => ({ text: p.text }))
    })).filter(Boolean);
    const contentsForApi = [
        ...formattedApiHistory,
        { role: "user", parts: [{ text: correctionPrompt }] }
    ];

    console.log(`Recipe Gemini Service (JSON Correction): Processing. Using model ${config.GEMINI_MODEL_NAME}.`);
    try {
        const response = await geminiClient.generateContent({
            modelName: config.GEMINI_MODEL_NAME,
            contents: contentsForApi,
            systemInstruction: { parts: [{ text: systemPromptText }] },
            generationConfig: recipeDefaultGenerationConfig,
            safetySettings: recipeSafetySettings,
        });
        const responseText = response.text();
        console.log(`Raw Recipe Gemini correction response: ${responseText.substring(0, 500)}...`);
        return extractJsonFromText(responseText);
    } catch (error) {
        console.error("Error in correctRecipeJson (Recipe Service):", error.message);
        throw error;
    }
}

async function getInstructionsFromRecipeJson(recipeJsonString, userFollowUpPrompt = "") {
    await modelsInitializationPromise;
    let promptText = `Here is a recipe in JSON format:\n\n\`\`\`json\n${recipeJsonString}\n\`\`\``;
    const followUpText = userFollowUpPrompt || "";

    if (followUpText.trim() !== "") {
        promptText += `\n\nUser request regarding these instructions: "${followUpText.trim()}"`;
    }
    promptText += `\n\nPlease provide clear, step-by-step cooking instructions suitable for a home cook based on this recipe and the user's request (if any).\nRespond with ONLY the cooking instructions as plain text. Do not include any preamble, introduction, or the original JSON. Just the instructions.`;

    const instructionsGenConfig = {
        temperature: config.GEMINI_TEXT_TEMPERATURE || 0.5,
        maxOutputTokens: config.GEMINI_TEXT_MAX_OUTPUT_TOKENS || 2048,
        // No responseMimeType: "application/json" here, as we expect plain text
    };

    console.log(`Recipe Gemini Service (Instructions): Processing. Using model ${config.GEMINI_MODEL_NAME}.`);
    try {
        const response = await geminiClient.generateContent({
            modelName: config.GEMINI_MODEL_NAME,
            contents: [{ role: "user", parts: [{ text: promptText }] }],
            generationConfig: instructionsGenConfig,
            safetySettings: recipeSafetySettings,
        });
        const responseText = response.text();
        console.log(`Raw Recipe Gemini text response (instructions): ${responseText.substring(0, 500)}...`);
        return responseText; // Expecting plain text
    } catch (error) {
        console.error("Error in getInstructionsFromRecipeJson (Recipe Service):", error.message);
        throw error;
    }
}

module.exports = {
    getRecipeFromTextChat,
    getRecipeFromImage,
    getRecipeFromPageText,
    getInstructionsFromRecipeJson,
    getRecipeTitlesOnly,
    correctRecipeJson,
};