const { onRequest } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const { authenticateFirebaseToken } = require('../shared/middleware/authMiddleware');
const geminiService = require('./services/geminiIngredientsService');
const imageProcessor = require('../shared/services/imageProcessor');

const analyzeMyIngredients = onRequest(async (req, res) => {
    // CORS headers
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }
    
    try {
        // Authenticate user
        await new Promise((resolve, reject) => {
            authenticateFirebaseToken(req, res, (err) => {
                if (err) {
                    logger.warn("Auth failed for analyzeMyIngredients", { error: err?.message });
                    return reject(new Error('Authentication failed'));
                }
                if (!req.userId) {
                    logger.error('Auth succeeded but userId missing in analyzeMyIngredients');
                    return reject(new Error('User ID missing'));
                }
                resolve();
            });
        });
        
        const userId = req.userId;
        
        // Firebase Functions HTTP calls wrap data in req.body.data
        const requestData = req.body.data || req.body;
        
        logger.info(`Request data received:`, {
            userId,
            hasData: !!req.body.data,
            dataKeys: Object.keys(requestData || {}),
            hasImageData: !!(requestData && requestData.imageDataBase64),
            hasImageMimeType: !!(requestData && requestData.imageMimeType),
            imageMimeType: requestData ? requestData.imageMimeType : 'MISSING_DATA'
        });
        
        const { imageDataBase64, imageMimeType, location, hasAnnotation } = requestData;
        
        // Validate and process image using shared service
        const imageProcessingResult = imageProcessor.processImageInput(
            imageDataBase64, 
            imageMimeType, 
            'analyzeMyIngredients'
        );
        
        if (!imageProcessingResult.success) {
            return res.status(400).json({ 
                error: imageProcessingResult.error 
            });
        }
        
        // Validate location
        const validLocations = ['fridge', 'pantry', 'freezer', 'other'];
        if (location && !validLocations.includes(location)) {
            return res.status(400).json({ 
                error: `Invalid location. Valid options: ${validLocations.join(', ')}` 
            });
        }
        
        logger.info(`Analyzing ingredients image for user ${userId}`, {
            userId,
            location: location || 'unspecified',
            hasAnnotation: hasAnnotation || false,
            imageSize: imageProcessingResult.buffer.length
        });
        
        // Analyze image with Gemini
        const analysisResult = await geminiService.analyzeIngredientsImage(
            imageDataBase64,
            imageMimeType,
            location || 'fridge',
            hasAnnotation || false
        );
        
        logger.info(`Successfully analyzed ingredients for user ${userId}`, {
            userId,
            detectedCount: analysisResult.detectedIngredients.length,
            confidence: analysisResult.confidence
        });
        
        // Wrap response in data field for Firebase Functions SDK compatibility
        return res.status(200).json({
            data: analysisResult
        });
        
    } catch (error) {
        // Check if it's an authentication error
        if (error.message === 'Authentication failed' || error.message === 'User ID missing') {
            logger.warn("Authentication error in analyzeMyIngredients", { 
                error: error.message 
            });
            if (!res.headersSent) {
                return res.status(401).json({ error: 'Authentication failed' });
            }
            return;
        }
        
        // General error handling
        logger.error("Error in analyzeMyIngredients", { 
            error: error.message, 
            stack: error.stack,
            userId: req.userId 
        });
        
        if (!res.headersSent) {
            return res.status(500).json({ 
                error: 'Failed to analyze ingredients',
                details: error.message 
            });
        }
    }
});

module.exports = { analyzeMyIngredients }; 