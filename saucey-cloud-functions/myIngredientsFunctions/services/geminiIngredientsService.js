const { logger } = require("firebase-functions/v2");
const { getModel } = require('../../shared/services/geminiClient');
const imageProcessor = require('../../shared/services/imageProcessor');

// Configuration constants
const CONFIG = {
    CONFIDENCE_THRESHOLDS: {
        LOW_CONFIDENCE: 0.6,
        DEFAULT_CONFIDENCE: 0.8,
        HIGH_CONFIDENCE: 0.9
    },
    FALLBACK_CONFIDENCE: 0.5,
    MAX_INGREDIENTS_FOR_SMART_MERGE: 50
};

// Kitchen Section Definitions
const KITCHEN_SECTIONS = {
    FRIDGE_FREEZER: 'fridge_freezer',
    PANTRY: 'pantry', 
    SAUCES: 'sauces',
    SPICES: 'spices'
};

// Prompt templates with AI-guided section assignment
const PROMPT_TEMPLATES = {
    SECTION_INTELLIGENCE: `You are an expert in kitchen organization and home cooking workflows. When assigning ingredients to kitchen sections, consider:

**Storage Science**: Temperature requirements, shelf life, preservation needs
**Cooking Workflows**: How ingredients are typically used together in recipes
**Cultural Patterns**: Different culinary traditions and their organization preferences
**Home Cook Reality**: How real people actually organize their kitchens (not perfect theory)

**Kitchen Sections Available**:
- **fridge_freezer**: Fresh produce, dairy, meat, leftovers, frozen items (requires refrigeration)
- **pantry**: Shelf-stable items like grains, canned goods, dried items, baking supplies (room temperature storage)
- **sauces**: Condiments, dressings, cooking oils, vinegars, liquid seasonings (flavor enhancers)
- **spices**: Dried herbs, spice powders, extracts, seasonings (small quantities, flavor compounds)

**Edge Case Guidelines**:
- Oils: Cooking oils (high volume) → sauces, Finishing oils (small bottles) → sauces, Coconut oil (solid) → pantry
- Herbs: Fresh → fridge_freezer, Dried → spices
- Ethnic ingredients: Consider cultural cooking patterns (miso → sauces, tahini → sauces, ghee → sauces)
- Multi-use items: Choose based on primary kitchen workflow (honey as sweetener → sauces, honey for baking → pantry)

Think about where a home cook would naturally reach for each ingredient when cooking.`,

    IMAGE_ANALYSIS: {
        BASE: `You are an expert food recognition AI with deep knowledge of kitchen organization. Analyze this {location} image and identify all visible ingredients.`,
        ANNOTATION_INSTRUCTION: `IMPORTANT: The user has drawn circles or markings on this image. ONLY identify ingredients within the highlighted/circled areas. Ignore everything else.`,
        DEFAULT_INSTRUCTION: `Identify ALL visible ingredients and food items in this image.`,
        GUIDELINES: `Guidelines:
- Focus on ingredients used for cooking, not non-food items
- For packaged items, identify the ingredient inside (e.g., "pasta" not "box") 
- Use common cooking names (e.g., "ground beef" not "hamburger meat")
- Estimate quantities with descriptive terms when unclear: "some", "several", "bunch", "1 bag"
- Be conservative with confidence scores if uncertain
- For each ingredient, intelligently assign to the most appropriate kitchen section based on how home cooks organize and use these items`,
        
        JSON_STRUCTURE: `{
  "detectedIngredients": [
    {
      "name": "ingredient name",
      "quantity": "estimated quantity or null", 
      "confidence": 0.85,
      "location": "{location}",
      "kitchenSection": "fridge_freezer|pantry|sauces|spices",
      "reasoning": "brief explanation for section choice"
    }
  ],
  "confidence": 0.8,
  "suggestions": ["Optional suggestions for better scanning"]
}`
    },

    TEXT_ANALYSIS: {
        BASE: `You are an expert at parsing ingredient lists with deep knowledge of kitchen organization. Extract and organize ingredients from this text:`,
        GUIDELINES: `Guidelines:
- Clean up ingredient names (e.g., "2 tomatoe" becomes "tomatoes")
- Handle plural/singular appropriately  
- Separate compound items (e.g., "bread and butter" = two ingredients)
- Ignore non-ingredients like "and", "some", "a few" unless they specify quantity
- Handle common abbreviations (e.g., "lbs" = "pounds", "tsp" = "teaspoons")
- For each ingredient, thoughtfully assign to the kitchen section that makes most sense for home cooking workflows`
    },

    SMART_MERGE: {
        BASE: `You are an expert kitchen inventory manager with deep understanding of cooking workflows. The user scanned their {location} and you detected new ingredients. Intelligently merge these with their existing inventory.`,
        ANALYSIS_POINTS: `Analyze this situation considering:

1. **EXACT MATCHES**: Same ingredient name in both lists
2. **SIMILAR MATCHES**: Likely the same ingredient (e.g., "tomato" vs "tomatoes", "ground beef" vs "beef")
3. **MISSING ITEMS**: Existing ingredients not detected (consumed/moved?) 
4. **NEW ADDITIONS**: Detected ingredients not in existing inventory
5. **CONFIDENCE ASSESSMENT**: Flag low-confidence detections for user review
6. **SECTION OPTIMIZATION**: Ensure ingredients are in the most logical kitchen sections for this user's workflow`,
        
        GUIDELINES: `Guidelines:
- Set needsUserReview=true for missing items or low confidence detections
- Use "flag_missing" for existing ingredients not detected (might be consumed)
- Use "needs_review" for detections with confidence < 0.6
- Be intelligent about ingredient name variations (tomato/tomatoes should match)
- Consider that users consume items between scans
- Provide helpful userPrompt text when review needed
- Assign kitchen sections based on cooking workflow logic, not rigid rules`
    }
};

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
     * Common utility for parsing JSON responses from Gemini
     */
    parseJsonResponse(responseText, fallbackResult, context = 'response') {
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

            return JSON.parse(cleanedText);

        } catch (error) {
            logger.error(`Error parsing ${context}:`, { 
                error: error.message, 
                responseText: responseText.substring(0, 500) 
            });
            
            return fallbackResult;
        }
    }

    /**
     * Validates confidence values and ensures they're within bounds
     */
    validateConfidence(confidence, defaultValue = CONFIG.CONFIDENCE_THRESHOLDS.DEFAULT_CONFIDENCE) {
        return Math.max(0, Math.min(1, parseFloat(confidence) || defaultValue));
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

    /**
     * Analyzes an image to detect ingredients with AI-guided section assignment
     */
    async analyzeIngredientsImage(imageDataBase64, imageMimeType, location, hasAnnotation = false) {
        try {
            const imageProcessingResult = imageProcessor.prepareImageForGemini(imageDataBase64, imageMimeType);
            
            if (!imageProcessingResult.success) {
                throw new Error(`Image processing failed: ${imageProcessingResult.error}`);
            }

            const model = await this.getModel();
            const prompt = this.buildImageAnalysisPrompt(location, hasAnnotation);

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
     * Analyzes text to extract ingredients with AI-guided section assignment
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
     * Builds the image analysis prompt with AI-guided section intelligence
     */
    buildImageAnalysisPrompt(location, hasAnnotation) {
        const instruction = hasAnnotation ? 
            PROMPT_TEMPLATES.IMAGE_ANALYSIS.ANNOTATION_INSTRUCTION : 
            PROMPT_TEMPLATES.IMAGE_ANALYSIS.DEFAULT_INSTRUCTION;

        return `${PROMPT_TEMPLATES.SECTION_INTELLIGENCE}

${PROMPT_TEMPLATES.IMAGE_ANALYSIS.BASE.replace('{location}', location)}

${instruction}

For each ingredient you identify, provide:
- name: Specific ingredient name (use common cooking names)
- quantity: Estimated quantity if visible (use natural language)
- confidence: Your confidence level (0.0 to 1.0)
- location: Always use "${location}" (where user is scanning)
- kitchenSection: Assign to most appropriate section using the intelligence guidelines above
- reasoning: Brief explanation for your section choice (helps improve the system)

${PROMPT_TEMPLATES.IMAGE_ANALYSIS.GUIDELINES}

Return your response as a JSON object with this exact structure:
${PROMPT_TEMPLATES.IMAGE_ANALYSIS.JSON_STRUCTURE.replace('{location}', location)}

Only respond with the JSON object, no additional text.`;
    }

    /**
     * Builds the text analysis prompt with AI-guided section intelligence
     */
    buildTextAnalysisPrompt(text, location) {
        return `${PROMPT_TEMPLATES.SECTION_INTELLIGENCE}

${PROMPT_TEMPLATES.TEXT_ANALYSIS.BASE}

"${text}"

Extract all ingredients from this text. The user said these are in their ${location}.

For each ingredient, provide:
- name: Clean, standardized ingredient name
- quantity: Any quantity mentioned or null
- confidence: Your confidence in the extraction (0.0 to 1.0)
- location: Always use "${location}"
- kitchenSection: Assign to most appropriate section using the intelligence guidelines above
- reasoning: Brief explanation for your section choice

${PROMPT_TEMPLATES.TEXT_ANALYSIS.GUIDELINES}

Return the parsed ingredients as a JSON object with this structure:
{
  "detectedIngredients": [
    {
      "name": "cleaned ingredient name",
      "quantity": "extracted quantity or null",
      "confidence": 0.9,
      "location": "${location}",
      "kitchenSection": "fridge_freezer|pantry|sauces|spices",
      "reasoning": "brief explanation"
    }
  ],
  "confidence": 0.85,
  "suggestions": ["Optional parsing notes"]
}

Only respond with the JSON object, no additional text.`;
    }

    /**
     * Smart merge analysis with AI-guided section intelligence
     */
    async analyzeIngredientsWithSmartMerge(imageDataBase64, imageMimeType, textInput, location, existingIngredients = []) {
        try {
            // Step 1: Analyze inputs concurrently
            const analysisResult = await this.analyzeInputsConcurrently(imageDataBase64, imageMimeType, textInput, location);
            
            // Step 2: Ensure all detected ingredients have sections (AI should handle this, but fallback for safety)
            if (analysisResult.detectedIngredients) {
                analysisResult.detectedIngredients = analysisResult.detectedIngredients.map(ingredient => ({
                    ...ingredient,
                    kitchenSection: ingredient.kitchenSection || this.getFallbackSection(ingredient.name, ingredient.location)
                }));
            }
            
            // Step 3: Check if smart merge is needed
            if (!existingIngredients || existingIngredients.length === 0) {
                // Create "add_new" actions for all detected ingredients
                const actions = analysisResult.detectedIngredients.map(ingredient => ({
                    type: 'add_new',
                    ingredient: ingredient,
                    reason: 'New ingredient detected in empty kitchen',
                    kitchenSection: ingredient.kitchenSection
                }));
                
                return {
                    ...analysisResult,
                    mergeStrategy: 'simple_add',
                    conflictsFound: false,
                    needsUserReview: false,
                    actions: actions,
                    summary: `Adding ${analysisResult.detectedIngredients.length} new ingredients to your kitchen`,
                    userPrompt: null
                };
            }

            if (existingIngredients.length > CONFIG.MAX_INGREDIENTS_FOR_SMART_MERGE) {
                // Create "add_new" actions for all detected ingredients (simple add for large inventories)
                const actions = analysisResult.detectedIngredients.map(ingredient => ({
                    type: 'add_new',
                    ingredient: ingredient,
                    reason: 'Adding to large inventory (simple add mode)',
                    kitchenSection: ingredient.kitchenSection
                }));
                
                return {
                    ...analysisResult,
                    mergeStrategy: 'simple_add',
                    conflictsFound: false,
                    needsUserReview: false,
                    actions: actions,
                    summary: `Adding ${analysisResult.detectedIngredients.length} new ingredients (simple add mode)`,
                    userPrompt: null
                };
            }

            // Step 4: Execute smart merge analysis
            return await this.executeSmartMerge(analysisResult, existingIngredients, location);

        } catch (error) {
            logger.error('Error in smart merge analysis:', error);
            throw new Error(`Smart merge analysis failed: ${error.message}`);
        }
    }

    /**
     * Analyzes image and text inputs concurrently
     */
    async analyzeInputsConcurrently(imageDataBase64, imageMimeType, textInput, location) {
        const analysisPromises = [];
        
        // Add image analysis if provided
        if (imageDataBase64 && imageMimeType) {
            analysisPromises.push(
                this.analyzeIngredientsImage(imageDataBase64, imageMimeType, location, false)
                    .catch(error => {
                        logger.warn('Image analysis failed, continuing with text only:', error.message);
                        return { detectedIngredients: [], confidence: 0, suggestions: ['Image analysis failed'] };
                    })
            );
        }

        // Add text analysis if provided
        if (textInput && textInput.trim()) {
            analysisPromises.push(
                this.analyzeIngredientsText(textInput.trim(), location)
                    .catch(error => {
                        logger.warn('Text analysis failed, continuing with image only:', error.message);
                        return { detectedIngredients: [], confidence: 0, suggestions: ['Text analysis failed'] };
                    })
            );
        }

        // Wait for all analyses to complete
        const results = await Promise.all(analysisPromises);
        
        // Combine results
        let detectedIngredients = [];
        let suggestions = [];
        let minConfidence = CONFIG.CONFIDENCE_THRESHOLDS.DEFAULT_CONFIDENCE;

        results.forEach(result => {
            detectedIngredients = [...detectedIngredients, ...result.detectedIngredients];
            suggestions = [...suggestions, ...result.suggestions];
            minConfidence = Math.min(minConfidence, result.confidence);
        });

        return {
            detectedIngredients,
            confidence: minConfidence,
            suggestions
        };
    }

    /**
     * Executes smart merge with LLM analysis
     */
    async executeSmartMerge(analysisResult, existingIngredients, location) {
        try {
            const mergeResult = await this.performSmartMergeAnalysis(
                analysisResult.detectedIngredients, 
                existingIngredients, 
                location
            );
            
            return {
                ...mergeResult,
                originalDetectionConfidence: analysisResult.confidence,
                originalSuggestions: analysisResult.suggestions
            };

        } catch (error) {
            logger.error('Smart merge execution failed, falling back to simple merge:', error);
            return this.fallbackSimpleMerge(analysisResult.detectedIngredients, existingIngredients);
        }
    }

    /**
     * Uses LLM to intelligently merge detected ingredients with existing inventory
     */
    async performSmartMergeAnalysis(detectedIngredients, existingIngredients, location) {
        try {
            const model = await this.getModel();
            const prompt = this.buildSmartMergePrompt(detectedIngredients, existingIngredients, location);

            const result = await model.generateContent(prompt);
            const response = await result.response;
            const responseText = response.text();

            return this.parseSmartMergeResponse(responseText);

        } catch (error) {
            logger.error('Error in smart merge LLM analysis:', error);
            return this.fallbackSimpleMerge(detectedIngredients, existingIngredients);
        }
    }

    /**
     * Builds the smart merge prompt with AI-guided section intelligence
     */
    buildSmartMergePrompt(detectedIngredients, existingIngredients, location) {
        const detectedList = detectedIngredients.map(ing => 
            `- ${ing.name} (${ing.quantity || 'unknown quantity'}, confidence: ${ing.confidence}, section: ${ing.kitchenSection || 'unassigned'})`
        ).join('\n');

        const existingList = existingIngredients.map(ing => 
            `- ${ing.name} (location: ${ing.location}, available: ${ing.isAvailable}, section: ${ing.kitchenSection || 'legacy'})`
        ).join('\n');

        return `${PROMPT_TEMPLATES.SECTION_INTELLIGENCE}

${PROMPT_TEMPLATES.SMART_MERGE.BASE.replace('{location}', location)}

DETECTED INGREDIENTS (from current scan):
${detectedList}

EXISTING KITCHEN INVENTORY:
${existingList}

${PROMPT_TEMPLATES.SMART_MERGE.ANALYSIS_POINTS}

Provide your analysis as a JSON response with this exact structure:

{
  "mergeStrategy": "smart_merge",
  "conflictsFound": true/false,
  "needsUserReview": true/false,
  "confidence": 0.85,
  "actions": [
    {
      "type": "add_new",
      "ingredient": {
        "name": "ingredient name",
        "quantity": "quantity or null",
        "confidence": 0.9,
        "location": "${location}",
        "kitchenSection": "fridge_freezer|pantry|sauces|spices"
      },
      "reason": "New ingredient detected",
      "kitchenSection": "fridge_freezer|pantry|sauces|spices"
    },
    {
      "type": "update_existing", 
      "existingName": "old name",
      "updatedIngredient": {
        "name": "updated name",
        "quantity": "new quantity",
        "confidence": 0.8,
        "location": "${location}",
        "kitchenSection": "fridge_freezer|pantry|sauces|spices"
      },
      "reason": "Updated quantity/location",
      "kitchenSection": "fridge_freezer|pantry|sauces|spices"
    },
    {
      "type": "flag_missing",
      "existingName": "missing ingredient name",
      "reason": "Was in inventory but not detected in scan",
      "confidence": 0.7,
      "suggestedAction": "ask_user"
    },
    {
      "type": "needs_review",
      "ingredient": {
        "name": "uncertain ingredient",
        "quantity": "quantity",
        "confidence": 0.4,
        "location": "${location}",
        "kitchenSection": "fridge_freezer|pantry|sauces|spices"
      },
      "reason": "Low confidence detection needs user confirmation",
      "kitchenSection": "fridge_freezer|pantry|sauces|spices"
    }
  ],
  "summary": "Brief summary of changes",
  "userPrompt": "Question to ask user if review needed, or null"
}

${PROMPT_TEMPLATES.SMART_MERGE.GUIDELINES}

Only respond with the JSON object, no additional text.`;
    }

    /**
     * Parses smart merge response with validation
     */
    parseSmartMergeResponse(responseText) {
        const fallbackResult = {
            mergeStrategy: 'simple_add',
            conflictsFound: false,
            needsUserReview: false,
            confidence: CONFIG.FALLBACK_CONFIDENCE,
            actions: [],
            summary: 'Analysis failed, using simple add strategy',
            userPrompt: null
        };

        const parsed = this.parseJsonResponse(responseText, fallbackResult, 'smart merge response');
        
        if (parsed === fallbackResult) {
            return fallbackResult;
        }

        try {
            // Validate structure
            if (!parsed.actions || !Array.isArray(parsed.actions)) {
                throw new Error('Invalid merge response: missing actions array');
            }

            // Validate actions
            const validatedActions = parsed.actions.map(action => {
                if (!action.type || !['add_new', 'update_existing', 'flag_missing', 'needs_review'].includes(action.type)) {
                    throw new Error(`Invalid action type: ${action.type}`);
                }

                // Ensure ingredients have valid sections
                if (action.ingredient && !action.ingredient.kitchenSection) {
                    action.ingredient.kitchenSection = this.getFallbackSection(
                        action.ingredient.name, 
                        action.ingredient.location || 'pantry'
                    );
                }

                return {
                    type: action.type,
                    ingredient: action.ingredient || null,
                    existingName: action.existingName || null,
                    updatedIngredient: action.updatedIngredient || null,
                    reason: action.reason || 'No reason provided',
                    confidence: action.confidence ? this.validateConfidence(action.confidence) : null,
                    suggestedAction: action.suggestedAction || null,
                    kitchenSection: action.kitchenSection || (action.ingredient ? action.ingredient.kitchenSection : null)
                };
            });

            return {
                mergeStrategy: parsed.mergeStrategy || 'smart_merge',
                conflictsFound: Boolean(parsed.conflictsFound),
                needsUserReview: Boolean(parsed.needsUserReview),
                confidence: this.validateConfidence(parsed.confidence),
                actions: validatedActions,
                summary: parsed.summary || 'Merge analysis completed',
                userPrompt: parsed.userPrompt || null
            };

        } catch (error) {
            logger.error('Error validating smart merge response:', error);
            return fallbackResult;
        }
    }

    /**
     * Fallback simple merge when analysis fails
     */
    fallbackSimpleMerge(detectedIngredients, existingIngredients) {
        const actions = detectedIngredients.map(ingredient => ({
            type: 'add_new',
            ingredient: {
                ...ingredient,
                kitchenSection: ingredient.kitchenSection || this.getFallbackSection(ingredient.name, ingredient.location)
            },
            reason: 'Fallback: Adding as new ingredient'
        }));

        return {
            mergeStrategy: 'simple_add',
            conflictsFound: false,
            needsUserReview: detectedIngredients.some(ing => ing.confidence < CONFIG.CONFIDENCE_THRESHOLDS.LOW_CONFIDENCE),
            confidence: CONFIG.FALLBACK_CONFIDENCE,
            actions: actions,
            summary: `Adding ${detectedIngredients.length} new ingredients (fallback mode)`,
            userPrompt: detectedIngredients.some(ing => ing.confidence < CONFIG.CONFIDENCE_THRESHOLDS.LOW_CONFIDENCE) ? 
                       'Some ingredients had low confidence. Please review the additions.' : null
        };
    }

    /**
     * Parses ingredient response with validation
     */
    parseIngredientResponse(responseText) {
        const fallbackResult = {
            detectedIngredients: [],
            confidence: 0.0,
            suggestions: ['Failed to parse ingredients. Please try again.']
        };

        const parsed = this.parseJsonResponse(responseText, fallbackResult, 'ingredient response');
        
        if (parsed === fallbackResult) {
            return fallbackResult;
        }

        try {
            if (!parsed.detectedIngredients || !Array.isArray(parsed.detectedIngredients)) {
                throw new Error('Invalid response: missing detectedIngredients array');
            }

            const validatedIngredients = parsed.detectedIngredients.map(ingredient => {
                if (!ingredient.name || typeof ingredient.name !== 'string') {
                    throw new Error('Invalid ingredient: missing name');
                }

                return {
                    name: ingredient.name.trim(),
                    quantity: ingredient.quantity && typeof ingredient.quantity === 'string' ? 
                             ingredient.quantity.trim() : null,
                    confidence: this.validateConfidence(ingredient.confidence),
                    location: ingredient.location || 'other',
                    kitchenSection: ingredient.kitchenSection || this.getFallbackSection(ingredient.name, ingredient.location),
                    reasoning: ingredient.reasoning || null
                };
            });

            return {
                detectedIngredients: validatedIngredients,
                confidence: this.validateConfidence(parsed.confidence),
                suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : []
            };

        } catch (error) {
            logger.error('Error validating ingredient response:', error);
            return fallbackResult;
        }
    }
}

// Export singleton instance
module.exports = new GeminiIngredientsService(); 