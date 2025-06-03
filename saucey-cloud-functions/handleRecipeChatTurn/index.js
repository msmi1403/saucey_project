// /handleRecipeChatTurn/index.js

const { logger } = require("firebase-functions/v2");
const { onRequest } = require("firebase-functions/v2/https"); // Gen 2 HTTP import
const config = require('./config');
const { authenticateFirebaseToken } = require('@saucey/shared/middleware/authMiddleware.js');

// Note: The './recipeUtils' path suggests generateUniqueId might be local to this package,
// or it's an alias. If it's from '@saucey/shared', the path should reflect that.
// However, based on the file structure, it seems generateUniqueId is defined locally in recipeUtils.js
// and recipeUtils.js also imports from '@saucey/shared/utils/commonUtils.js'.
const { generateUniqueId } = require('./recipeUtils');
const textProcessor = require('./processors/textProcessor');
const imageProcessor = require('./processors/imageProcessor');
const urlProcessor = require('./processors/urlProcessor');
const firestoreService = require('./services/firestoreService');
const { FieldValue } = require('@google-cloud/firestore');
const geminiService = require('./services/geminiService'); // ADDED: for correction call

// --- AJV SETUP ---
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const recipeJsonSchema = require('./prompts/recipeJsonSchema');

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validateRecipe = ajv.compile(recipeJsonSchema);
// --- END AJV SETUP ---

