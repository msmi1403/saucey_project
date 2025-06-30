const { logger } = require("firebase-functions/v2");
const imageProcessor = require('../../shared/services/imageProcessor');
const globalConfig = require('../../shared/config/globalConfig');
const geminiClient = require('../../shared/services/geminiClient');

// Kitchen Section Definitions
const KITCHEN_SECTIONS = {
    FRIDGE_FREEZER: 'fridge_freezer',
    PANTRY: 'pantry', 
    SAUCES: 'sauces',
    SPICES: 'spices'
};

// Default generation config
const defaultGenerationConfig = {
    temperature: globalConfig.GEMINI_TEXT_TEMPERATURE,
    maxOutputTokens: globalConfig.GEMINI_TEXT_MAX_OUTPUT_TOKENS,
    topP: 0.9,
    topK: 40,
};

// Default safety settings
const defaultSafetySettings = globalConfig.GEMINI_SAFETY_SETTINGS || [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
];

class GeminiIngredientsService {
    constructor() {}

    /**
     * Single-step ingredient analysis - processes all inputs in one Gemini call
     */
    async analyzeIngredients(imageDataArray, imageMimeType, textInput, location, existingIngredients = []) {
        try {
            logger.info('analyzeIngredients: Starting single-step analysis', {
                hasImages: !!(imageDataArray && imageDataArray.length > 0),
                imageCount: imageDataArray ? imageDataArray.length : 0,
                hasText: !!(textInput && textInput.trim()),
                location: location,
                existingIngredientsCount: existingIngredients.length
            });

            // Build the prompt
            const prompt = this.buildAnalysisPrompt(textInput, location, existingIngredients);
            
            // Prepare parts for Gemini (text + images)
            const parts = [{ text: prompt }];
            
            // Add images if provided
            if (imageDataArray && imageDataArray.length > 0) {
                for (const imageData of imageDataArray) {
                    const imageProcessingResult = imageProcessor.prepareImageForGemini(imageData, imageMimeType);
                    if (imageProcessingResult.success) {
                        parts.push(imageProcessingResult.imagePart);
                    } else {
                        logger.warn('Image processing failed, skipping image:', imageProcessingResult.error);
                    }
                }
            }

            // Determine model based on whether we have images
            const modelName = (imageDataArray && imageDataArray.length > 0) ? 
                globalConfig.GEMINI_VISION_MODEL_NAME : 
                globalConfig.GEMINI_MODEL_NAME;

            logger.info('analyzeIngredients: Calling Gemini', {
                modelName: modelName,
                partsCount: parts.length,
                hasImages: parts.length > 1
            });

            // Single Gemini call with all inputs
            const response = await geminiClient.generateContent({
                modelName: modelName,
                contents: [{ role: "user", parts: parts }],
                generationConfig: defaultGenerationConfig,
                safetySettings: defaultSafetySettings,
            });
            
            const responseText = response.text();
            logger.info('analyzeIngredients: Received Gemini response', {
                responseLength: responseText.length,
                responsePreview: responseText.substring(0, 200) + '...'
            });

            return this.parseResponse(responseText);

        } catch (error) {
            logger.error('Error in single-step ingredient analysis:', error);
            throw new Error(`Ingredient analysis failed: ${error.message}`);
        }
    }

    /**
     * Builds the analysis prompt for all inputs
     */
    buildAnalysisPrompt(textInput, location, existingIngredients) {
        const existingList = existingIngredients.map(ing => 
            `- ${ing.name} (section: ${ing.kitchenSection || 'legacy'})`
        ).join('\n');

        const textSection = textInput && textInput.trim() ? 
            `TEXT INPUT: "${textInput.trim()}"` : 
            'TEXT INPUT: none';

        return `Analyze these images and text to determine what ingredients the user has in their ${location}.

${textSection}

EXISTING INVENTORY:
${existingList || 'No existing inventory'}

Analyze the images and text, then determine what ingredients the user has now. 
Merge similar items, remove consumed items, and add new ones.

Return a JSON object with this structure:

{
  "ingredients": [
    {
      "name": "ingredient name",
      "section": "fridge_freezer|pantry|sauces|spices",
      "quantity": "quantity or null"
    }
  ],
  "summary": "brief summary of changes"
}`;
    }

    /**
     * Parses the simplified response
     */
    parseResponse(responseText) {
        const fallbackResult = {
            ingredients: [],
            summary: 'Analysis failed'
        };

        try {
            let cleanedText = responseText.trim();
            
            // Remove markdown code blocks if present
            if (cleanedText.startsWith('```')) {
                cleanedText = cleanedText.replace(/```json\n?/, '').replace(/```$/, '');
            }
            
            // Try to find JSON in the response
            const jsonMatch = cleanedText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                cleanedText = jsonMatch[0];
            }

            const parsed = JSON.parse(cleanedText);
            
            // Validate structure
            if (!parsed.ingredients || !Array.isArray(parsed.ingredients)) {
                throw new Error('Invalid response: missing ingredients array');
            }

            // Validate ingredients
            const validatedIngredients = parsed.ingredients.map(ingredient => {
                if (!ingredient.name || typeof ingredient.name !== 'string') {
                    throw new Error('Invalid ingredient: missing name');
                }

                return {
                    name: ingredient.name.trim(),
                    section: ingredient.section || this.getFallbackSection(ingredient.name, location),
                    quantity: ingredient.quantity && typeof ingredient.quantity === 'string' ? 
                             ingredient.quantity.trim() : null
                };
            });

            return {
                ingredients: validatedIngredients,
                summary: parsed.summary || 'Analysis completed'
            };

        } catch (error) {
            logger.error('Error parsing response:', { 
                error: error.message, 
                responseText: responseText.substring(0, 500) 
            });
            return fallbackResult;
        }
    }

    /**
     * Fallback section assignment when AI doesn't provide one
     */
    getFallbackSection(ingredientName, location) {
        const name = ingredientName.toLowerCase();
        
        // Simple fallback logic based on location
        if (location === 'fridge' || location === 'freezer') {
            return KITCHEN_SECTIONS.FRIDGE_FREEZER;
        }
        
        // Basic spice detection for fallback
        if (name.includes('powder') || name.includes('spice') || name.includes('seasoning') || 
            ['salt', 'pepper', 'oregano', 'basil', 'thyme', 'cumin'].some(spice => name.includes(spice))) {
            return KITCHEN_SECTIONS.SPICES;
        }
        
        // Basic sauce detection for fallback  
        if (['sauce', 'oil', 'vinegar', 'dressing'].some(sauce => name.includes(sauce))) {
            return KITCHEN_SECTIONS.SAUCES;
        }
        
        return KITCHEN_SECTIONS.PANTRY; // Safe default
    }
}

// Export singleton instance
module.exports = new GeminiIngredientsService(); 