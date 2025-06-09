const { logger } = require("firebase-functions/v2");
const { getModel } = require('../../shared/services/geminiClient');
const imageProcessor = require('../../shared/services/imageProcessor');

class GeminiIngredientsService {
    constructor() {
        this.model = null;
    }

    async getModel() {
        if (!this.model) {
            this.model = await getModel('gemini-2.0-flash');
        }
        return this.model;
    }

    /**
     * Analyzes an image to detect ingredients
     */
    async analyzeIngredientsImage(imageDataBase64, imageMimeType, location, hasAnnotation = false) {
        try {
            // Use shared image processor to prepare image (following working pattern)
            const imageProcessingResult = imageProcessor.prepareImageForGemini(imageDataBase64, imageMimeType);
            
            if (!imageProcessingResult.success) {
                throw new Error(`Image processing failed: ${imageProcessingResult.error}`);
            }

            const model = await this.getModel();
            const prompt = this.buildImageAnalysisPrompt(location, hasAnnotation);

            // Use the same pattern as working handleRecipeChatTurn
            const result = await model.generateContent([prompt, imageProcessingResult.imagePart]);
            const response = await result.response;
            const text = response.text();

            return this.parseIngredientResponse(text);

        } catch (error) {
            logger.error('Error in Gemini image analysis:', error);
            throw new Error(`Ingredient analysis failed: ${error.message}`);
        }
    }

    /**
     * Analyzes text to extract ingredients
     */
    async analyzeIngredientsText(text, location) {
        try {
            const model = await this.getModel();
            const prompt = this.buildTextAnalysisPrompt(text, location);

            const result = await model.generateContent(prompt);
            const response = await result.response;
            const responseText = response.text();

            return this.parseIngredientResponse(responseText);

        } catch (error) {
            logger.error('Error in Gemini text analysis:', error);
            throw new Error(`Text analysis failed: ${error.message}`);
        }
    }

    /**
     * Builds the prompt for image analysis
     */
    buildImageAnalysisPrompt(location, hasAnnotation) {
        const basePrompt = `
You are an expert food and ingredient recognition AI. Analyze this ${location} image and identify all visible ingredients and food items.

${hasAnnotation ? 
    'IMPORTANT: The user has drawn circles or markings on this image. ONLY identify ingredients within the highlighted/circled areas. Ignore everything else in the image.' 
    : 'Identify ALL visible ingredients and food items in this image.'
}

For each ingredient you identify, provide:
- name: The specific ingredient name (be precise but use common names)
- quantity: Estimated quantity if visible (use natural language like "3", "1 bag", "some", "half")
- confidence: Your confidence level as a number between 0.0 and 1.0
- location: Always use "${location}" since this is where the user is scanning

Guidelines:
- Focus on ingredients that could be used for cooking
- Don't include non-food items, condiments in tiny amounts, or beverages unless specifically requested
- For packaged items, identify the ingredient inside (e.g., "pasta" not "box")
- Use common cooking names (e.g., "ground beef" not "hamburger meat")
- If quantity is hard to determine, use descriptive terms like "some", "several", "bunch"
- Be conservative with confidence scores - use lower scores if uncertain
- If you see annotations/circles and can't clearly identify what's inside them, skip those items

Return your response as a JSON object with this exact structure:
{
  "detectedIngredients": [
    {
      "name": "ingredient name",
      "quantity": "estimated quantity or null",
      "confidence": 0.85,
      "location": "${location}"
    }
  ],
  "confidence": 0.8,
  "suggestions": ["Optional suggestions for better scanning"]
}

Only respond with the JSON object, no additional text.`;

        return basePrompt;
    }

    /**
     * Builds the prompt for text analysis
     */
    buildTextAnalysisPrompt(text, location) {
        const prompt = `
You are an expert at parsing ingredient lists. The user has provided this text describing ingredients they have:

"${text}"

Extract all ingredients from this text. The user said these are in their ${location}.

For each ingredient, provide:
- name: Clean ingredient name (standardized)
- quantity: Any quantity mentioned or null if not specified
- confidence: 1.0 for text parsing (unless the text is unclear)
- location: Always use "${location}"

Guidelines:
- Clean up ingredient names (e.g., "2 tomatoe" becomes "tomatoes")
- Handle plural/singular appropriately
- Separate compound items (e.g., "bread and butter" = two ingredients)
- Ignore non-ingredients like "and", "some", "a few" unless they specify quantity
- For unclear text, use lower confidence scores
- Handle common abbreviations (e.g., "lbs" = "pounds", "tsp" = "teaspoons")

Return your response as a JSON object with this exact structure:
{
  "detectedIngredients": [
    {
      "name": "ingredient name",
      "quantity": "quantity or null",
      "confidence": 1.0,
      "location": "${location}"
    }
  ],
  "confidence": 0.95,
  "suggestions": ["Optional suggestions if text was unclear"]
}

Only respond with the JSON object, no additional text.`;

        return prompt;
    }

    /**
     * Parses the AI response and validates the structure
     */
    parseIngredientResponse(responseText) {
        try {
            // Clean the response text
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

            // Validate required structure
            if (!parsed.detectedIngredients || !Array.isArray(parsed.detectedIngredients)) {
                throw new Error('Invalid response structure: missing detectedIngredients array');
            }

            // Validate each ingredient
            const validatedIngredients = parsed.detectedIngredients.map(ingredient => {
                if (!ingredient.name || typeof ingredient.name !== 'string') {
                    throw new Error('Invalid ingredient: missing or invalid name');
                }

                return {
                    name: ingredient.name.trim(),
                    quantity: ingredient.quantity && typeof ingredient.quantity === 'string' ? 
                             ingredient.quantity.trim() : null,
                    confidence: Math.max(0, Math.min(1, parseFloat(ingredient.confidence) || 0.5)),
                    location: ingredient.location || 'other'
                };
            });

            return {
                detectedIngredients: validatedIngredients,
                confidence: Math.max(0, Math.min(1, parseFloat(parsed.confidence) || 0.8)),
                suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : []
            };

        } catch (error) {
            logger.error('Error parsing Gemini response:', { 
                error: error.message, 
                responseText: responseText.substring(0, 500) 
            });
            
            // Return empty result on parse failure
            return {
                detectedIngredients: [],
                confidence: 0.0,
                suggestions: ['Failed to parse ingredients. Please try again with a clearer image or text.']
            };
        }
    }
}

// Export singleton instance
const geminiIngredientsService = new GeminiIngredientsService();

module.exports = {
    analyzeIngredientsImage: (imageDataBase64, imageMimeType, location, hasAnnotation) => 
        geminiIngredientsService.analyzeIngredientsImage(imageDataBase64, imageMimeType, location, hasAnnotation),
    
    analyzeIngredientsText: (text, location) => 
        geminiIngredientsService.analyzeIngredientsText(text, location)
}; 