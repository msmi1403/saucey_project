const functions = require('firebase-functions');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const geminiClient = require('@saucey/shared/services/geminiClient.js');
const { logger } = require("firebase-functions/v2");
const config = require('./config');

// Initialize Firebase if not already done
if (!process.env.FIREBASE_CONFIG) {
    initializeApp();
}
const db = getFirestore();

// Import the sophisticated service instead of reimplementing
const geminiService = require('./services/geminiService');

// Simple function logic
const handleRecipeChatTurnLogic = async (request) => {
    // Authentication check
    if (!request.auth) {
        logger.warn('handleRecipeChatTurn: Unauthenticated access attempt.');
        throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }

    const userId = request.auth.uid;
    const {
        userPrompt, 
        chatId, 
        preferredChefPersonalityKey,
        imageDataBase64,
        imageMimeType,
        sourceUrl,
        responseType,
        currentRecipeJSON,
        recipeName
    } = request.data;

    // Basic validation
    if (!userPrompt && !imageDataBase64 && !sourceUrl) {
        throw new HttpsError('invalid-argument', 'userPrompt, imageDataBase64, or sourceUrl is required');
    }
    if (!chatId) {
        throw new HttpsError('invalid-argument', 'chatId is required');
    }

    try {
        // Removed special response type handling - users can ask naturally for what they want

        // Get data we need
        const [chatHistory, userPreferences] = await Promise.all([
            getChatHistory(userId, chatId),
            getUserPreferences(userId)
        ]);

        // Get ingredient context separately to isolate any errors
        let ingredientContext = "";
        try {
            ingredientContext = await getIngredientContext(userId);
        } catch (error) {
            logger.error('Failed to get ingredient context, continuing without it:', { error: error.message, userId });
        }

        // Debug logging
        logger.info('User preferences fetched:', { userId, userPreferences });
        logger.info('Ingredient context fetched:', { userId, ingredientContext: ingredientContext ? 'present' : 'empty' });

        // Get chef preamble from config, following same pattern as geminiService
        // Handle key mapping: client may send different keys than config expects
        const chefPreamble = config.CHEF_PERSONALITY_PROMPTS[preferredChefPersonalityKey] || 
                           config.CHEF_PERSONALITY_PROMPTS["Helpful Chef"] || 
                           "You are a helpful, expert, and friendly cooking assistant.";

        let result;
        let userMessageForHistory;

        // Handle different input types with our simplified approach
        if (imageDataBase64) {
            userMessageForHistory = { 
                role: "user", 
                parts: [{ text: "[User uploaded an image]" }], 
                timestamp: FieldValue.serverTimestamp() 
            };
            // Use unified chat response for image processing
            result = await geminiService.getUnifiedChatResponse({
                userQuery: userPrompt,
                currentRecipeJsonString: currentRecipeJSON,
                userPreferences: userPreferences,
                chatHistory: chatHistory,
                chefPreambleString: chefPreamble,
                ingredientContext: ingredientContext,
                imageDataBase64: imageDataBase64,
                imageMimeType: imageMimeType
            });
        } else if (sourceUrl) {
            userMessageForHistory = { 
                role: "user", 
                parts: [{ text: `[User provided URL: ${sourceUrl}]` }], 
                timestamp: FieldValue.serverTimestamp() 
            };
            // Use unified chat response for URL processing
            result = await geminiService.getUnifiedChatResponse({
                userQuery: userPrompt || "Please help me with this recipe content",
                currentRecipeJsonString: currentRecipeJSON,
                userPreferences: userPreferences,
                chatHistory: chatHistory,
                chefPreambleString: chefPreamble,
                ingredientContext: ingredientContext,
                scrapedPageContent: `URL content would go here: ${sourceUrl}`, // TODO: Implement actual URL fetching
                sourceUrl: sourceUrl
            });
        } else {
            userMessageForHistory = { 
                role: "user", 
                parts: [{ text: userPrompt }], 
                timestamp: FieldValue.serverTimestamp() 
            };
            
            // Use our new unified conversation handler
            result = await geminiService.getUnifiedChatResponse({
                userQuery: userPrompt,
                currentRecipeJsonString: currentRecipeJSON,
                userPreferences: userPreferences,
                chatHistory: chatHistory,
                chefPreambleString: chefPreamble,
                ingredientContext: ingredientContext
            });
        }

        // Save user message to history
        await saveChatMessage(userId, chatId, userMessageForHistory);

        // Simplified response processing
        logger.info('Processing AI response:', {
            hasConversationalText: result?.conversationalText ? true : false,
            hasRecipe: result?.recipe ? true : false
        });
        
        let responseData;
        let aiMessageText;

        // Handle response formats (much simpler now)
        if (result.conversationalText) {
            // Our new natural conversation response
            responseData = {
                conversationalText: result.conversationalText,
                status: 'success'
            };
            aiMessageText = result.conversationalText;
        } else if (result.recipe) {
            // Legacy recipe response from image/URL processing
            responseData = {
                recipe: result.recipe,
                status: 'success'
            };
            aiMessageText = `I've created a recipe for you! It serves ${result.recipe.servings} people. You can ask me questions about this recipe or request modifications.`;
        } else {
            // Fallback for any unexpected format
            logger.warn('Unexpected AI response format:', { 
                result: JSON.stringify(result).substring(0, 200)
            });
            responseData = {
                conversationalText: "I'm having trouble processing your request. Please try rephrasing or ask me something else!",
                status: 'success'
            };
            aiMessageText = responseData.conversationalText;
        }

        // Save AI response to history
        await saveChatMessage(userId, chatId, {
            role: "model",
            parts: [{ text: aiMessageText }],
            timestamp: FieldValue.serverTimestamp()
        });

        return responseData;

    } catch (error) {
        logger.error('Error in handleRecipeChatTurn:', { error: error.message, userId });
        throw new HttpsError('internal', 'Internal server error');
    }
};

