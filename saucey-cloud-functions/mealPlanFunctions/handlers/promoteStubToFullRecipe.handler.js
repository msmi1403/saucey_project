const functions = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const { HttpsError } = require("firebase-functions/v2/https");
const geminiClient = require("@saucey/shared/services/geminiClient");
const globalConfig = require("@saucey/shared/config/globalConfig");
const fs = require('fs');
const path = require('path');

/**
 * @fileoverview Handler for the promoteStubToFullRecipe Firebase Callable Function.
 * Converts recipe stubs into complete recipes with proper serving scaling.
 */

/**
 * Promotes a recipe stub to a full recipe with proper serving scaling
 * @param {object} data - The data sent by the client
 * @param {object} data.params - Parameters for promotion
 * @param {string} data.params.title - Recipe title from stub
 * @param {string[]} data.params.keyIngredients - Key ingredients from stub
 * @param {object} data.params.estimatedMacros - Estimated macros from stub
 * @param {number} data.params.servings - Target servings (from batch calculation)
 * @param {string} [data.params.cuisine] - Preferred cuisine
 * @param {string[]} [data.params.dietaryRestrictions] - Dietary restrictions
 * @param {string} [data.params.cookingExperience] - User cooking experience
 * @param {functions.https.CallableRequest} request - Firebase callable function request context
 * @returns {Promise<{recipe: object}>} The complete recipe
 * @throws {HttpsError} Throws HttpsError for auth, validation, AI errors, or internal errors
 */
const promoteStubToFullRecipe = functions.onCall(async (request) => {
  logger.info("promoteStubToFullRecipe: Called", { data: request.data });

  if (!request.auth) {
    logger.warn("promoteStubToFullRecipe: Unauthenticated access attempt");
    throw new HttpsError("unauthenticated", "The function must be called while authenticated");
  }

  const { params } = request.data;
  const userId = request.auth.uid;

  // Validate required parameters
  if (!params || !params.title || !params.keyIngredients || !params.estimatedMacros || !params.servings) {
    logger.warn("promoteStubToFullRecipe: Missing required parameters", { params });
    throw new HttpsError("invalid-argument", "Missing required parameters: title, keyIngredients, estimatedMacros, servings");
  }

  try {
    // Load and build prompt
    let prompt = fs.readFileSync(path.join(__dirname, '../prompts/promoteStubToFullRecipe.prompt.txt'), 'utf8');
    
    // Replace basic placeholders
    prompt = prompt.replace(/{{title}}/g, params.title);
    prompt = prompt.replace(/{{keyIngredients}}/g, params.keyIngredients.join(', '));
    prompt = prompt.replace(/{{estimatedMacros}}/g, JSON.stringify(params.estimatedMacros));
    prompt = prompt.replace(/{{targetServings}}/g, params.servings.toString());

    // Add context sections
    let cuisineContext = "";
    if (params.cuisine) {
      cuisineContext = `**CUISINE REQUIREMENT:** This must be an authentic ${params.cuisine} recipe.`;
    }
    prompt = prompt.replace('{{cuisineContext}}', cuisineContext);

    let dietaryContext = "";
    if (params.dietaryRestrictions?.length > 0) {
      dietaryContext = `**DIETARY REQUIREMENTS:** ${params.dietaryRestrictions.join(', ')}`;
    }
    prompt = prompt.replace('{{dietaryContext}}', dietaryContext);

    let cookingContext = "";
    if (params.cookingExperience) {
      const experienceMapping = {
        'beginner': 'Keep instructions simple and detailed for beginners',
        'intermediate': 'Instructions can include moderate cooking techniques',
        'advanced': 'Can include advanced techniques and complex steps'
      };
      cookingContext = `**COOKING LEVEL:** ${experienceMapping[params.cookingExperience] || params.cookingExperience}`;
    }
    prompt = prompt.replace('{{cookingContext}}', cookingContext);

    // Clean up prompt
    prompt = prompt.split('\n').filter(line => line.trim() !== '').join('\n');

    logger.info("promoteStubToFullRecipe: Built prompt", { 
      userId, 
      title: params.title, 
      servings: params.servings,
      promptLength: prompt.length 
    });

    // Call AI for recipe generation
    const generationConfig = {
      temperature: globalConfig.GEMINI_TEXT_TEMPERATURE || 0.7,
      maxOutputTokens: globalConfig.GEMINI_TEXT_MAX_OUTPUT_TOKENS || 4096,
      responseMimeType: "application/json",
    };

    const startTime = Date.now();
    const modelResponse = await geminiClient.generateContent({
      modelName: globalConfig.GEMINI_MODEL_NAME,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig,
      safetySettings: globalConfig.GEMINI_SAFETY_SETTINGS.map(s => ({
        category: geminiClient.HarmCategory[s.category],
        threshold: geminiClient.HarmBlockThreshold[s.threshold],
      })),
    });

    const endTime = Date.now();
    logger.info("promoteStubToFullRecipe: AI call completed", {
      userId,
      duration: `${(endTime - startTime) / 1000}s`
    });

    if (!modelResponse.candidates?.[0]?.content?.parts?.[0]?.text) {
      logger.error("promoteStubToFullRecipe: AI response was empty or malformed", { userId, modelResponse });
      throw new HttpsError("internal", "AI service returned an empty or malformed response");
    }

    const aiResponseText = modelResponse.candidates[0].content.parts[0].text;
    logger.info("promoteStubToFullRecipe: Received AI response", {
      userId,
      responseLength: aiResponseText.length
    });

    // Parse and validate AI response
    let recipe;
    try {
      recipe = JSON.parse(aiResponseText);
      
      // Validate required fields
      if (!recipe.title || !recipe.ingredients || !recipe.instructions || !recipe.servings) {
        throw new Error("AI response missing required recipe fields");
      }

      // Ensure servings matches request
      recipe.servings = params.servings;

      // Add metadata
      recipe.recipeId = generateRecipeId();
      recipe.createdAt = new Date().toISOString();
      recipe.source = 'ai_generated';
      recipe.originalStub = {
        title: params.title,
        keyIngredients: params.keyIngredients,
        requestedServings: params.servings
      };

    } catch (parseError) {
      logger.error("promoteStubToFullRecipe: Failed to parse AI response", {
        userId,
        parseError: parseError.message,
        responseText: aiResponseText.substring(0, 500)
      });
      throw new HttpsError("internal", "Failed to parse AI response. AI may not have returned valid JSON");
    }

    logger.info("promoteStubToFullRecipe: Successfully generated recipe", {
      userId,
      recipeId: recipe.recipeId,
      title: recipe.title,
      servings: recipe.servings
    });

    return { recipe };

  } catch (error) {
    logger.error("promoteStubToFullRecipe: Error during recipe generation", {
      userId,
      errorMessage: error.message,
      errorStack: error.stack,
      isHttpsError: error instanceof HttpsError
    });
    
    if (error instanceof HttpsError) throw error;
    
    let clientMsg = "An unexpected error occurred while generating the full recipe";
    if (error.message && error.message.includes("SAFETY")) {
      clientMsg = "The recipe request was blocked by AI safety filters";
    } else if (error.message && error.message.includes("quota")) {
      clientMsg = "The AI service quota was exceeded. Please try again later";
    }
    
    throw new HttpsError("internal", clientMsg, { originalError: error.message });
  }
});

/**
 * Helper function to generate recipe ID
 */
function generateRecipeId() {
  return 'recipe_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

module.exports = { promoteStubToFullRecipe }; 