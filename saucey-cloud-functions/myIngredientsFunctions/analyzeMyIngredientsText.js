const { onRequest } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const { authenticateFirebaseToken } = require('../shared/middleware/authMiddleware');
const geminiService = require('./services/geminiIngredientsService');

const analyzeMyIngredientsText = onRequest(async (req, res) => {
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
                    logger.warn("Auth failed for analyzeMyIngredientsText", { error: err?.message });
                    return reject(new Error('Authentication failed'));
                }
                if (!req.userId) {
                    logger.error('Auth succeeded but userId missing in analyzeMyIngredientsText');
                    return reject(new Error('User ID missing'));
                }
                resolve();
            });
        });
        
        const userId = req.userId;
        
        // Firebase Functions HTTP calls wrap data in req.body.data
        const requestData = req.body.data || req.body;
        const { text, location } = requestData;
        
        // Validate input
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return res.status(400).json({ 
                error: 'Missing or empty text field' 
            });
        }
        
        if (text.length > 2000) {
            return res.status(400).json({ 
                error: 'Text too long. Maximum 2000 characters.' 
            });
        }
        
        // Validate location
        const validLocations = ['fridge', 'pantry', 'freezer', 'other'];
        if (location && !validLocations.includes(location)) {
            return res.status(400).json({ 
                error: `Invalid location. Valid options: ${validLocations.join(', ')}` 
            });
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
        
        // Wrap response in data field for Firebase Functions SDK compatibility
        return res.status(200).json({
            data: analysisResult
        });
        
    } catch (error) {
        // Check if it's an authentication error
        if (error.message === 'Authentication failed' || error.message === 'User ID missing') {
            logger.warn("Authentication error in analyzeMyIngredientsText", { 
                error: error.message 
            });
            if (!res.headersSent) {
                return res.status(401).json({ error: 'Authentication failed' });
            }
            return;
        }
        
        // General error handling
        logger.error("Error in analyzeMyIngredientsText", { 
            error: error.message, 
            stack: error.stack,
            userId: req.userId 
        });
        
        if (!res.headersSent) {
            return res.status(500).json({ 
                error: 'Failed to analyze ingredients text',
                details: error.message 
            });
        }
    }
});

module.exports = { analyzeMyIngredientsText }; 