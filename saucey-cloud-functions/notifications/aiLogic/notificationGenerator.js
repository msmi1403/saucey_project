// saucey-cloud-functions/notifications/aiLogic/notificationGenerator.js
const geminiClientModule = require("@saucey/shared/services/geminiClient");
const { logger } = require("firebase-functions");
const { notificationConfigs } = require("../config/notificationConfig");
// Import necessary constants from globalConfig
const {
    GEMINI_MODEL_NAME, // This should be gemini-2.0-flash
    GEMINI_TEXT_TEMPERATURE,
    GEMINI_TEXT_MAX_OUTPUT_TOKENS,
    GEMINI_SAFETY_SETTINGS // This should be an array of safety setting objects
} = require("@saucey/shared/config/globalConfig");

// --- Diagnostic Logging for geminiClient ---
logger.info("In notificationGenerator.js: Attempting to log geminiClient module status.");
if (!geminiClientModule) {
    logger.error("CRITICAL ERROR: In notificationGenerator.js, geminiClientModule (the imported module) IS UNDEFINED or NULL!");
} else {
    logger.info("In notificationGenerator.js: geminiClientModule is DEFINED.");
    if (typeof geminiClientModule.generateContent !== 'function') {
        logger.error("CRITICAL ERROR: In notificationGenerator.js, geminiClientModule IS DEFINED, but geminiClientModule.generateContent IS NOT A FUNCTION. Inspecting module. Keys:", Object.keys(geminiClientModule).join(', '));
    } else {
        logger.info("In notificationGenerator.js: geminiClientModule.generateContent IS a function. All good with the expected function.");
    }
}
// --- End Diagnostic Logging ---

// Construct the default generationConfig object to pass to Gemini
// Ensure the constants being used here are actually exported by your globalConfig.js
const defaultGenerationConfig = {
    temperature: GEMINI_TEXT_TEMPERATURE !== undefined ? GEMINI_TEXT_TEMPERATURE : 0.7, // Provide a fallback if undefined
    maxOutputTokens: GEMINI_TEXT_MAX_OUTPUT_TOKENS !== undefined ? GEMINI_TEXT_MAX_OUTPUT_TOKENS : 1024, // Provide a fallback
    // candidateCount: 1, // Often a default in the Gemini SDK itself, or add from globalConfig if needed
    // topP: globalConfig.GEMINI_TOP_P, // Add if you have these in globalConfig
    // topK: globalConfig.GEMINI_TOP_K, // Add if you have these in globalConfig
};

// Default safety settings to pass (ensure GEMINI_SAFETY_SETTINGS is defined and is an array in globalConfig)
const defaultSafetySettings = Array.isArray(GEMINI_SAFETY_SETTINGS) ? GEMINI_SAFETY_SETTINGS : [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
];
if (!Array.isArray(GEMINI_SAFETY_SETTINGS)) {
    logger.warn("GEMINI_SAFETY_SETTINGS from globalConfig was not an array or was undefined. Using hardcoded defaults for safety settings.");
}


/**
 * Parses Gemini output, expecting JSON. Handles potential markdown code block.
 * @param {string} rawOutput - The raw string output from Gemini.
 * @param {string} notificationType - For logging purposes.
 * @returns {Object|null} Parsed JSON object or null on failure.
 */
function parseGeminiJsonOutput(rawOutput, notificationType) {
    if (!rawOutput || typeof rawOutput !== 'string') {
        logger.warn(`Gemini output is null or not a string for ${notificationType}. Output:`, rawOutput);
        return null;
    }
    try {
        const jsonMatch = rawOutput.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch && jsonMatch[1]) {
            return JSON.parse(jsonMatch[1]);
        }
        return JSON.parse(rawOutput);
    } catch (parseError) {
        logger.error(`Failed to parse JSON from Gemini for ${notificationType}: "${rawOutput}"`, parseError);
        return null;
    }
}

/**
 * Generates notification content (title, body, emoji) using Gemini.
 * @param {string} notificationType - The type of notification.
 * @param {Object} userContext - Context about the user.
 * @param {Object} dynamicData - Dynamic data including strategy, recipeName, etc.
 * @returns {Promise<Object|null>} Notification content object or null.
 */
