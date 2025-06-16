const { onCall } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const geminiService = require('./services/geminiIngredientsService');
const imageProcessor = require('../shared/services/imageProcessor');

const analyzeMyIngredients = onCall(async (request) => {
    
    try {
        // Get authenticated user from callable function context
        if (!request.auth) {
            throw new Error('Authentication required');
        }
        
        const userId = request.auth.uid;
        const requestData = request.data;
        
        logger.info(`Request data received:`, {
            userId,
            dataKeys: Object.keys(requestData || {}),
            hasImageData: !!(requestData && requestData.imageDataBase64),
            hasImageMimeType: !!(requestData && requestData.imageMimeType),
            hasTextInput: !!(requestData && requestData.textInput),
            hasExistingIngredients: !!(requestData && requestData.existingIngredients),
            imageMimeType: requestData ? requestData.imageMimeType : 'MISSING_DATA'
        });
        
        const { 
            imageDataBase64, 
            imageMimeType, 
            textInput,
            location, 
            hasAnnotation,
            existingIngredients
        } = requestData;
        
        // Validate inputs - at least one input method required
        if (!imageDataBase64 && !textInput) {
            throw new Error('Either image data or text input is required');
        }

        // Validate existing ingredients structure if provided
        if (existingIngredients && !Array.isArray(existingIngredients)) {
            throw new Error('existingIngredients must be an array');
        }

        // Validate existing ingredients have required fields
        if (existingIngredients && existingIngredients.length > 0) {
            const invalidIngredient = existingIngredients.find(ing => 
                !ing.name || typeof ing.name !== 'string' || 
                !ing.location || typeof ing.location !== 'string'
            );
            if (invalidIngredient) {
                throw new Error('Invalid existing ingredient structure: missing name or location');
            }
        }
        
        // Validate and process image if provided
        if (imageDataBase64) {
            const imageProcessingResult = imageProcessor.processImageInput(
                imageDataBase64, 
                imageMimeType, 
                'analyzeMyIngredients'
            );
            
            if (!imageProcessingResult.success) {
                throw new Error(imageProcessingResult.error);
            }
        }
        
        // Validate location
        const validLocations = ['fridge', 'pantry', 'freezer', 'other'];
        if (location && !validLocations.includes(location)) {
            throw new Error(`Invalid location. Valid options: ${validLocations.join(', ')}`);
        }
        
        const finalLocation = location || 'fridge';
        
        logger.info(`Analyzing ingredients for user ${userId} (smart merge)`, {
            userId,
            location: finalLocation,
            hasAnnotation: hasAnnotation || false,
            hasImage: !!imageDataBase64,
            hasText: !!textInput,
            existingIngredientsCount: existingIngredients ? existingIngredients.length : 0
        });
        
        // Always use smart merge analysis (handles empty existing ingredients gracefully)
        const analysisResult = await geminiService.analyzeIngredientsWithSmartMerge(
            imageDataBase64,
            imageMimeType,
            textInput,
            finalLocation,
            existingIngredients || [] // Always pass existing ingredients array (can be empty)
        );
        
        logger.info(`Successfully analyzed ingredients for user ${userId}`, {
            userId,
            detectedCount: analysisResult.detectedIngredients ? analysisResult.detectedIngredients.length : 0,
            confidence: analysisResult.confidence,
            mergeStrategy: analysisResult.mergeStrategy || 'smart_merge',
            needsUserReview: analysisResult.needsUserReview || false
        });
        
        // Return analysis result - callable functions automatically wrap it properly
        return analysisResult;
        
    } catch (error) {
        logger.error("Error in analyzeMyIngredients", { 
            error: error.message, 
            stack: error.stack,
            userId: userId || 'unknown'
        });
        
        // Re-throw for Firebase Functions to handle properly
        throw error;
    }
});

module.exports = { analyzeMyIngredients }; 