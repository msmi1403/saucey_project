const functions = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const { HttpsError } = require("firebase-functions/v2/https");
const firestoreHelper = require("@saucey/shared/services/firestoreHelper");
const geminiClient = require("@saucey/shared/services/geminiClient");
const globalConfig = require("@saucey/shared/config/globalConfig");
const { validatePlanId } = require("../utils/validationHelper"); // Corrected path
const fs = require('fs');
const path = require('path');

/**
 * @fileoverview Handler for the planGroceryLister Firebase Callable Function.
 * @see /saucey-cloud-functions/mealPlanFunctions/types.js for type definitions (GroceryList)
 */

/**
 * Generates a grocery list for a given meal plan using AI.
 * @param {object} data - The data sent by the client.
 * @param {string} data.planId - The ID of the meal plan to generate a grocery list for.
 * @param {functions.https.CallableRequest} request - Firebase callable function request context.
 * @returns {Promise<{groceryList: GroceryList}>} The generated grocery list.
 * @throws {HttpsError} Throws HttpsError for auth, validation, AI errors, or internal errors.
 */
const planGroceryLister = functions.onCall(async (request) => {
  logger.info("planGroceryLister: Called from handler", { data: request.data });

  if (!request.auth) {
    logger.warn("planGroceryLister: Unauthenticated access attempt.");
    throw new HttpsError("unauthenticated", "The function must be called while authenticated.");
  }
  const userId = request.auth.uid;
  const { planId } = request.data;

  const planIdValidation = validatePlanId({ planId });
  if (!planIdValidation.isValid) {
    logger.warn("planGroceryLister: Invalid planId.", { userId, errors: planIdValidation.errors, planId });
    throw new HttpsError("invalid-argument", "Invalid planId provided.", { errors: planIdValidation.errors });
  }

  let mealPlanData;
  try {
    const collectionPath = `users/${userId}/mealPlans`;
    mealPlanData = await firestoreHelper.getDocument(collectionPath, planId);
    if (!mealPlanData) {
      logger.warn("planGroceryLister: Meal plan not found in handler.", { userId, planId });
      throw new HttpsError("not-found", "Meal plan not found (handler).");
    }
  } catch (error) {
    logger.error("planGroceryLister: Error fetching meal plan from Firestore in handler.", { userId, planId, errorMessage: error.message, errorStack: error.stack });
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", "Failed to retrieve meal plan details (handler).");
  }

  let mealContext = "The meal plan includes the following items across various days and meal types:\n";
  let recipeSourceTitlesSet = new Set();
  mealPlanData.days.forEach(day => {
    Object.values(day.meals).forEach(mealSlot => {
      mealSlot.forEach(item => {
        mealContext += `- ${item.title}`;
        if (item.keyIngredients && item.keyIngredients.length > 0) {
          mealContext += ` (key ingredients: ${item.keyIngredients.join(", ")})`;
        }
        mealContext += "\n";
        if (item.source === "cookbook" || (item.recipeId && item.title)) {
            recipeSourceTitlesSet.add(item.title);
        }
      });
    });
  });

  let fullPrompt = fs.readFileSync(path.join(__dirname, '../prompts/planGroceryLister.prompt.txt'), 'utf8');

  fullPrompt = fullPrompt.replace(/{{planId}}/g, planId);
  fullPrompt = fullPrompt.replace(/{{planName}}/g, mealPlanData.name || '');
  fullPrompt = fullPrompt.replace(/{{startDate}}/g, mealPlanData.startDate || '');
  fullPrompt = fullPrompt.replace(/{{endDate}}/g, mealPlanData.endDate || '');
  fullPrompt = fullPrompt.replace(/{{generatedAtISO}}/g, new Date().toISOString());
  fullPrompt = fullPrompt.replace('{{mealContext}}', mealContext);
  
  const recipeSourceTitlesList = recipeSourceTitlesSet.size > 0 ? Array.from(recipeSourceTitlesSet).join(", ") : "(No specific cookbook recipes identified, assume items are general)";
  fullPrompt = fullPrompt.replace('{{recipeSourceTitlesList}}', recipeSourceTitlesList);
  fullPrompt = fullPrompt.split('\n').filter(line => line.trim() !== '').join('\n');

  logger.info("planGroceryLister: Constructed prompt for Gemini from handler", { userId, planId, promptLength: fullPrompt.length });

  try {
    const generationConfig = {
      temperature: globalConfig.GEMINI_TEMPERATURE_GROCERY_GENERATION || 0.3,
      maxOutputTokens: globalConfig.GEMINI_MAX_TOKENS_GROCERY_GENERATION || 2048,
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
      logger.error("planGroceryLister: AI response was empty or malformed from handler.", { userId, planId, modelResponse });
      throw new HttpsError("internal", "AI service returned an empty or malformed response for grocery list (handler).");
    }

    const aiResponseText = modelResponse.candidates[0].content.parts[0].text;
    logger.info("planGroceryLister: Received raw text from AI for grocery list from handler.", { userId, planId, first100Chars: aiResponseText.substring(0,100) });

    let groceryListRaw;
    try {
      groceryListRaw = JSON.parse(aiResponseText);
      if (!groceryListRaw.items || !Array.isArray(groceryListRaw.items) || !groceryListRaw.planId) {
        throw new Error("Parsed AI response for grocery list is missing required fields or has incorrect types.");
      }
    } catch (parseError) {
      logger.error("planGroceryLister: Failed to parse AI JSON response for grocery list from handler.", { userId, planId, parseError, aiResponseText });
      throw new HttpsError("internal", "Failed to parse AI grocery list response. AI may not have returned valid JSON (handler).", { aiRawOutput: aiResponseText });
    }

    const finalGroceryList = {
        planId: groceryListRaw.planId || planId,
        planName: groceryListRaw.planName || mealPlanData.name,
        startDate: groceryListRaw.startDate || mealPlanData.startDate,
        endDate: groceryListRaw.endDate || mealPlanData.endDate,
        items: groceryListRaw.items || [],
        generatedAt: groceryListRaw.generatedAt || new Date().toISOString(),
    };

    logger.info("planGroceryLister: Successfully generated grocery list from handler.", { userId, planId });
    return { groceryList: finalGroceryList };

  } catch (error) {
    logger.error("planGroceryLister: Error during AI grocery list generation from handler.", {
      userId, planId,
      errorMessage: error.message, errorStack: error.stack, isHttpsError: error instanceof HttpsError, errorDetails: error.details,
    });
    if (error instanceof HttpsError) throw error;
    let clientMsg = "An unexpected error occurred while generating the grocery list with AI (handler).";
    if (error.message && error.message.includes("SAFETY")) clientMsg = "The grocery list request was blocked by AI safety filters (handler).";
    else if (error.message && error.message.includes("quota")) clientMsg = "The AI service quota was exceeded. Please try again later (handler).";
    throw new HttpsError("internal", clientMsg, { originalError: error.message });
  }
});

module.exports = { planGroceryLister }; 