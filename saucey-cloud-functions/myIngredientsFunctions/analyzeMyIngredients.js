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
            hasImageDataArray: !!(requestData && requestData.imageDataArray && requestData.imageDataArray.length > 0),
            hasImageMimeType: !!(requestData && requestData.imageMimeType),
            hasTextInput: !!(requestData && requestData.textInput),
            hasExistingIngredients: !!(requestData && requestData.existingIngredients),
            imageCount: requestData?.imageDataArray?.length || 0,
            imageMimeType: requestData ? requestData.imageMimeType : 'MISSING_DATA'
        });
        
        const { 
            imageDataArray,
            imageMimeType, 
            textInput,
            location, 
            hasAnnotation,
            existingIngredients
        } = requestData;
        
        // Validate inputs - at least one input method required
        if ((!imageDataArray || imageDataArray.length === 0) && !textInput) {
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
        
        // Validate and process images if provided
        if (imageDataArray && imageDataArray.length > 0) {
            for (let i = 0; i < imageDataArray.length; i++) {
                const imageProcessingResult = imageProcessor.processImageInput(
                    imageDataArray[i], 
                    imageMimeType, 
                    `analyzeMyIngredients_image_${i}`
                );
                
                if (!imageProcessingResult.success) {
                    throw new Error(`Image ${i + 1} processing failed: ${imageProcessingResult.error}`);
                }
            }
        }
        
        // Validate location
        const validLocations = ['fridge', 'pantry', 'freezer', 'other'];
        if (location && !validLocations.includes(location)) {
            throw new Error(`Invalid location. Valid options: ${validLocations.join(', ')}`);
        }
        
        const finalLocation = location || 'fridge';
        
        logger.info(`Analyzing ingredients for user ${userId} (single-step)`, {
            userId,
            location: finalLocation,
            hasAnnotation: hasAnnotation || false,
            imageCount: imageDataArray ? imageDataArray.length : 0,
            hasText: !!textInput,
            existingIngredientsCount: existingIngredients ? existingIngredients.length : 0
        });
        
        // Single-step analysis with all inputs
        const analysisResult = await geminiService.analyzeIngredients(
            imageDataArray && imageDataArray.length > 0 ? imageDataArray : null,
            imageMimeType,
            textInput,
            finalLocation,
            existingIngredients || []
        );
        
        logger.info(`Successfully analyzed ingredients for user ${userId}`, {
            userId,
            ingredientsCount: analysisResult.ingredients ? analysisResult.ingredients.length : 0,
            summary: analysisResult.summary
        });
        
        // Return analysis result
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