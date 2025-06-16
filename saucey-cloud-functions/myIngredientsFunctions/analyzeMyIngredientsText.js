const { onCall } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const geminiService = require('./services/geminiIngredientsService');

const analyzeMyIngredientsText = onCall(async (request) => {
    try {
        // Get authenticated user from callable function context
        if (!request.auth) {
            throw new Error('Authentication required');
        }
        
        const userId = request.auth.uid;
        const requestData = request.data;
        const { text, location } = requestData;
        
        // Validate input
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            throw new Error('Missing or empty text field');
        }
        
        if (text.length > 2000) {
            throw new Error('Text too long. Maximum 2000 characters.');
        }
        
        // Validate location
        const validLocations = ['fridge', 'pantry', 'freezer', 'other'];
        if (location && !validLocations.includes(location)) {
            throw new Error(`Invalid location. Valid options: ${validLocations.join(', ')}`);
        }
        
        logger.info(`Analyzing ingredients text for user ${userId}`, {
            userId,
            location: location || 'unspecified',
            textLength: text.length
        });
        
        // Analyze text with Gemini
        const analysisResult = await geminiService.analyzeIngredientsText(
            text.trim(),
            location || 'fridge'
        );
        
        logger.info(`Successfully analyzed ingredients text for user ${userId}`, {
            userId,
            detectedCount: analysisResult.detectedIngredients.length,
            confidence: analysisResult.confidence
        });
        
        // Return analysis result - callable functions automatically wrap it properly
        return analysisResult;
        
    } catch (error) {
        logger.error("Error in analyzeMyIngredientsText", { 
            error: error.message, 
            stack: error.stack,
            userId: userId || 'unknown'
        });
        
        // Re-throw for Firebase Functions to handle properly
        throw error;
    }
});

module.exports = { analyzeMyIngredientsText }; 