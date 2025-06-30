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

        // Get user preferences first to get chef personality from profile
        logger.info('Fetching user preferences for chef personality and other settings', { userId });
        const userPreferences = await getUserPreferences(userId);
        if (!userPreferences) {
            throw new HttpsError('failed-precondition', 'Unable to fetch user preferences');
        }

        // Get chef personality from user profile (not from client)
        const chefPersonalityKey = userPreferences.preferredChefPersonality || 'Helpful Chef';
        const chefPreamble = config.CHEF_PERSONALITY_PROMPTS[chefPersonalityKey] || 
                           config.CHEF_PERSONALITY_PROMPTS["Helpful Chef"] || 
                           "You are a helpful, expert, and friendly cooking assistant.";
        
        logger.info('Using chef personality from user profile', { 
            userId, 
            chefPersonality: chefPersonalityKey 
        });

        // Get data we need - parallelize for better performance
        const [chatHistory, ingredientContext] = await Promise.all([
            getChatHistory(userId, chatId),
            getIngredientContext(userId)
        ]);

        // Extract existing recipe ID if currentRecipeJSON is provided
        let existingRecipeId = null;
        if (currentRecipeJSON) {
            try {
                const currentRecipe = JSON.parse(currentRecipeJSON);
                existingRecipeId = currentRecipe.recipeId;
                if (existingRecipeId) {
                    logger.info('Extracted existing recipe ID from context', { 
                        userId, 
                        recipeId: existingRecipeId,
                        recipeTitle: currentRecipe.title 
                    });
                }
            } catch (parseError) {
                logger.warn('Could not parse currentRecipeJSON for recipe ID extraction', { 
                    userId, 
                    error: parseError.message 
                });
            }
        }

        // Enhanced context logging for optimization
        const conversationAge = chatHistory.length > 0 ? 
            Math.round((Date.now() - (chatHistory[0].timestamp?.toDate?.()?.getTime() || Date.now())) / (1000 * 60)) : 0;
        
        logger.info('Context analysis', { 
            userId, 
            chatHistoryLength: chatHistory.length,
            conversationTurns: Math.floor(chatHistory.length / 2),
            conversationAgeMinutes: conversationAge,
            hasIngredientContext: !!ingredientContext,
            hasRecipeContext: !!currentRecipeJSON,
            existingRecipeId: existingRecipeId,
            hasEnhancedUserContext: !!(userPreferences?.enhancedContext),
            inputType: imageDataBase64 ? 'image' : sourceUrl ? 'url' : 'text',
            promptLength: userPrompt?.length || 0
        });

        let result;
        let userMessageForHistory;

        // Check if client supports streaming
        const isStreaming = request.acceptsStreaming;
        let streamCallback = null;
        
        if (isStreaming) {
            streamCallback = (chunkText) => {
                response.sendChunk({ conversationalText: chunkText });
            };
            logger.info('Streaming enabled for chat response', { userId, chatId });
        }

        // Handle different input types with our unified approach
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
                imageMimeType: imageMimeType,
                isStreaming: isStreaming,
                streamCallback: streamCallback
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
                sourceUrl: sourceUrl,
                isStreaming: isStreaming,
                streamCallback: streamCallback
            });
        } else {
            userMessageForHistory = { 
                role: "user", 
                parts: [{ text: userPrompt }], 
                timestamp: FieldValue.serverTimestamp() 
            };
            
            // Use our unified conversation handler
            result = await geminiService.getUnifiedChatResponse({
                userQuery: userPrompt,
                currentRecipeJsonString: currentRecipeJSON,
                userPreferences: userPreferences,
                chatHistory: chatHistory,
                chefPreambleString: chefPreamble,
                ingredientContext: ingredientContext,
                isStreaming: isStreaming,
                streamCallback: streamCallback
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
        logger.error('Error in handleRecipeChatTurn:', { 
            error: error.message, 
            stack: error.stack,
            userId,
            chatId,
            errorType: error.constructor.name
        });

        // Specific error handling instead of generic "internal"
        if (error instanceof HttpsError) {
            // Re-throw HttpsError as-is (these are already user-friendly)
            throw error;
        } else if (error.message.includes('PERMISSION_DENIED')) {
            throw new HttpsError('permission-denied', 'Access denied to user data');
        } else if (error.message.includes('DEADLINE_EXCEEDED') || error.message.includes('timeout')) {
            throw new HttpsError('deadline-exceeded', 'Request took too long to process. Please try again.');
        } else if (error.message.includes('RESOURCE_EXHAUSTED')) {
            throw new HttpsError('resource-exhausted', 'Service temporarily overloaded. Please try again in a moment.');
        } else if (error.message.includes('gemini') || error.message.includes('Gemini')) {
            throw new HttpsError('unavailable', 'AI service temporarily unavailable. Please try again.');
        } else if (error.message.includes('JSON') || error.message.includes('parse')) {
            throw new HttpsError('internal', 'Data processing error. Please try rephrasing your request.');
        } else {
            // Log the full error for debugging but return user-friendly message
            logger.error('Unhandled error details:', { 
                message: error.message,
                stack: error.stack,
                code: error.code,
                userId 
            });
            throw new HttpsError('internal', 'Something went wrong. Please try again or contact support if the issue persists.');
        }
    }
};

// Helper functions - simple and direct

async function getChatHistory(userId, chatId, limit = 30) {
    try {
        // Increased from 10 to 30 messages (~15 conversation turns) for better context retention
        // This improves ALL conversations, especially cooking sessions that tend to be longer
        const messagesRef = db.collection(`users/${userId}/chats/${chatId}/messages`);
        const snapshot = await messagesRef.orderBy('timestamp', 'desc').limit(limit).get();
        
        const messages = [];
        snapshot.forEach(doc => {
            messages.push(doc.data());
        });
        
        return messages.reverse(); // Return in chronological order
    } catch (error) {
        logger.error('Error fetching chat history:', { error: error.message, userId, chatId });
        throw new Error('Failed to fetch chat history');
    }
}

async function saveChatMessage(userId, chatId, message) {
    try {
        await db.collection(`users/${userId}/chats/${chatId}/messages`).add(message);
    } catch (error) {
        logger.error('Error saving chat message:', { error: error.message, userId, chatId });
        throw new Error('Failed to save chat message');
    }
}

async function getUserPreferences(userId) {
    try {
        const doc = await db.collection('users').doc(userId).get();
        let basicPreferences;
        
        if (doc.exists) {
            const data = doc.data();
            basicPreferences = {
                allergensToAvoid: data.allergensToAvoid || [],
                dietaryPreferences: data.dietaryPreferences || [],
                customDietaryNotes: data.customDietaryNotes || '',
                preferredCookTimePreference: data.preferredCookTimePreference || '',
                preferredChefPersonality: data.preferredChefPersonality || 'Helpful Chef', // Default chef personality
                preferredRecipeDifficulty: data.preferredRecipeDifficulty || 'medium',
                // Legacy field for backward compatibility
                selectedDietaryFilters: data.selectedDietaryFilters || []
            };
        } else {
            logger.warn('User document does not exist:', { userId });
            basicPreferences = {
                allergensToAvoid: [],
                dietaryPreferences: [],
                customDietaryNotes: '',
                preferredCookTimePreference: '',
                preferredChefPersonality: 'Helpful Chef', // Default chef personality
                preferredRecipeDifficulty: 'medium',
                selectedDietaryFilters: []
            };
        }

        // NEW: Add enhanced profile with rating insights
        try {
            const { UserPreferenceAnalyzer } = require('../shared/services/userPreferenceAnalyzer');
            const analyzer = new UserPreferenceAnalyzer();
            const enhancedProfile = await analyzer.generateUserPreferenceProfile(userId);
            
            if (enhancedProfile && enhancedProfile.dataQuality.hasGoodData) {
                // Add formatted profile to basic preferences for Gemini context
                basicPreferences.enhancedContext = analyzer.formatProfileForPrompt(enhancedProfile);
                logger.info(`Enhanced user context added for ${userId}: ${basicPreferences.enhancedContext.substring(0, 200)}...`);
            }
        } catch (enhancedError) {
            // Silent fallback - enhanced context is optional
            logger.warn(`Could not generate enhanced profile for ${userId}: ${enhancedError.message}`);
        }

        logger.info(`User preferences for ${userId}:`);
        logger.info(`- allergensToAvoid: ${JSON.stringify(basicPreferences.allergensToAvoid)}`);
        logger.info(`- dietaryPreferences: ${JSON.stringify(basicPreferences.dietaryPreferences)}`);
        logger.info(`- preferredRecipeDifficulty: ${JSON.stringify(basicPreferences.preferredRecipeDifficulty)}`);
        logger.info(`- preferredChefPersonality: ${JSON.stringify(basicPreferences.preferredChefPersonality)}`);
        logger.info(`- customDietaryNotes: ${JSON.stringify(basicPreferences.customDietaryNotes)}`);
        logger.info(`- enhancedContext: ${basicPreferences.enhancedContext ? 'present' : 'not available'}`);
        
        return basicPreferences;
    } catch (error) {
        logger.error('Error fetching user preferences:', { error: error.message, userId });
        throw new Error('Failed to fetch user preferences');
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