// Helper functions - simple and direct

async function getChatHistory(userId, chatId, limit = 10) {
    try {
        const messagesRef = db.collection(`users/${userId}/chats/${chatId}/messages`);
        const snapshot = await messagesRef.orderBy('timestamp', 'desc').limit(limit).get();
        
        const messages = [];
        snapshot.forEach(doc => {
            messages.push(doc.data());
        });
        
        return messages.reverse(); // Return in chronological order
    } catch (error) {
        logger.error('Error fetching chat history:', { error: error.message, userId, chatId });
        return [];
    }
}

async function saveChatMessage(userId, chatId, message) {
    try {
        await db.collection(`users/${userId}/chats/${chatId}/messages`).add(message);
    } catch (error) {
        logger.error('Error saving chat message:', { error: error.message, userId, chatId });
    }
}

async function getUserPreferences(userId) {
    try {
        const doc = await db.collection('users').doc(userId).get();
        if (doc.exists) {
            const data = doc.data();
            const preferences = {
                difficulty: data.preferredRecipeDifficulty || 'medium',
                allergensToAvoid: data.allergensToAvoid || [],
                dietaryPreferences: data.dietaryPreferences || [],
                customDietaryNotes: data.customDietaryNotes || '',
                preferredCookTimePreference: data.preferredCookTimePreference || '',
                preferredChefPersonality: data.preferredChefPersonality || '',
                // Legacy field for backward compatibility
                selectedDietaryFilters: data.selectedDietaryFilters || []
            };
            logger.info(`User preferences raw data for ${userId}:`);
            logger.info(`- Document keys: ${JSON.stringify(Object.keys(data))}`);
            logger.info(`- allergensToAvoid: ${JSON.stringify(data.allergensToAvoid)}`);
            logger.info(`- dietaryPreferences: ${JSON.stringify(data.dietaryPreferences)}`);
            logger.info(`- preferredRecipeDifficulty: ${JSON.stringify(data.preferredRecipeDifficulty)}`);
            logger.info(`- customDietaryNotes: ${JSON.stringify(data.customDietaryNotes)}`);
            logger.info(`- Final preferences object: ${JSON.stringify(preferences)}`);
            return preferences;
        } else {
            logger.warn('User document does not exist:', { userId });
            return {
                difficulty: 'medium',
                allergensToAvoid: [],
                dietaryPreferences: [],
                customDietaryNotes: '',
                preferredCookTimePreference: '',
                preferredChefPersonality: '',
                selectedDietaryFilters: []
            };
        }
    } catch (error) {
        logger.error('Error fetching user preferences:', { error: error.message, userId });
        return {
            difficulty: 'medium',
            allergensToAvoid: [],
            dietaryPreferences: [],
            customDietaryNotes: '',
            preferredCookTimePreference: '',
            preferredChefPersonality: '',
            selectedDietaryFilters: []
        };
    }
}

async function getIngredientContext(userId) {
    try {
        logger.info(`Attempting to load UserPreferenceAnalyzer for user ${userId}`);
        const { UserPreferenceAnalyzer } = require('../shared/services/userPreferenceAnalyzer');
        logger.info('UserPreferenceAnalyzer loaded successfully');
        
        const analyzer = new UserPreferenceAnalyzer();
        logger.info('UserPreferenceAnalyzer instance created');
        
        const result = await analyzer.buildIngredientContext(userId);
        logger.info(`Ingredient context built successfully for ${userId}: ${result ? 'has content' : 'empty'}`);
        return result;
    } catch (error) {
        logger.error(`Error building ingredient context for ${userId}:`);
        logger.error(`- Error message: ${error.message}`);
        logger.error(`- Error stack: ${error.stack}`);
        return ""; // Silent fallback
    }
}



// Export for Firebase Functions
exports.handleRecipeChatTurn = onCall(
    {
        region: config.REGION,
        memory: config.MEMORY,
        timeoutSeconds: config.TIMEOUT_SECONDS,
        minInstances: config.MIN_INSTANCES,
    },
    handleRecipeChatTurnLogic
);