async function generateNotificationContent(notificationType, userContext, dynamicData = {}) {
    const {
        suggestionStrategy = "existingRecipe",
        recipeName,
        recipeIdea,
        remixIdea,
    } = dynamicData;

    logger.log(`Generating final notification content for type: ${notificationType}, strategy: ${suggestionStrategy}, user: ${userContext.userId}`);
    const config = notificationConfigs[notificationType];
    if (!config || !config.isEnabled) {
        logger.warn(`Notification type ${notificationType} not found or disabled in config.`);
        return null;
    }

    const userContextString = `Display Name: ${userContext.displayName}, Prefs: ${JSON.stringify(userContext.preferences)}, Activity: ${JSON.stringify(userContext.activity)}`;
    let storyOrHook = "";
    let promptForFinalNotification;

    try {
        if (!geminiClientModule || typeof geminiClientModule.generateContent !== 'function') {
            logger.error(`Cannot generate notification content: geminiClientModule.generateContent is not available. Strategy: ${suggestionStrategy}`);
            return null;
        }

        switch (suggestionStrategy) {
            case "recipeIdea":
            case "recipeRemix":
            case "surpriseMeRecipeConcept":
                if (!config.aiSystemPromptForIdeaNotificationContent) {
                    logger.warn(`Missing aiSystemPromptForIdeaNotificationContent for ${notificationType} and strategy ${suggestionStrategy}`);
                    return null;
                }
                promptForFinalNotification = config.aiSystemPromptForIdeaNotificationContent
                    .replace(/{RECIPE_IDEA_OR_REMIX}/g, recipeIdea || remixIdea || "a fresh culinary idea")
                    .replace(/{USER_CONTEXT}/g, userContextString);
                break;
            case "existingRecipe":
            default:
                if (config.aiSystemPromptForStory && recipeName) {
                    const storyPrompt = config.aiSystemPromptForStory
                        .replace(/{USER_CONTEXT}/g, userContextString)
                        .replace(/{RECIPE_NAME}/g, recipeName);
                    logger.log(`Prompt for story (type: ${notificationType}): ${storyPrompt.substring(0,100)}...`);
                    const storyResponse = await geminiClientModule.generateContent({
                        contents: [{ parts: [{ text: storyPrompt }] }],
                        modelName: GEMINI_MODEL_NAME,
                        generationConfig: defaultGenerationConfig,
                        safetySettings: defaultSafetySettings
                    });
                    storyOrHook = storyResponse.text();
                    logger.log(`Generated story for existing recipe "${recipeName}": ${storyOrHook}`);
                } else if (recipeName) {
                    storyOrHook = `Check out this recipe: ${recipeName}`;
                    logger.log(`Using basic hook for existing recipe "${recipeName}" as no story prompt configured or recipe name missing for story.`);
                } else {
                     storyOrHook = "Check out this great recipe idea!";
                     logger.log("Using very generic hook as no recipe name provided for existingRecipe strategy.");
                }

                if (!config.aiSystemPromptForNotificationContent) {
                    logger.warn(`Missing aiSystemPromptForNotificationContent for ${notificationType}`);
                    return null;
                }
                promptForFinalNotification = config.aiSystemPromptForNotificationContent
                    .replace(/{STORY_OR_HOOK}/g, storyOrHook)
                    .replace(/{RECIPE_NAME}/g, recipeName || "this recipe")
                    .replace(/{USER_CONTEXT}/g, userContextString)
                    .replace(/{CREATOR_NAME}/g, dynamicData.creatorName || "")
                    .replace(/{MEAL_TYPE}/g, dynamicData.mealType || "");
                break;
        }

        if (!promptForFinalNotification) {
             logger.error(`Could not determine final notification prompt for strategy ${suggestionStrategy}, notification type ${notificationType}.`);
             return null;
        }
        logger.log(`Prompt for final notification (type: ${notificationType}, strategy: ${suggestionStrategy}): ${promptForFinalNotification.substring(0, 200)}...`);

        const finalNotificationResponse = await geminiClientModule.generateContent({
            contents: [{ parts: [{ text: promptForFinalNotification }] }],
            modelName: GEMINI_MODEL_NAME,
            generationConfig: defaultGenerationConfig,
            safetySettings: defaultSafetySettings
        });
        const generatedText = finalNotificationResponse.text();
        logger.log(`Raw Gemini output for final notification content (type: ${notificationType}, strategy: ${suggestionStrategy}): ${generatedText}`);
        const parsedContent = parseGeminiJsonOutput(generatedText, notificationType);

        if (parsedContent?.title && parsedContent.body) {
            return {
                title: parsedContent.title,
                body: parsedContent.body,
                emoji: parsedContent.emoji || config.defaultContent.emoji,
            };
        } else {
            logger.warn(`Gemini did not return valid JSON structure for final notification. Output: ${generatedText}. Falling back to default content for ${notificationType}.`);
            return {
                title: (config.defaultContent.title || "New Suggestion").replace("{RECIPE_NAME}", recipeName || "an idea"),
                body: (config.defaultContent.body || "Check this out!").replace("{RECIPE_NAME}", recipeName || "an idea"),
                emoji: config.defaultContent.emoji || "💡",
            };
        }
    } catch (error) {
        logger.error(`Error in generateNotificationContent for ${notificationType} (strategy: ${suggestionStrategy}):`, error);
        logger.warn(`Falling back to default content for ${notificationType} due to error.`);
        return {
            title: (config.defaultContent.title || "New Suggestion").replace("{RECIPE_NAME}", recipeName || "something new"),
            body: (config.defaultContent.body || "We found something you might like!").replace("{RECIPE_NAME}", recipeName || "something new"),
            emoji: config.defaultContent.emoji || "✨",
        };
    }
}