// Define the actual function logic
const handleRecipeChatTurnLogic = async (req, res) => {
    res.set('Access-Control-Allow-Origin', config.CORS_HEADERS['Access-Control-Allow-Origin']);
    res.set('Access-Control-Allow-Methods', config.CORS_HEADERS['Access-Control-Allow-Methods']);
    res.set('Access-Control-Allow-Headers', config.CORS_HEADERS['Access-Control-Allow-Headers']);
    res.set('Access-Control-Max-Age', config.CORS_HEADERS['Access-Control-Max-Age']);

    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    try {
        await new Promise((resolve, reject) => {
            authenticateFirebaseToken(req, res, (err) => {
                if (err) {
                    logger.warn("Auth middleware indicated error or sent response.", { error: err ? err.message : "Unknown auth error" });
                    return reject(new Error('Auth failed and response likely sent.'));
                }
                if (!req.userId) {
                    logger.error('CRITICAL: Auth middleware completed without error but userId not set.');
                    // Middleware should send the response in this case.
                    // If not, uncommenting the line below might be necessary, but ideally middleware handles it.
                    // res.status(500).json({ error: 'Internal authentication configuration error.', status: 'error' });
                    return reject(new Error('Auth succeeded but userId missing.'));
                }
                resolve();
            });
        });
    } catch (authError){
        logger.warn("Authentication promise rejected, likely response already sent by middleware:", { errorMessage: authError.message });
        if (!res.headersSent) { // Fallback if middleware failed to send a response
            res.status(401).json({ error: 'Authentication failed.', status: 'error'});
        }
        return;
    }

    const userId = req.userId;
    const {
        userPrompt, currentRecipeJSON, imageDataBase64, imageMimeType,
        sourceUrl, responseType, chatId, preferredChefPersonalityKey
    } = req.body;

    if (!chatId && (userPrompt || imageDataBase64 || sourceUrl)) {
        logger.error(`Request for user ${userId} missing chatId for an active prompt.`, { userId, hasUserPrompt: !!userPrompt, hasImage: !!imageDataBase64, hasSourceUrl: !!sourceUrl });
        return res.status(400).json({ error: 'ChatId is required for the conversation.', status: 'error' });
    }
    if (!userPrompt && !imageDataBase64 && !sourceUrl) {
        logger.warn(`No input provided for user ${userId}.`, { userId });
        return res.status(400).json({ error: 'No input provided (userPrompt, imageDataBase64, or sourceUrl is required).', status: 'error' });
    }

    logger.info(`Request received for user ${userId}, chatId: ${chatId || 'N/A'}`, {
        userId,
        chatId: chatId || "N/A",
        promptLength: userPrompt ? userPrompt.length : 0,
        hasImage: !!imageDataBase64,
        hasUrl: !!sourceUrl,
        responseType: responseType || 'default',
        personalityKey: preferredChefPersonalityKey || 'default'
    });

    let chatHistory = [];
    if (userId && chatId) {
        try {
            chatHistory = await firestoreService.getChatHistory(userId, chatId, 10);
            logger.info(`Fetched ${chatHistory.length} messages for chat history.`, { userId, chatId });
        } catch (historyError) {
            logger.warn(`Could not fetch chat history for ${chatId}: ${historyError.message}. Proceeding without history.`, { userId, chatId, error: historyError.message });
        }
    }

    let userMessageForHistory;
    if (userPrompt) {
        userMessageForHistory = { role: "user", parts: [{ text: userPrompt }], timestamp: FieldValue.serverTimestamp() };
    } else if (imageDataBase64) {
        userMessageForHistory = { role: "user", parts: [{ text: "[User uploaded an image]" }], timestamp: FieldValue.serverTimestamp() };
    } else if (sourceUrl) {
        userMessageForHistory = { role: "user", parts: [{ text: `[User provided URL: ${sourceUrl}]` }], timestamp: FieldValue.serverTimestamp() };
    }

    if (userId && chatId && userMessageForHistory) {
        try {
            await firestoreService.saveChatMessage(userId, chatId, userMessageForHistory);
        } catch (saveError) {
            logger.warn(`Failed to save user's current message to history (chatId: ${chatId}): ${saveError.message}`, { userId, chatId, error: saveError.message });
        }
    }

    let processingResult;
    let finalRecipeToSave = null;
    let recipeIdForResponse = null;
    // let isNewRecipeCreation = false; // Declared but not explicitly used for response logic, though logged.

    try {
        if (sourceUrl) {
            processingResult = await urlProcessor.processUrlInput(sourceUrl, userPrompt, userId, preferredChefPersonalityKey);
        } else if (imageDataBase64) {
            processingResult = await imageProcessor.processImageInput(
                imageDataBase64, imageMimeType, userPrompt, userId, currentRecipeJSON, preferredChefPersonalityKey
            );
        } else if (userPrompt) {
            processingResult = await textProcessor.processTextualInteraction(
                userPrompt, currentRecipeJSON, userId, responseType, chatHistory, preferredChefPersonalityKey
            );
        } else { // Should be caught by earlier check, but as a safeguard
            if (!res.headersSent) res.status(400).json({ error: 'Invalid request: No actionable input.', status: 'error' });
            return;
        }

        if (processingResult.recipe && processingResult.requiresSaving) {
            let recipeToValidate = processingResult.recipe;
            let isValidRecipe = validateRecipe(recipeToValidate);

            if (!isValidRecipe) {
                logger.warn('Initial AJV Validation Failed for recipe.', { recipeId: recipeToValidate.recipeId, errors: JSON.stringify(validateRecipe.errors, null, 2), userId });
                try {
                    const originalUserContext = userPrompt || (sourceUrl ? `Content from URL: ${sourceUrl}` : "Image input provided");
                    const correctedRecipeObject = await geminiService.correctRecipeJson(
                        originalUserContext, JSON.stringify(recipeToValidate),
                        validateRecipe.errors, preferredChefPersonalityKey, chatHistory
                    );
                    recipeToValidate = correctedRecipeObject;
                    isValidRecipe = validateRecipe(recipeToValidate);
                    if (!isValidRecipe) {
                        logger.error('AJV Validation Failed EVEN AFTER LLM Correction.', { recipeId: recipeToValidate.recipeId, errors: JSON.stringify(validateRecipe.errors, null, 2), userId });
                        if (!res.headersSent) res.status(500).json({ error: "Generated recipe failed schema validation even after correction attempt.", details: validateRecipe.errors, status: 'error'});
                        return;
                    }
                    logger.info('AJV Validation Passed after LLM correction for recipe.', { recipeId: recipeToValidate.recipeId, userId });
                    processingResult.recipe = recipeToValidate; // Ensure processingResult is updated
                } catch (correctionError) {
                    logger.error(`Error during LLM correction attempt:`, { error: correctionError.message, stack: correctionError.stack, userId });
                    if (!res.headersSent) res.status(500).json({ error: "Recipe validation failed and the correction attempt also failed.", details: correctionError.message, status: 'error'});
                    return;
                }
            } else if (processingResult.recipe) { // Ensure recipe exists before logging pass
                logger.info('Initial AJV Validation Passed for recipe.', { recipeId: recipeToValidate.recipeId || 'new recipe', userId });
            }

            finalRecipeToSave = processingResult.recipe;
            recipeIdForResponse = finalRecipeToSave.recipeId || generateUniqueId(); // Ensure ID exists
            finalRecipeToSave.recipeId = recipeIdForResponse; // Standardize ID in the object to save

            await firestoreService.saveOrUpdateUserRecipe(userId, finalRecipeToSave);
            logger.info(`Recipe ${recipeIdForResponse} saved to Firestore.`, { userId, recipeId: recipeIdForResponse });
            // isNewRecipeCreation = processingResult.isNewRecipe || !currentRecipeJSON; // More robust check for new
            logger.info(`Recipe ID: ${recipeIdForResponse} for user ${userId}. New: ${processingResult.isNewRecipe || !currentRecipeJSON}`, { userId, recipeId: recipeIdForResponse, isNew: (processingResult.isNewRecipe || !currentRecipeJSON) });
        }


        if (userId && chatId && processingResult && !processingResult.error) {
            let llmMessageForHistory;
            if (processingResult.recipe) {
                llmMessageForHistory = { role: "model", parts: [{ text: JSON.stringify(processingResult.recipe) }], timestamp: FieldValue.serverTimestamp() };
            } else if (processingResult.titles) {
                llmMessageForHistory = { role: "model", parts: [{ text: `Suggested titles: ${processingResult.titles.join(", ")}` }], timestamp: FieldValue.serverTimestamp() };
            } else if (processingResult.conversationalText) {
                llmMessageForHistory = { role: "model", parts: [{ text: processingResult.conversationalText }], timestamp: FieldValue.serverTimestamp() };
            }
            if (llmMessageForHistory) {
                await firestoreService.saveChatMessage(userId, chatId, llmMessageForHistory);
            }
        }

        if (processingResult.error) {
            if (!res.headersSent) res.status(400).json({ error: processingResult.error, status: 'error' });
        } else if (processingResult.recipe) {
            if (!res.headersSent) res.status(200).json({ recipe: processingResult.recipe, recipeId: recipeIdForResponse, status: 'success' });
        } else if (processingResult.titles) {
            if (!res.headersSent) res.status(200).json({ titles: processingResult.titles, status: 'success' });
        } else if (processingResult.conversationalText) {
            if (!res.headersSent) res.status(200).json({ conversationalText: processingResult.conversationalText, currentRecipeJSON, status: 'success'});
        } else {
            if (!res.headersSent) res.status(500).json({ error: 'Unknown processing outcome.', status: 'error' });
        }

    } catch (error) {
        logger.error('Critical Error in handleRecipeChatTurn processing pipeline:', { errorMessage: error.message, stack: error.stack, userId });
        if (!res.headersSent) {
            res.status(500).json({ error: `Internal server error: ${error.message}`, status: 'error' });
        }
    }
};

