const functions = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const { HttpsError } = require("firebase-functions/v2/https");
const geminiClient = require("@saucey/shared/services/geminiClient");
const globalConfig = require("@saucey/shared/config/globalConfig");
const { validateGenerateRecipeStubParams } = require("../utils/validationHelper"); // Corrected path
const fs = require('fs');
const path = require('path');

/**
 * @fileoverview Handler for the generateRecipeStubForPlan Firebase Callable Function.
 * @see /saucey-cloud-functions/mealPlanFunctions/types.js for type definitions (GenerateRecipeStubParams, RecipeStub)
 */

/**
 * Generates a single recipe stub (idea) using AI.
 * @param {object} data - The data sent by the client, containing the params.
 * @param {GenerateRecipeStubParams} data.params - Parameters for recipe stub generation.
 * @param {functions.https.CallableRequest} request - Firebase callable function request context.
 * @returns {Promise<{recipeStub: RecipeStub}>} The generated recipe stub.
 * @throws {HttpsError} Throws HttpsError for auth, validation, AI errors, or internal errors.
 */
const generateRecipeStubForPlan = functions.onCall(async (request) => {
  logger.info("generateRecipeStubForPlan: Called from handler", { data: request.data });

  if (!request.auth) {
    logger.warn("generateRecipeStubForPlan: Unauthenticated access attempt.");
    throw new HttpsError("unauthenticated", "The function must be called while authenticated.");
  }

  const { params } = request.data;

  const validation = validateGenerateRecipeStubParams(params);
  if (!validation.isValid) {
    logger.warn("generateRecipeStubForPlan: Invalid parameters.", { errors: validation.errors, params });
    throw new HttpsError("invalid-argument", "Invalid parameters for recipe stub generation.", { errors: validation.errors });
  }

  let fullPrompt = fs.readFileSync(path.join(__dirname, '../prompts/generateRecipeStub.prompt.txt'), 'utf8');

  fullPrompt = fullPrompt.replace('{{mealType}}', params.mealType);

  let targetMacrosPrompt = "";
  if (params.targetMacros) {
    let macroString = "Target specific macros for this meal:";
    if (params.targetMacros.calories) macroString += ` ~${params.targetMacros.calories} kcal;`;
    if (params.targetMacros.protein) macroString += ` ~${params.targetMacros.protein}g protein;`;
    if (params.targetMacros.carbs) macroString += ` ~${params.targetMacros.carbs}g carbs;`;
    if (params.targetMacros.fat) macroString += ` ~${params.targetMacros.fat}g fat;`;
    targetMacrosPrompt = macroString;
  }
  fullPrompt = fullPrompt.replace('{{targetMacrosPrompt}}', targetMacrosPrompt);

  let dietaryNotesPrompt = "";
  if (params.dietaryNotes) {
    dietaryNotesPrompt = `Consider these dietary notes: ${params.dietaryNotes}.`;
  }
  fullPrompt = fullPrompt.replace('{{dietaryNotesPrompt}}', dietaryNotesPrompt);

  let cuisinePreferencePrompt = "";
  if (params.cuisinePreference) {
    cuisinePreferencePrompt = `The preferred cuisine is: ${params.cuisinePreference}.`;
  }
  fullPrompt = fullPrompt.replace('{{cuisinePreferencePrompt}}', cuisinePreferencePrompt);

  let existingIngredientsPrompt = "";
  if (params.existingIngredients && params.existingIngredients.length > 0) {
    existingIngredientsPrompt = `Try to incorporate some of these existing ingredients if it makes sense: ${params.existingIngredients.join(", ")}.`;
  }
  fullPrompt = fullPrompt.replace('{{existingIngredientsPrompt}}', existingIngredientsPrompt);
  fullPrompt = fullPrompt.split('\n').filter(line => line.trim() !== '').join('\n');

  logger.info("generateRecipeStubForPlan: Constructed prompt for Gemini from handler", { promptLength: fullPrompt.length });

  try {
    const generationConfig = {
      temperature: 0.7,
      maxOutputTokens: 512,
      responseMimeType: "application/json",
    };

    const modelResponse = await geminiClient.generateContent({
      modelName: globalConfig.GEMINI_MODEL_NAME,
      contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
      generationConfig,
      safetySettings: globalConfig.GEMINI_SAFETY_SETTINGS.map(s => ({
        category: geminiClient.HarmCategory[s.category],
        threshold: geminiClient.HarmBlockThreshold[s.threshold],
      })),
    });

    if (!modelResponse.candidates || modelResponse.candidates.length === 0 || !modelResponse.candidates[0].content || !modelResponse.candidates[0].content.parts || !modelResponse.candidates[0].content.parts[0].text) {
      logger.error("generateRecipeStubForPlan: AI response was empty or malformed from handler.", { modelResponse });
      throw new HttpsError("internal", "AI service returned an empty or malformed response for recipe stub (handler).");
    }

    const aiResponseText = modelResponse.candidates[0].content.parts[0].text;
    logger.info("generateRecipeStubForPlan: Received raw text from AI for recipe stub from handler.", { first100Chars: aiResponseText.substring(0,100) });

    let recipeStub;
    try {
      recipeStub = JSON.parse(aiResponseText);
      if (!recipeStub.title || !recipeStub.estimatedMacros || !recipeStub.keyIngredients || !Array.isArray(recipeStub.keyIngredients)){
          throw new Error("Parsed AI response for recipe stub is missing required fields or has incorrect types.");
      }
    } catch (parseError) {
      logger.error("generateRecipeStubForPlan: Failed to parse AI JSON response for recipe stub from handler.", { parseError, aiResponseText });
      throw new HttpsError("internal", "Failed to parse AI recipe stub response. AI may not have returned valid JSON (handler).", { aiRawOutput: aiResponseText });
    }

    logger.info("generateRecipeStubForPlan: Successfully generated recipe stub from handler.", { recipeStub });
    return { recipeStub };

  } catch (error) {
    logger.error("generateRecipeStubForPlan: Error during AI recipe stub generation from handler.", {
      errorMessage: error.message, errorStack: error.stack, isHttpsError: error instanceof HttpsError, errorDetails: error.details,
    });
    if (error instanceof HttpsError) throw error;
    let clientMsg = "An unexpected error occurred while generating the recipe idea with AI (handler).";
    if (error.message && error.message.includes("SAFETY")) clientMsg = "The recipe idea request was blocked by AI safety filters (handler).";
    throw new HttpsError("internal", clientMsg, { originalError: error.message });
  }
});

module.exports = { generateRecipeStubForPlan }; 