/**
 * Generates a recipe idea or concept using AI.
 * @param {string} notificationType - The type of notification.
 * @param {Object} userContext - Context about the user.
 * @param {'idea' | 'remix' | 'surprise'} conceptType - Type of concept to generate.
 * @param {string} [existingRecipeName] - Optional name of an existing recipe for remixing.
 * @returns {Promise<string|null>} The generated recipe idea/remix string, or null.
 */
async function generateRecipeConcept(notificationType, userContext, conceptType, existingRecipeName = null) {
    logger.log(`Generating recipe concept. Type: ${conceptType}, NotificationType: ${notificationType}, User: ${userContext.userId}, ExistingRecipe: ${existingRecipeName || 'N/A'}`);
    const config = notificationConfigs[notificationType];
    if (!config) {
        logger.warn(`No config found for notificationType '${notificationType}' in generateRecipeConcept.`);
        return null;
    }

    if (!geminiClientModule || typeof geminiClientModule.generateContent !== 'function') {
        logger.error(`Cannot generate recipe concept: geminiClientModule.generateContent is not available. ConceptType: ${conceptType}`);
        return null;
    }

    let systemPromptKey;
    switch (conceptType) {
        case 'idea':
            systemPromptKey = 'aiSystemPromptForRecipeIdea';
            break;
        case 'remix':
            systemPromptKey = 'aiSystemPromptForRecipeRemix';
            break;
        case 'surprise':
            systemPromptKey = config.aiSystemPromptForSurpriseConcept || config.aiSystemPromptForRecipeIdea;
            if (!config.aiSystemPromptForSurpriseConcept && config.aiSystemPromptForRecipeIdea) {
                logger.info(`Using 'aiSystemPromptForRecipeIdea' as fallback for 'surprise' conceptType for ${notificationType}.`);
            }
            break;
        default:
            logger.warn(`Unknown conceptType '${conceptType}' requested.`);
            return null;
    }

    let systemPrompt = config[systemPromptKey];
    if (!systemPrompt || typeof systemPrompt !== 'string') {
        logger.warn(`Missing or invalid AI system prompt for key '${systemPromptKey}' (conceptType '${conceptType}') in notificationType '${notificationType}'.`);
        return null;
    }

    const userContextString = `Display Name: ${userContext.displayName}, Prefs: ${JSON.stringify(userContext.preferences)}, Activity: ${JSON.stringify(userContext.activity)}`;
    let fullPrompt = systemPrompt.replace(/{USER_CONTEXT}/g, userContextString);

    if (conceptType === 'remix' && existingRecipeName) {
        fullPrompt = fullPrompt.replace(/{EXISTING_RECIPE_NAME}/g, existingRecipeName);
    } else if (conceptType === 'remix' && !existingRecipeName) {
        logger.warn("Cannot generate remix concept without an existingRecipeName.");
        return null;
    }
    logger.log(`Prompt for recipe concept (type: ${conceptType}): ${fullPrompt.substring(0, 200)}...`);

    try {
        // Pass prompt, modelName, generationConfig, and safetySettings
            const response = await geminiClientModule.generateContent({
                contents: [{ parts: [{ text: fullPrompt }] }], // Structure 'contents' as the SDK expects
                modelName: GEMINI_MODEL_NAME,
                generationConfig: defaultGenerationConfig,
                safetySettings: defaultSafetySettings
                // systemInstruction can be added here if needed for this call
            });
            const ideaText = response.text();

        if (!ideaText || ideaText.trim() === "") {
            logger.warn(`Gemini returned empty or null for recipe concept (type: ${conceptType}). Prompt: ${fullPrompt.substring(0,100)}`);
            return null;
        }
        logger.log(`Generated recipe concept (type: ${conceptType}): "${ideaText.trim()}"`);
        return ideaText.trim();
    } catch (error) {
        logger.error(`Error calling Gemini for recipe concept (type: ${conceptType}):`, error);
        return null;
    }
}

