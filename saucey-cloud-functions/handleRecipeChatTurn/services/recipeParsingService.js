// recipeParsingService.js
// Parses natural recipe text into structured JSON for saving

const geminiClient = require('@saucey/shared/services/geminiClient.js');
const { extractJsonFromText } = require('@saucey/shared/utils/commonUtils.js');
const config = require('../config');

// JSON Schema for structured recipe parsing
const RECIPE_PARSING_SCHEMA = `
Parse the provided recipe text into a structured JSON format suitable for saving to a cookbook.

JSON Schema:
{
  "recipeId": "string (Generate a new UUID string)",
  "title": "string (Extract the recipe title)",
  "description": "string (Brief summary, 1-2 sentences)",
  "cuisine": "string (e.g., 'Italian', 'Mexican', 'Asian'. Optional.)",
  "category": "string (e.g., 'Dinner', 'Dessert', 'Breakfast'. Optional.)",
  "difficulty": "string (e.g., 'Easy', 'Medium', 'Hard'. Extract or estimate.)",
  "total_time": "string (e.g., '30 minutes', '1 hour'. Extract time mentioned.)",
  "servings": "number (Extract number of servings mentioned)",
  "calories": "string (e.g., 'About 380 calories per serving'. Extract if mentioned.)",
  "macros": {
    "calories": "number (Extract numerical calories per serving)",
    "protein": "number (Extract protein grams per serving)",
    "carbs": "number (Extract carb grams per serving)", 
    "fat": "number (Extract fat grams per serving)"
  },
  "ingredients": [
    {
      "item_name": "string (Ingredient name)",
      "quantity": "number (Amount, e.g., 1, 0.5, 2. Use null if vague like 'a pinch')",
      "unit": "string (e.g., 'cup', 'tbsp', 'tsp'. Use null if not applicable)",
      "isSecret": false,
      "category": "string (e.g., 'Produce', 'Dairy', 'Protein'. Optional.)"
    }
  ],
  "instructions": [
    {
      "text": "string (Clear instruction step)",
      "isSecret": false
    }
  ],
  "tipsAndVariations": ["string (Extract tips mentioned in the text)"],
  "source": "generated_chat_saved",
  "isPublic": false,
  "isSecretRecipe": false
}

PARSING INSTRUCTIONS:
- Extract all information available from the text
- If nutritional info is mentioned but incomplete, estimate reasonable values
- Generate a new UUID for recipeId
- Preserve the natural, conversational tone in the description
- If some fields aren't mentioned in the text, omit them or use reasonable defaults
- For quantities, convert text like "one cup" to 1, "half cup" to 0.5, etc.
- Parse ingredients carefully, separating quantity, unit, and item name
- Break down instructions into clear, numbered steps

Return ONLY the JSON object, no additional text.
`;

/**
 * Parses conversational recipe text into structured JSON
 * @param {string} recipeText - Natural recipe text from conversation
 * @param {object} userPreferences - User dietary preferences for context
 * @param {string} existingRecipeId - Optional existing recipe ID to preserve
 * @returns {Promise<object>} Structured recipe JSON
 */
async function parseRecipeText(recipeText, userPreferences = null, existingRecipeId = null) {
    try {
        console.log('RecipeParsingService: Parsing recipe text of length:', recipeText.length);
        if (existingRecipeId) {
            console.log('RecipeParsingService: Using existing recipe ID:', existingRecipeId);
        }
        
        let prompt = `Parse this recipe text into structured JSON:\n\n${recipeText}`;
        
        // Add user context if available
        if (userPreferences) {
            prompt += `\n\nUser Context:`;
            if (userPreferences.allergensToAvoid?.length > 0) {
                prompt += `\n- Allergens to avoid: ${userPreferences.allergensToAvoid.join(', ')}`;
            }
            if (userPreferences.dietaryPreferences?.length > 0) {
                prompt += `\n- Dietary preferences: ${userPreferences.dietaryPreferences.join(', ')}`;
            }
        }

        const response = await geminiClient.generateContent({
            modelName: config.GEMINI_MODEL_NAME,
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            systemInstruction: { parts: [{ text: RECIPE_PARSING_SCHEMA }] },
            generationConfig: {
                temperature: 0.1, // Low temperature for consistent parsing
                topP: 0.9,
                topK: 40,
                maxOutputTokens: 2000,
                responseMimeType: "application/json"
            },
        });

        const responseText = response.text();
        console.log('RecipeParsingService: Raw parsing response:', responseText.substring(0, 300) + '...');
        
        let parsedRecipe = extractJsonFromText(responseText);
        
        // Handle case where Gemini returns an array containing the recipe object
        if (Array.isArray(parsedRecipe) && parsedRecipe.length > 0) {
            parsedRecipe = parsedRecipe[0];
        }
        
        // Validate required fields
        if (!parsedRecipe.title || !parsedRecipe.ingredients || !parsedRecipe.instructions) {
            throw new Error('Parsed recipe missing required fields');
        }

        // Use existing ID if provided, otherwise generate new one
        if (existingRecipeId) {
            parsedRecipe.recipeId = existingRecipeId;
            console.log('RecipeParsingService: Preserved existing recipe ID:', existingRecipeId);
        } else if (!parsedRecipe.recipeId) {
            parsedRecipe.recipeId = generateUUID();
            console.log('RecipeParsingService: Generated new recipe ID:', parsedRecipe.recipeId);
        }

        // Set default source
        parsedRecipe.source = 'generated_chat_saved';
        parsedRecipe.isPublic = false;
        parsedRecipe.isSecretRecipe = false;

        console.log('RecipeParsingService: Successfully parsed recipe:', parsedRecipe.title);
        return parsedRecipe;

    } catch (error) {
        console.error('RecipeParsingService: Error parsing recipe text:', error);
        throw new Error(`Failed to parse recipe: ${error.message}`);
    }
}

/**
 * Simple UUID generator
 */
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

module.exports = {
    parseRecipeText
}; 