// Register with Functions Framework
// functions.http('handleRecipeChatTurn', handleRecipeChatTurnLogic);

// Export for Firebase Functions (root index.js expects this structure for HTTP functions)
// The root index.js will wrap this with functions.https.onRequest if it follows typical patterns,
// or this file itself should define it if it's a Gen 2 HTTP function.
// Given the existing pattern in root index.js: handleRecipeChat: handleRecipeChatTurnFns.handleRecipeChat,
// this export is correct. The root index.js is responsible for how it's deployed.

// For Firebase, the actual HTTP trigger is usually defined when exporting, or in the root index.js.
// If this is intended to be a Firebase HTTP function (Gen1 or Gen2 onRequest):
// Option 1 (Gen1 style, if root index.js doesn't wrap it):
// exports.handleRecipeChat = firebaseFunctions.https.onRequest(handleRecipeChatTurnLogic);
// Option 2 (Gen2 style, if this file defines the full function for deployment):
// const {onRequest} = require("firebase-functions/v2/https");
// exports.handleRecipeChat = onRequest(handleRecipeChatTurnLogic);
// For now, I will keep the export as is, assuming root index.js handles the Firebase wrapper.

// Gen 2 Export Style
exports.handleRecipeChat = onRequest(
    {
        region: config.REGION, // Example, ensure these are in your config.js
        memory: config.MEMORY, // Example
        timeoutSeconds: config.TIMEOUT_SECONDS, // Example
        minInstances: config.MIN_INSTANCES, // Example
        // secrets: [config.GEMINI_API_KEY_SECRET_ID], // If using secrets directly in v2 options
    },
    handleRecipeChatTurnLogic
);