/**
 * Generates a textual insight (e.g., focus suggestion) using Gemini.
 * @param {string} promptTemplateName - The key of the prompt template in notificationConfigs (e.g., 'aiSystemPromptForNextWeekFocus').
 * @param {Object} userContext - Context about the user.
 * @param {Object} dynamicStrings - An object containing dynamic strings to replace in the prompt (e.g., {PAST_WEEK_COOKING_SUMMARY: "..."}).
 * @returns {Promise<string|null>} The generated text string or null on failure.
 */
async function generateTextualInsight(promptTemplateName, userContext, dynamicStrings = {}) {
    const notificationType = "weeklyCookingRecap"; // This function is specific to weekly recap for now
    const config = notificationConfigs[notificationType];

    if (!config || !config.isEnabled) {
        logger.warn(`Notification type ${notificationType} not found or disabled for generating textual insight.`);
        return null;
    }

    const systemPromptTemplate = config[promptTemplateName];
    if (!systemPromptTemplate || typeof systemPromptTemplate !== 'string') {
        logger.warn(`Missing or invalid AI system prompt for key '${promptTemplateName}' in notificationType '${notificationType}'.`);
        return null;
    }

    if (!geminiClientModule || typeof geminiClientModule.generateContent !== 'function') {
        logger.error(`Cannot generate textual insight: geminiClientModule.generateContent is not available. Prompt template: ${promptTemplateName}`);
        return null;
    }

    let populatedPrompt = systemPromptTemplate;
    // Replace user context placeholders
    populatedPrompt = populatedPrompt.replace(/{USER_CONTEXT_PREFERENCES}/g, JSON.stringify(userContext.preferences));
    populatedPrompt = populatedPrompt.replace(/{USER_DISPLAY_NAME}/g, userContext.displayName);
    // Replace dynamic string placeholders
    for (const key in dynamicStrings) {
        if (Object.hasOwnProperty.call(dynamicStrings, key)) {
            populatedPrompt = populatedPrompt.replace(new RegExp(`{${key}}`, 'g'), dynamicStrings[key]);
        }
    }

    logger.log(`Prompt for textual insight ('${promptTemplateName}' for ${notificationType}): ${populatedPrompt.substring(0, 200)}...`);

    try {
        const response = await geminiClientModule.generateContent({
            contents: [{ parts: [{ text: populatedPrompt }] }],
            modelName: GEMINI_MODEL_NAME,
            generationConfig: defaultGenerationConfig,
            safetySettings: defaultSafetySettings
        });
        const generatedText = response.text();
        logger.log(`Generated textual insight for '${promptTemplateName}': "${generatedText ? generatedText.substring(0, 150) + (generatedText.length > 150 ? "..." : "") : "null"}"`);
        return generatedText;
    } catch (error) {
        logger.error(`Error generating textual insight with prompt '${promptTemplateName}' for ${notificationType}:`, error);
        return null;
    }
}

/**
 * Generates the full content for a weekly recap notification.
 * @param {Object} userContext - Context about the user, including preferredChefPersonality.
 * @param {string} weeklySummaryString - A summary of the user's cooking activity for the past week.
 * @param {string} nextWeekFocusString - The AI-generated focus suggestion for the next week.
 * @returns {Promise<Object|null>} Structured notification content (title, body, emoji) or null on failure.
 */
async function generateRecapNotificationInternal(userContext, weeklySummaryString, nextWeekFocusString) {
    const notificationType = "weeklyCookingRecap";
    const config = notificationConfigs[notificationType];

    if (!config || !config.isEnabled) {
        logger.warn(`Notification type ${notificationType} not found or disabled for generating recap.`);
        return null;
    }

    if (!geminiClientModule || typeof geminiClientModule.generateContent !== 'function') {
        logger.error(`Cannot generate recap notification: geminiClientModule.generateContent is not available.`);
        return null;
    }

    const preferredChefPersonality = userContext.preferences?.preferredChefPersonality || "Helpful Chef";
    const displayName = userContext.displayName || "Foodie";
    const userPreferencesString = JSON.stringify(userContext.preferences);

    // Step 1: Generate Recap Story
    const storyPromptTemplate = config.aiSystemPromptForWeeklyRecapStory;
    if (!storyPromptTemplate) {
        logger.warn(`Missing 'aiSystemPromptForWeeklyRecapStory' for ${notificationType}.`);
        return null;
    }

    const storyPrompt = storyPromptTemplate
        .replace(/{USER_PREFERRED_CHEF_PERSONALITY}/g, preferredChefPersonality)
        .replace(/{USER_DISPLAY_NAME}/g, displayName)
        .replace(/{USER_CONTEXT_PREFERENCES}/g, userPreferencesString)
        .replace(/{WEEKLY_COOKING_SUMMARY}/g, weeklySummaryString)
        .replace(/{NEXT_WEEK_FOCUS_SUGGESTION}/g, nextWeekFocusString);

    logger.log(`Prompt for weekly recap story (${notificationType}): ${storyPrompt.substring(0, 200)}...`);
    let recapStory;
    try {
        const storyResponse = await geminiClientModule.generateContent({
            contents: [{ parts: [{ text: storyPrompt }] }],
            modelName: GEMINI_MODEL_NAME,
            generationConfig: defaultGenerationConfig,
            safetySettings: defaultSafetySettings
        });
        recapStory = storyResponse.text();
        if (!recapStory) {
            logger.warn(`Gemini returned empty story for weekly recap. User: ${userContext.userId}.`);
            return null; // Or fallback to a default story structure
        }
        logger.log(`Generated weekly recap story for user ${userContext.userId}: "${recapStory}"`);
    } catch (error) {
        logger.error(`Error generating weekly recap story for user ${userContext.userId}:`, error);
        return null; // Or fallback
    }

    // Step 2: Generate Final Notification Content from Story
    const finalNotificationPromptTemplate = config.aiSystemPromptForWeeklyRecapNotificationContent;
    if (!finalNotificationPromptTemplate) {
        logger.warn(`Missing 'aiSystemPromptForWeeklyRecapNotificationContent' for ${notificationType}.`);
        return null;
    }

    const finalNotificationPrompt = finalNotificationPromptTemplate.replace(/{RECAP_STORY}/g, recapStory);
    logger.log(`Prompt for final recap notification content (${notificationType}): ${finalNotificationPrompt.substring(0, 200)}...`);

    try {
        const finalResponse = await geminiClientModule.generateContent({
            contents: [{ parts: [{ text: finalNotificationPrompt }] }],
            modelName: GEMINI_MODEL_NAME,
            generationConfig: defaultGenerationConfig,
            safetySettings: defaultSafetySettings
        });
        const generatedText = finalResponse.text();
        logger.log(`Raw Gemini output for final recap notification content (${notificationType}): ${generatedText}`);
        const parsedContent = parseGeminiJsonOutput(generatedText, notificationType);

        if (parsedContent?.title && parsedContent.body) {
            return {
                title: parsedContent.title,
                body: parsedContent.body,
                emoji: parsedContent.emoji || config.defaultContent.emoji,
            };
        } else {
            logger.warn(`Gemini did not return valid JSON for final recap notification. Output: ${generatedText}. User: ${userContext.userId}. Falling back to default content.`);
            return { ...config.defaultContent };
        }
    } catch (error) {
        logger.error(`Error generating final recap notification content for user ${userContext.userId}:`, error);
        return { ...config.defaultContent }; // Fallback to default on error
    }
}

module.exports = {
    generateNotificationContent,
    generateRecipeConcept,
    generateTextualInsight,
    generateRecapNotificationInternal,
};