const functions = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const firestoreHelper = require("@saucey/shared/services/firestoreHelper");
const { HttpsError } = require("firebase-functions/v2/https");

/**
 * @typedef {object} MacroTargets
 * @property {number} calories - Target daily calories.
 * @property {number} protein - Target daily protein in grams.
 * @property {number} carbs - Target daily carbohydrates in grams.
 * @property {number} fat - Target daily fat in grams.
 */

/**
 * @typedef {object} MealPlanPreferences
 * @property {MacroTargets} macroTargets - User's macro targets.
 * @property {string[]} preferredCookingDays - Days of the week user prefers to cook (e.g., ["Monday", "Wednesday"]).
 */

/**
 * Saves the user's meal plan preferences (macro targets and preferred cooking days).
 * @param {object} data - The data sent by the client.
 * @param {MealPlanPreferences} data.preferences - The meal plan preferences to save.
 * @param {functions.https.CallableRequest} request - Firebase callable function request context.
 * @returns {Promise<{success: boolean, message: string}>} Confirmation message.
 * @throws {HttpsError} Throws HttpsError for authentication, validation, or internal errors.
 */
exports.saveMealPlanPreferences = functions.onCall(async (request) => {
  logger.debug("saveMealPlanPreferences: Received request", { data: request.data });

  if (!request.auth) {
    logger.warn("saveMealPlanPreferences: Unauthenticated access attempt.");
    throw new HttpsError("unauthenticated", "The function must be called while authenticated.");
  }
  const userId = request.auth.uid;

  const { preferences } = request.data;

  if (!preferences || typeof preferences !== "object") {
    logger.warn("saveMealPlanPreferences: Invalid preferences data format (must be an object).", { userId, preferences });
    throw new HttpsError("invalid-argument", "Invalid preferences data format.");
  }

  if (preferences.hasOwnProperty('macroTargets')) {
    if (preferences.macroTargets === null || typeof preferences.macroTargets === "object") {
      if (preferences.macroTargets) {
        const { calories, protein, carbs, fat } = preferences.macroTargets;
        if (typeof calories !== 'number' || typeof protein !== 'number' || typeof carbs !== 'number' || typeof fat !== 'number') {
          logger.warn("saveMealPlanPreferences: If macroTargets is an object, its values must be numbers.", { userId, macroTargets: preferences.macroTargets });
          throw new HttpsError("invalid-argument", "Macro target values must be numbers.");
        }
      }
    } else { 
        logger.warn("saveMealPlanPreferences: macroTargets must be an object or null.", { userId, macroTargets: preferences.macroTargets });
        throw new HttpsError("invalid-argument", "macroTargets must be an object or null.");
    }
  }

  if (preferences.hasOwnProperty('preferredCookingDays')) {
    if (preferences.preferredCookingDays === null || Array.isArray(preferences.preferredCookingDays)) {
        if (preferences.preferredCookingDays && !preferences.preferredCookingDays.every((day) => typeof day === 'string')) {
            logger.warn("saveMealPlanPreferences: If preferredCookingDays is an array, its elements must be strings.", { userId, preferredCookingDays: preferences.preferredCookingDays });
            throw new HttpsError("invalid-argument", "preferredCookingDays elements must be strings.");
        }
    } else { 
        logger.warn("saveMealPlanPreferences: preferredCookingDays must be an array or null.", { userId, preferredCookingDays: preferences.preferredCookingDays });
        throw new HttpsError("invalid-argument", "preferredCookingDays must be an array or null.");
    }
  }
  
  if (preferences.hasOwnProperty('planDurationWeeks') && preferences.planDurationWeeks !== null && typeof preferences.planDurationWeeks !== 'number'){
    logger.warn("saveMealPlanPreferences: planDurationWeeks must be a number or null if provided.", { userId, planDurationWeeks: preferences.planDurationWeeks });
    throw new HttpsError("invalid-argument", "planDurationWeeks must be a number or null.");
  }
  
  if (preferences.hasOwnProperty('cookingExperience') && preferences.cookingExperience !== null && typeof preferences.cookingExperience !== 'string') {
    logger.warn("saveMealPlanPreferences: cookingExperience must be a string or null.", {userId, cookingExperience: preferences.cookingExperience});
    throw new HttpsError("invalid-argument", "cookingExperience must be a string or null.");
  }

  if (preferences.hasOwnProperty('availableKitchenTools')) {
      if (preferences.availableKitchenTools === null || Array.isArray(preferences.availableKitchenTools)) {
          if (preferences.availableKitchenTools && !preferences.availableKitchenTools.every(tool => typeof tool === 'string')) {
              logger.warn("saveMealPlanPreferences: availableKitchenTools elements must be strings.", {userId, availableKitchenTools: preferences.availableKitchenTools});
              throw new HttpsError("invalid-argument", "availableKitchenTools elements must be strings.");
          }
      } else {
          logger.warn("saveMealPlanPreferences: availableKitchenTools must be an array or null.", {userId, availableKitchenTools: preferences.availableKitchenTools});
          throw new HttpsError("invalid-argument", "availableKitchenTools must be an array or null.");
      }
  }

  const preferencesToSave = { 
    ...preferences, 
    updatedAt: new Date().toISOString(), 
  };
  
  Object.keys(preferencesToSave).forEach(key => {
    if (preferencesToSave[key] === undefined) {
      delete preferencesToSave[key];
    }
  });

  try {
    await firestoreHelper.updateDocument(`users`, userId, { mealPlanPreferences: preferencesToSave }, { merge: true });
    logger.info("saveMealPlanPreferences: Preferences saved successfully to user document.", { userId });
    return { success: true, message: "Meal plan preferences saved successfully." };
  } catch (error) {
    logger.error("saveMealPlanPreferences: Error saving preferences.", {
      userId,
      preferencesAttempted: preferencesToSave, 
      errorMessage: error.message,
      stack: error.stack,
    });
    const sanitizedErrorMessage = String(error.message || "An unknown error occurred").replace(/[`${}\\]/g, "'"); // More robust sanitization
    throw new HttpsError("internal", "An unexpected error occurred while saving preferences. Details: " + sanitizedErrorMessage);
  }
});

/**
 * Fetches the user's meal plan preferences.
 * @param {object} data - The data sent by the client (can be empty).
 * @param {functions.https.CallableRequest} request - Firebase callable function request context.
 * @returns {Promise<{success: boolean, preferences: MealPlanPreferences | null}>} User's meal plan preferences or null if not set.
 * @throws {HttpsError} Throws HttpsError for authentication or internal errors.
 */
exports.fetchMealPlanPreferences = functions.onCall(async (request) => {
  logger.debug("fetchMealPlanPreferences: Received request");

  if (!request.auth) {
    logger.warn("fetchMealPlanPreferences: Unauthenticated access attempt.");
    throw new HttpsError("unauthenticated", "The function must be called while authenticated.");
  }
  const userId = request.auth.uid;

  try {
    // Fetch the main user document
    const userDoc = await firestoreHelper.getDocument(`users`, userId);

    if (!userDoc || !userDoc.mealPlanPreferences) {
      logger.info("fetchMealPlanPreferences: No preferences found for user or mealPlanPreferences field missing.", { userId });
      return { success: true, preferences: null }; // Return null if no preferences field
    }
    
    // Extract the mealPlanPreferences field
    const userPreferences = userDoc.mealPlanPreferences;
    // We no longer need to exclude updatedAt here as it's part of the preferences map.

    logger.info("fetchMealPlanPreferences: Preferences fetched successfully from user document.", { userId });
    return { success: true, preferences: userPreferences };
  } catch (error) {
    logger.error("fetchMealPlanPreferences: Error fetching preferences.", {
      userId,
      errorMessage: error.message,
      stack: error.stack,
    });
    throw new HttpsError("internal", "An unexpected error occurred while fetching preferences.");
  }
});

/**
 * @typedef {object} MealSlotItem
 * @property {string} [recipeId] - ID of the recipe if from cookbook or fully generated.
 * @property {string} title - Title of the meal/recipe (especially for stubs or manual entries).
 * @property {MacroTargets} [estimatedMacros] - Estimated macros, for stubs or manual entries.
 * @property {number} servings - Number of servings planned.
 * @property {boolean} [isStub] - True if this is an AI-suggested stub awaiting full generation.
 * @property {string} source - "cookbook", "stub", "manual".
 */

/**
 * @typedef {object} DayPlan
 * @property {string} date - ISO 8601 date string (e.g., "2024-03-04").
 * @property {string} dayOfWeek - Full name of the day (e.g., "Monday").
 * @property {object.<string, MealSlotItem[]>} meals - Keys are meal types (e.g., "breakfast", "lunch"), values are arrays of meal items.
 * @property {MacroTargets} [dailyTotals] - Optional: Calculated daily totals (client might handle this).
 */

/**
 * @typedef {object} MealPlanDocument
 * @property {string} planId - Unique identifier for the meal plan.
 * @property {string} userId - The ID of the user this plan belongs to.
 * @property {string} startDate - ISO 8601 date string for the start of the plan period.
 * @property {string} endDate - ISO 8601 date string for the end of the plan period.
 * @property {string} [name] - Optional user-defined name for the plan.
 * @property {DayPlan[]} days - Array of daily plans.
 * @property {string} createdAt - ISO string of creation timestamp.
 * @property {string} updatedAt - ISO string of last update timestamp.
 */

/**
 * Saves or updates a user's meal plan.
 * @param {object} data - The data sent by the client.
 * @param {MealPlanDocument} data.plan - The meal plan document to save. The `userId`, `createdAt`, `updatedAt` will be set/overridden by the function.
 * @param {functions.https.CallableRequest} request - Firebase callable function request context.
 * @returns {Promise<{success: boolean, planId: string, message: string}>} Confirmation and planId.
 * @throws {HttpsError} Throws HttpsError for authentication, validation, or internal errors.
 */
exports.saveMealPlan = functions.onCall(async (request) => {
  logger.debug("saveMealPlan: Received request", { data: request.data });

  if (!request.auth) {
    logger.warn("saveMealPlan: Unauthenticated access attempt.");
    throw new HttpsError("unauthenticated", "The function must be called while authenticated.");
  }
  const userId = request.auth.uid;

  const { plan } = request.data;

  if (!plan || typeof plan !== "object" || !plan.planId || !plan.startDate || !plan.endDate || !Array.isArray(plan.days)) {
    logger.warn("saveMealPlan: Invalid plan data format.", { userId, plan });
    throw new HttpsError("invalid-argument", "Invalid plan data format. Required fields: planId, startDate, endDate, days array.");
  }

  // Basic validation for days and meals (can be expanded)
  for (const day of plan.days) {
    if (!day.date || !day.dayOfWeek || typeof day.meals !== 'object') {
      throw new HttpsError("invalid-argument", `Invalid day structure for date: ${day.date}`);
    }
    for (const mealType in day.meals) {
      if (!Array.isArray(day.meals[mealType])) {
        throw new HttpsError("invalid-argument", `Meals for ${mealType} on ${day.date} must be an array.`);
      }
      for (const mealItem of day.meals[mealType]) {
        if (!mealItem.title || typeof mealItem.servings !== 'number' || !mealItem.source) {
          throw new HttpsError("invalid-argument", `Invalid meal item structure in ${mealType} on ${day.date}. Required: title, servings, source.`);
        }
        if (mealItem.source === 'stub' && (!mealItem.estimatedMacros || typeof mealItem.estimatedMacros !== 'object')) {
             throw new HttpsError("invalid-argument", `Stub meal item '${mealItem.title}' requires estimatedMacros.`);
        }
        if (mealItem.source === 'cookbook' && !mealItem.recipeId) {
            throw new HttpsError("invalid-argument", `Cookbook meal item '${mealItem.title}' requires recipeId.`);
        }
      }
    }
  }

  const planToSave = {
    ...plan,
    userId: userId, // Ensure userId is from auth context
    updatedAt: new Date().toISOString(),
  };

  // If it's a new plan (client might not set createdAt, or we can decide to always set it server-side)
  if (!plan.createdAt) {
    planToSave.createdAt = new Date().toISOString();
  }

  try {
    await firestoreHelper.saveDocument(`users/${userId}/mealPlans`, plan.planId, planToSave, { merge: true }); // Use merge true to allow updates
    logger.info("saveMealPlan: Plan saved successfully.", { userId, planId: plan.planId });
    return { success: true, planId: plan.planId, message: "Meal plan saved successfully." };
  } catch (error) {
    logger.error("saveMealPlan: Error saving plan.", {
      userId,
      planId: plan.planId,
      errorMessage: error.message,
      stack: error.stack,
    });
    throw new HttpsError("internal", "An unexpected error occurred while saving the meal plan.");
  }
});

/**
 * Fetches a specific meal plan for the user.
 * @param {object} data - The data sent by the client.
 * @param {string} data.planId - The ID of the meal plan to fetch.
 * @param {functions.https.CallableRequest} request - Firebase callable function request context.
 * @returns {Promise<{success: boolean, plan: MealPlanDocument | null}>} The meal plan document or null if not found.
 * @throws {HttpsError} Throws HttpsError for authentication or internal errors.
 */
exports.fetchMealPlan = functions.onCall(async (request) => {
  logger.debug("fetchMealPlan: Received request", { data: request.data });

  if (!request.auth) {
    logger.warn("fetchMealPlan: Unauthenticated access attempt.");
    throw new HttpsError("unauthenticated", "The function must be called while authenticated.");
  }
  const userId = request.auth.uid;
  const { planId } = request.data;

  if (!planId || typeof planId !== 'string') {
    logger.warn("fetchMealPlan: Invalid planId.", { userId, planId });
    throw new HttpsError("invalid-argument", "Plan ID must be a non-empty string.");
  }

  try {
    const planDoc = await firestoreHelper.getDocument(`users/${userId}/mealPlans`, planId);

    if (!planDoc) {
      logger.info("fetchMealPlan: No plan found with the given ID.", { userId, planId });
      return { success: true, plan: null };
    }

    logger.info("fetchMealPlan: Plan fetched successfully.", { userId, planId });
    return { success: true, plan: planDoc }; // Cast to MealPlanDocument if necessary, assuming firestoreHelper returns it correctly typed
  } catch (error) {
    logger.error("fetchMealPlan: Error fetching plan.", {
      userId,
      planId,
      errorMessage: error.message,
      stack: error.stack,
    });
    throw new HttpsError("internal", "An unexpected error occurred while fetching the meal plan.");
  }
});

const geminiClient = require("@saucey/shared/services/geminiClient");
const globalConfig = require("@saucey/shared/config/globalConfig");

/**
 * @typedef {object} RecipeStub
 * @property {string} title - The title of the recipe idea.
 * @property {MacroTargets} estimatedMacros - The estimated nutritional information.
 * @property {string[]} keyIngredients - A short list of 2-3 key ingredients.
 */

/**
 * @typedef {object} GenerateRecipeStubParams
 * @property {string} mealType - E.g., "breakfast", "lunch", "dinner", "snack".
 * @property {MacroTargets} [targetMacros] - Optional: Specific macro targets for this meal stub.
 * @property {string} [dietaryNotes] - E.g., "vegetarian", "gluten-free", "high-protein focus".
 * @property {string} [cuisinePreference] - E.g., "Italian", "Mexican", "quick and easy".
 * @property {string[]} [existingIngredients] - Optional: A few key ingredients the user might want to use.
 */

/**
 * Generates a recipe stub (title, estimated macros, key ingredients) using AI.
 * @param {GenerateRecipeStubParams} data - Parameters for generating the recipe stub.
 * @param {functions.https.CallableRequest} request - Firebase callable function request context.
 * @returns {Promise<{success: boolean, stub: RecipeStub}>} The generated recipe stub.
 * @throws {HttpsError} Throws HttpsError for authentication, validation, AI errors, or internal errors.
 */
exports.generateRecipeStubForPlan = functions.onCall(async (request) => {
  logger.debug("generateRecipeStubForPlan: Received request", { data: request.data });

  if (!request.auth) {
    logger.warn("generateRecipeStubForPlan: Unauthenticated access attempt.");
    throw new HttpsError("unauthenticated", "The function must be called while authenticated.");
  }
  const userId = request.auth.uid;

  const { 
    mealType, 
    targetMacros, 
    dietaryNotes, 
    cuisinePreference,
    existingIngredients 
  } = request.data;

  if (!mealType || typeof mealType !== 'string') {
    throw new HttpsError("invalid-argument", "Meal type (e.g., lunch) is required.");
  }

  // Construct the prompt for Gemini
  let userPromptParts = [`Generate a recipe stub for a ${mealType}.`];
  if (targetMacros) {
    userPromptParts.push(`It should have approximately ${targetMacros.calories || '_any_'} calories, ${targetMacros.protein || '_any_'}g protein, ${targetMacros.carbs || '_any_'}g carbs, and ${targetMacros.fat || '_any_'}g fat.`);
  }
  if (dietaryNotes) {
    userPromptParts.push(`Consider these dietary notes: ${dietaryNotes}.`);
  }
  if (cuisinePreference) {
    userPromptParts.push(`Cuisine or style preference: ${cuisinePreference}.`);
  }
  if (existingIngredients && existingIngredients.length > 0) {
    userPromptParts.push(`Try to incorporate these ingredients if suitable: ${existingIngredients.join(", ")}.`);
  }
  const userFullPrompt = userPromptParts.join(" ");

  const systemInstruction = `You are a helpful assistant for a recipe application. Your task is to generate a concise recipe idea based on user preferences.
You MUST return your response as a single, valid JSON object with the following structure and only this structure:
{
  "title": "string",
  "estimatedMacros": {
    "calories": "number",
    "protein": "number",
    "carbs": "number",
    "fat": "number"
  },
  "keyIngredients": ["string", "string", "string"]
}
Do not include any other text, explanations, or conversational elements outside of this JSON structure.
The macros should be estimated for a single serving of the recipe. Key ingredients should be a list of 2 to 3 items.`;

  try {
    await geminiClient.ensureGenAIInitialized(); // Ensure client is ready

    const contents = [{ role: "user", parts: [{ text: userFullPrompt }] }];
    const generationConfig = {
        temperature: 0.7,
        topK: 1,
        topP: 1,
        maxOutputTokens: 256, // Recipe stubs should be small
        responseMimeType: "application/json", // Request JSON output
    };

    logger.info("generateRecipeStubForPlan: Calling Gemini model.", { userId, model: globalConfig.GEMINI_FLASH_MODEL, promptLength: userFullPrompt.length });

    const response = await geminiClient.generateContent({
        modelName: globalConfig.GEMINI_FLASH_MODEL, // e.g., 'gemini-1.5-flash-latest' from global config
        contents: contents,
        systemInstruction: { role: "system", parts: [{ text: systemInstruction }] },
        generationConfig: generationConfig,
    });

    if (!response.candidates || response.candidates.length === 0 || !response.candidates[0].content || !response.candidates[0].content.parts || !response.candidates[0].content.parts[0].text) {
        logger.error("generateRecipeStubForPlan: Gemini response was empty or malformed.", { userId, response });
        throw new HttpsError("internal", "AI service returned an empty or invalid response for recipe stub.");
    }

    const rawJsonText = response.candidates[0].content.parts[0].text;
    logger.debug("generateRecipeStubForPlan: Raw JSON text from Gemini:", { userId, rawJsonText });

    let recipeStub;
    try {
        recipeStub = JSON.parse(rawJsonText);
        // Basic validation of the parsed stub
        if (!recipeStub.title || !recipeStub.estimatedMacros || !Array.isArray(recipeStub.keyIngredients) || recipeStub.keyIngredients.length === 0) {
            throw new Error("Parsed recipe stub is missing required fields or keyIngredients is empty.");
        }
        if (typeof recipeStub.estimatedMacros.calories !== 'number' || typeof recipeStub.estimatedMacros.protein !== 'number' || 
            typeof recipeStub.estimatedMacros.carbs !== 'number' || typeof recipeStub.estimatedMacros.fat !== 'number') {
            throw new Error("Parsed recipe stub macros are not all numbers.");    
        }

    } catch (parseError) {
        logger.error("generateRecipeStubForPlan: Failed to parse JSON response from Gemini.", { userId, rawJsonText, error: parseError.message });
        throw new HttpsError("internal", "AI service returned an invalid JSON format for the recipe stub.");
    }

    logger.info("generateRecipeStubForPlan: Recipe stub generated successfully.", { userId, title: recipeStub.title });
    return { success: true, stub: recipeStub };

  } catch (error) {
    logger.error("generateRecipeStubForPlan: Error generating recipe stub.", {
      userId,
      errorMessage: error.message,
      stack: error.stack,
      isHttpsError: error instanceof HttpsError
    });
    if (error instanceof HttpsError) {
      throw error;
    }
    // Check for specific Gemini client errors if needed (e.g., safety blocks)
    if (error.message && error.message.toLowerCase().includes("safety settings")) {
        throw new HttpsError("resource-exhausted", "The request was blocked by safety filters. Please try a different prompt."); // Or another appropriate code
    }
    throw new HttpsError("internal", "An unexpected error occurred while generating the recipe stub.");
  }
});

/**
 * @typedef {object} AiGeneratedMealItem
 * @property {string} title - The title of the recipe idea.
 * @property {MacroTargets} estimatedMacros - The estimated nutritional information.
 * @property {string[]} keyIngredients - A short list of 2-3 key ingredients.
 */

/**
 * @typedef {object} AiGeneratedDayMealSlots
 * @property {AiGeneratedMealItem[]} [breakfast]
 * @property {AiGeneratedMealItem[]} [lunch]
 * @property {AiGeneratedMealItem[]} [dinner]
 * @property {AiGeneratedMealItem[]} [snack1] // Example for snacks
 * @property {AiGeneratedMealItem[]} [snack2]
 */

/**
 * @typedef {object} AiGeneratedDayPlan
 * @property {string} dateString - Placeholder like "Day 1", "Day 2".
 * @property {AiGeneratedDayMealSlots} meals - Contains meal types as keys and arrays of AiGeneratedMealItem.
 */

/**
 * @typedef {object} AiGeneratedPlan
 * @property {AiGeneratedDayPlan[]} plan - Array of AiGeneratedDayPlan.
 */

/**
 * @typedef {object} GenerateAiMealPlanParams
 * @property {number} durationDays - Number of days for the plan (e.g., 3, 7).
 * @property {MacroTargets} targetMacros - User's daily macro targets.
 * @property {string[]} [preferredCookingDays] - Optional: e.g., ["Monday", "Wednesday"].
 * @property {string} [dietaryNotes] - Optional: e.g., "vegetarian", "gluten-free".
 * @property {string} [cuisinePreference] - Optional: e.g., "variety", "Italian".
 * @property {number} [maxPrepTimePerMealMinutes] - Optional: Max prep time in minutes.
 * @property {string} [recipeComplexity] - Optional: e.g., "easy", "medium", "any".
 * @property {string[]} [includeMealTypes] - Optional: Array of meal types to include, e.g. ["breakfast", "lunch", "dinner", "snack"]. Defaults to B/L/D if empty.
 * @property {number} [numberOfSnacks] - Optional: Number of snacks per day if "snack" is in includeMealTypes. Defaults to 1 if snacks requested but number not specified.
 */

/**
 * Generates a full meal plan composed of recipe stubs using AI.
 * @param {GenerateAiMealPlanParams} data - Parameters for generating the meal plan.
 * @param {functions.https.CallableRequest} request - Firebase callable function request context.
 * @returns {Promise<{success: boolean, generatedPlan: AiGeneratedPlan}>} The AI-generated meal plan (with stubs).
 * @throws {HttpsError} Throws HttpsError for various errors.
 */
exports.generateAiMealPlan = functions.onCall(async (request) => {
  logger.debug("generateAiMealPlan: Received request", { data: request.data });

  if (!request.auth) {
    logger.warn("generateAiMealPlan: Unauthenticated access attempt.");
    throw new HttpsError("unauthenticated", "The function must be called while authenticated.");
  }
  const userId = request.auth.uid;

  const {
    durationDays,
    targetMacros,
    preferredCookingDays,
    dietaryNotes,
    cuisinePreference,
    maxPrepTimePerMealMinutes,
    recipeComplexity,
    includeMealTypes: requestedMealTypes,
    numberOfSnacks,
  } = request.data;

  if (typeof durationDays !== 'number' || durationDays <= 0 || durationDays > 14) {
    throw new HttpsError("invalid-argument", "Duration must be a number between 1 and 14 days.");
  }
  if (!targetMacros || typeof targetMacros.calories !== 'number' || typeof targetMacros.protein !== 'number' || typeof targetMacros.carbs !== 'number' || typeof targetMacros.fat !== 'number') {
    throw new HttpsError("invalid-argument", "Valid targetMacros (calories, protein, carbs, fat) are required.");
  }

  let finalIncludeMealTypes = (requestedMealTypes && requestedMealTypes.length > 0) ? requestedMealTypes : ["breakfast", "lunch", "dinner"];
  let finalNumberOfSnacks = (finalIncludeMealTypes.includes("snack") && typeof numberOfSnacks === 'number' && numberOfSnacks > 0) ? numberOfSnacks : (finalIncludeMealTypes.includes("snack") ? 1 : 0);

  // Construct the user prompt for Gemini
  let userPromptParts = [`Generate a ${durationDays}-day meal plan.`];
  userPromptParts.push(`Daily targets: Approximately ${targetMacros.calories} calories, ${targetMacros.protein}g protein, ${targetMacros.carbs}g carbs, and ${targetMacros.fat}g fat.`);
  
  let mealTypesString = finalIncludeMealTypes.filter(mt => mt !== 'snack').join(", ");
  if (finalNumberOfSnacks > 0) {
    mealTypesString += (mealTypesString ? ", plus " : "") + `${finalNumberOfSnacks} snack(s)`;
  }
  userPromptParts.push(`Include these meals daily: ${mealTypesString}.`);

  if (dietaryNotes) userPromptParts.push(`Dietary considerations: ${dietaryNotes}.`);
  if (cuisinePreference) userPromptParts.push(`Cuisine preference: ${cuisinePreference}.`);
  if (preferredCookingDays && preferredCookingDays.length > 0) userPromptParts.push(`User prefers to cook on: ${preferredCookingDays.join(", ")}. Suggest simpler meals or leftovers for other days if possible.`);
  if (maxPrepTimePerMealMinutes) userPromptParts.push(`Each meal should ideally take no more than ${maxPrepTimePerMealMinutes} minutes to prepare.`);
  if (recipeComplexity) userPromptParts.push(`Recipe complexity preference: ${recipeComplexity}.`);
  
  const userFullPrompt = userPromptParts.join(" ");

  const systemInstruction = `You are an expert meal planning AI for a recipe application. Your task is to generate a structured meal plan for a specified number of days. For each meal requested (e.g., breakfast, lunch, dinner, and any snacks like snack1, snack2) on each day, you must provide one recipe idea. Each recipe idea MUST be a "recipe stub" with a "title" (string, descriptive), "estimatedMacros" (an object with calories, protein, carbs, fat as numbers for a single serving), and "keyIngredients" (an array of 2-3 strings). You MUST return your response as a single, valid JSON object. The root of the JSON object must be an object containing a single key "plan", where "plan" is an array of "day" objects. Each "day" object must have a "dateString" (use placeholders like "Day 1", "Day 2", etc.) and a "meals" object. The "meals" object should have keys corresponding to the requested meal types (e.g., "breakfast", "lunch", "dinner", "snack1", "snack2"). The value for each meal key MUST be an array containing exactly ONE recipe stub object. Ensure all macro values are numbers. Do not include any conversational text or explanations outside the main JSON structure. Adhere strictly to all user-provided constraints.`;

  try {
    await geminiClient.ensureGenAIInitialized();
    const contents = [{ role: "user", parts: [{ text: userFullPrompt }] }];
    const generationConfig = {
        temperature: 0.8, // Slightly higher for more varied plans
        topK: 1,
        topP: 0.95,
        maxOutputTokens: durationDays * 1024, // Adjust based on expected size; 1024 per day might be generous for stubs
        responseMimeType: "application/json",
    };

    logger.info("generateAiMealPlan: Calling Gemini model.", { userId, model: globalConfig.GEMINI_FLASH_MODEL, promptLength: userFullPrompt.length, durationDays });

    const response = await geminiClient.generateContent({
        modelName: globalConfig.GEMINI_PRO_MODEL, // Using Pro for potentially more complex generation, can test with Flash too
        contents: contents,
        systemInstruction: { role: "system", parts: [{ text: systemInstruction }] },
        generationConfig: generationConfig,
    });

    if (!response.candidates || response.candidates.length === 0 || !response.candidates[0].content || !response.candidates[0].content.parts || !response.candidates[0].content.parts[0].text) {
        logger.error("generateAiMealPlan: Gemini response was empty or malformed.", { userId, response });
        throw new HttpsError("internal", "AI service returned an empty or invalid response for the meal plan.");
    }

    const rawJsonText = response.candidates[0].content.parts[0].text;
    logger.debug("generateAiMealPlan: Raw JSON text from Gemini:", { userId, rawJsonTextFirst200: rawJsonText.substring(0,200) });

    let aiGeneratedPlan;
    try {
        aiGeneratedPlan = JSON.parse(rawJsonText);
        // Validate the structure of aiGeneratedPlan (basic validation)
        if (!aiGeneratedPlan.plan || !Array.isArray(aiGeneratedPlan.plan) || aiGeneratedPlan.plan.length !== durationDays) {
            throw new Error(`Parsed plan structure is invalid or plan length (${aiGeneratedPlan.plan ? aiGeneratedPlan.plan.length : 'N/A'}) does not match requested duration (${durationDays}).`);
        }
        for (const day of aiGeneratedPlan.plan) {
            if (!day.dateString || typeof day.meals !== 'object') {
                throw new Error(`Invalid day structure in AI plan: missing dateString or meals object for ${day.dateString}`);
            }
            for (const mealTypeName of finalIncludeMealTypes.filter(mt => mt !== 'snack')) {
                if (!day.meals[mealTypeName] || !Array.isArray(day.meals[mealTypeName]) || day.meals[mealTypeName].length !== 1) {
                    throw new Error(`Missing or invalid structure for meal '${mealTypeName}' on ${day.dateString}. Expected array with 1 item.`);
                }
                // Further validation of the stub can be added here if needed, similar to generateRecipeStubForPlan
            }
            for (let i = 1; i <= finalNumberOfSnacks; i++) {
                 const snackKey = `snack${i}`;
                 if(!day.meals[snackKey] || !Array.isArray(day.meals[snackKey]) || day.meals[snackKey].length !== 1) {
                    throw new Error(`Missing or invalid structure for meal '${snackKey}' on ${day.dateString}. Expected array with 1 item.`);
                 }
            }
        }
    } catch (parseError) {
        logger.error("generateAiMealPlan: Failed to parse JSON response from Gemini.", { userId, rawJsonTextFirst500: rawJsonText.substring(0,500), error: parseError.message });
        throw new HttpsError("internal", "AI service returned an invalid JSON format for the meal plan. Details: " + parseError.message);
    }

    logger.info("generateAiMealPlan: AI Meal plan generated successfully.", { userId, durationDays });
    return { success: true, generatedPlan: aiGeneratedPlan };

  } catch (error) {
    logger.error("generateAiMealPlan: Error generating AI meal plan.", {
      userId,
      errorMessage: error.message,
      stack: error.stack,
      isHttpsError: error instanceof HttpsError
    });
    if (error instanceof HttpsError) {
      throw error;
    }
    if (error.message && error.message.toLowerCase().includes("safety settings")) {
        throw new HttpsError("resource-exhausted", "The request for an AI meal plan was blocked by safety filters. Please adjust preferences or try again.");
    }
    throw new HttpsError("internal", "An unexpected error occurred while generating the AI meal plan.");
  }
});

/**
 * @typedef {object} AdaptRecipeStubParams
 * @property {RecipeStub} existingStub - The current recipe stub to be adapted.
 * @property {string} adaptationRequest - User's request for changes (e.g., "Make this lower in carbs by about 15g and increase protein by 10g", "Convert this to a vegetarian version keeping similar macros if possible").
 * @property {MacroTargets} [overallDailyTargetMacros] - Optional: User's overall daily macro targets, to give context to the adaptation if the request is vague (e.g., "make it healthier").
 */

/**
 * Adapts an existing recipe stub based on user's modification request using AI.
 * @param {AdaptRecipeStubParams} data - Parameters for adapting the recipe stub.
 * @param {functions.https.CallableRequest} request - Firebase callable function request context.
 * @returns {Promise<{success: boolean, adaptedStub: RecipeStub}>} The adapted recipe stub.
 * @throws {HttpsError} Throws HttpsError for various errors.
 */
exports.adaptRecipeStubForMacros = functions.onCall(async (request) => {
  logger.debug("adaptRecipeStubForMacros: Received request", { data: request.data });

  if (!request.auth) {
    logger.warn("adaptRecipeStubForMacros: Unauthenticated access attempt.");
    throw new HttpsError("unauthenticated", "The function must be called while authenticated.");
  }
  const userId = request.auth.uid;

  const { existingStub, adaptationRequest, overallDailyTargetMacros } = request.data;

  if (!existingStub || typeof existingStub !== 'object' || !existingStub.title || !existingStub.estimatedMacros || !existingStub.keyIngredients) {
    throw new HttpsError("invalid-argument", "A valid existingRecipeStub (with title, estimatedMacros, keyIngredients) is required.");
  }
  if (!adaptationRequest || typeof adaptationRequest !== 'string' || adaptationRequest.trim().length === 0) {
    throw new HttpsError("invalid-argument", "A non-empty adaptationRequest string is required.");
  }

  // Construct the prompt for Gemini
  let userPromptParts = [
    `Given the following recipe stub:`, 
    `Title: "${existingStub.title}"`,
    `Estimated Macros: Calories ${existingStub.estimatedMacros.calories}, Protein ${existingStub.estimatedMacros.protein}g, Carbs ${existingStub.estimatedMacros.carbs}g, Fat ${existingStub.estimatedMacros.fat}g.`,
    `Key Ingredients: ${existingStub.keyIngredients.join(", ")}.`,
    `Please adapt this recipe stub based on the following request: "${adaptationRequest}".`
  ];
  
  if (overallDailyTargetMacros) {
    userPromptParts.push(`For context, the user's overall daily targets are approximately: Calories ${overallDailyTargetMacros.calories}, Protein ${overallDailyTargetMacros.protein}g, Carbs ${overallDailyTargetMacros.carbs}g, Fat ${overallDailyTargetMacros.fat}g.`);
  }
  userPromptParts.push("Provide the adapted recipe stub with an updated title (if appropriate), new estimated macros, and potentially revised key ingredients.");

  const userFullPrompt = userPromptParts.join("\n");

  // System instruction is the same as generateRecipeStubForPlan, asking for the same JSON output.
  const systemInstruction = `You are a helpful assistant for a recipe application. Your task is to adapt a given recipe idea based on user requests and provide the updated concise recipe idea.
You MUST return your response as a single, valid JSON object with the following structure and only this structure:
{
  "title": "string",
  "estimatedMacros": {
    "calories": "number",
    "protein": "number",
    "carbs": "number",
    "fat": "number"
  },
  "keyIngredients": ["string", "string", "string"]
}
Do not include any other text, explanations, or conversational elements outside of this JSON structure.
The macros should be estimated for a single serving of the recipe. Key ingredients should be a list of 2 to 3 items. If the title changes, reflect that. If the ingredients change, reflect that. Ensure all macro values are numbers.`;

  try {
    await geminiClient.ensureGenAIInitialized();
    const contents = [{ role: "user", parts: [{ text: userFullPrompt }] }];
    const generationConfig = {
        temperature: 0.6, // Slightly lower temperature as we are adapting, not creating from scratch
        topK: 1,
        topP: 1,
        maxOutputTokens: 256, 
        responseMimeType: "application/json",
    };

    logger.info("adaptRecipeStubForMacros: Calling Gemini model.", { userId, model: globalConfig.GEMINI_FLASH_MODEL, promptLength: userFullPrompt.length });

    const response = await geminiClient.generateContent({
        modelName: globalConfig.GEMINI_FLASH_MODEL, 
        contents: contents,
        systemInstruction: { role: "system", parts: [{ text: systemInstruction }] },
        generationConfig: generationConfig,
    });

    if (!response.candidates || response.candidates.length === 0 || !response.candidates[0].content || !response.candidates[0].content.parts || !response.candidates[0].content.parts[0].text) {
        logger.error("adaptRecipeStubForMacros: Gemini response was empty or malformed.", { userId, response });
        throw new HttpsError("internal", "AI service returned an empty or invalid response for recipe adaptation.");
    }

    const rawJsonText = response.candidates[0].content.parts[0].text;
    logger.debug("adaptRecipeStubForMacros: Raw JSON text from Gemini:", { userId, rawJsonText });

    let adaptedStub;
    try {
        adaptedStub = JSON.parse(rawJsonText);
        if (!adaptedStub.title || !adaptedStub.estimatedMacros || !Array.isArray(adaptedStub.keyIngredients) || adaptedStub.keyIngredients.length === 0) {
            throw new Error("Parsed adapted stub is missing required fields or keyIngredients is empty.");
        }
        if (typeof adaptedStub.estimatedMacros.calories !== 'number' || typeof adaptedStub.estimatedMacros.protein !== 'number' || 
            typeof adaptedStub.estimatedMacros.carbs !== 'number' || typeof adaptedStub.estimatedMacros.fat !== 'number') {
            throw new Error("Parsed adapted stub macros are not all numbers.");    
        }
    } catch (parseError) {
        logger.error("adaptRecipeStubForMacros: Failed to parse JSON response from Gemini.", { userId, rawJsonText, error: parseError.message });
        throw new HttpsError("internal", "AI service returned an invalid JSON format for the adapted recipe stub.");
    }

    logger.info("adaptRecipeStubForMacros: Recipe stub adapted successfully.", { userId, title: adaptedStub.title });
    return { success: true, adaptedStub: adaptedStub };

  } catch (error) {
    logger.error("adaptRecipeStubForMacros: Error adapting recipe stub.", {
      userId,
      errorMessage: error.message,
      stack: error.stack,
      isHttpsError: error instanceof HttpsError
    });
    if (error instanceof HttpsError) {
      throw error;
    }
    if (error.message && error.message.toLowerCase().includes("safety settings")) {
        throw new HttpsError("resource-exhausted", "The adaptation request was blocked by safety filters. Please try a different request.");
    }
    throw new HttpsError("internal", "An unexpected error occurred while adapting the recipe stub.");
  }
});

/**
 * @typedef {object} GroceryListItem
 * @property {string} name - Name of the ingredient.
 * @property {number} quantity - Aggregated quantity of the ingredient.
 * @property {string} unit - Unit of the ingredient.
 * @property {string[]} recipeSourceTitles - List of recipe/meal titles that require this ingredient.
 * @property {string} [notes] - Optional notes, e.g., "from recipe idea, verify quantity".
 */

/**
 * @typedef {object} GroceryList
 * @property {string} planId - ID of the meal plan this grocery list is for.
 * @property {string} [planName] - Optional name of the meal plan.
 * @property {string} startDate - Start date of the meal plan period.
 * @property {string} endDate - End date of the meal plan period.
 * @property {GroceryListItem[]} items - Array of aggregated grocery list items.
 * @property {string} generatedAt - ISO timestamp of when the list was generated.
 */

/**
 * Generates an aggregated grocery list for a given meal plan.
 * @param {object} data - The data sent by the client.
 * @param {string} data.planId - The ID of the meal plan to generate a grocery list for.
 * @param {functions.https.CallableRequest} request - Firebase callable function request context.
 * @returns {Promise<{success: boolean, groceryList: GroceryList}>} The generated grocery list.
 * @throws {HttpsError} Throws HttpsError for various errors.
 */
exports.generateGroceryListForPlan = functions.onCall(async (request) => {
  logger.debug("generateGroceryListForPlan: Received request", { data: request.data });

  if (!request.auth) {
    logger.warn("generateGroceryListForPlan: Unauthenticated access attempt.");
    throw new HttpsError("unauthenticated", "The function must be called while authenticated.");
  }
  const userId = request.auth.uid;
  const { planId } = request.data;

  if (!planId || typeof planId !== 'string') {
    throw new HttpsError("invalid-argument", "Plan ID must be a non-empty string.");
  }

  try {
    const mealPlan = await firestoreHelper.getDocument(`users/${userId}/mealPlans`, planId);
    if (!mealPlan) {
      logger.warn("generateGroceryListForPlan: Meal plan not found.", { userId, planId });
      throw new HttpsError("not-found", "Meal plan not found.");
    }

    const aggregatedIngredients = new Map(); // Key: "ingredientName_unit", Value: GroceryListItem

    for (const day of mealPlan.days) {
      for (const mealTypeName in day.meals) {
        const mealSlots = day.meals[mealTypeName];
        for (const mealItem of mealSlots) {
          if (mealItem.source === "cookbook" && mealItem.recipeId) {
            const recipeDoc = await firestoreHelper.getDocument(`users/${userId}/recipes`, mealItem.recipeId);
            if (recipeDoc && recipeDoc.ingredients && Array.isArray(recipeDoc.ingredients)) {
              const recipeServings = recipeDoc.servings || 1; // Default to 1 if not specified
              const planServings = mealItem.servings || 1;
              const scalingFactor = planServings / recipeServings;

              for (const ing of recipeDoc.ingredients) {
                if (ing.name && typeof ing.quantity === 'number' && ing.unit) {
                  const key = `${ing.name.toLowerCase().trim()}_${ing.unit.toLowerCase().trim()}`;
                  const scaledQuantity = ing.quantity * scalingFactor;
                  
                  if (aggregatedIngredients.has(key)) {
                    const existingItem = aggregatedIngredients.get(key);
                    existingItem.quantity += scaledQuantity;
                    if (!existingItem.recipeSourceTitles.includes(mealItem.title)) {
                      existingItem.recipeSourceTitles.push(mealItem.title);
                    }
                  } else {
                    aggregatedIngredients.set(key, {
                      name: ing.name,
                      quantity: scaledQuantity,
                      unit: ing.unit,
                      recipeSourceTitles: [mealItem.title],
                    });
                  }
                }
              }
            } else {
              logger.warn("generateGroceryListForPlan: Cookbook recipe not found or ingredients missing.", { userId, planId, recipeId: mealItem.recipeId });
            }
          } else if (mealItem.source === "stub" && mealItem.keyIngredients && Array.isArray(mealItem.keyIngredients)) {
            for (const keyIngName of mealItem.keyIngredients) {
              const key = `${keyIngName.toLowerCase().trim()}_item(s)`; // Default unit
              if (aggregatedIngredients.has(key)) {
                const existingItem = aggregatedIngredients.get(key);
                // Stubs usually imply 1 serving of the idea, scale by planned servings
                existingItem.quantity += (mealItem.servings || 1); 
                if (!existingItem.recipeSourceTitles.includes(mealItem.title)) {
                  existingItem.recipeSourceTitles.push(mealItem.title);
                }
              } else {
                aggregatedIngredients.set(key, {
                  name: keyIngName,
                  quantity: (mealItem.servings || 1), // Default quantity for key ingredient, scaled by planned servings
                  unit: "item(s)",
                  recipeSourceTitles: [mealItem.title],
                  notes: "From recipe idea; verify quantity & specific type needed."
                });
              }
            }
          }
          // Manual items are ignored for now as they don't have ingredient structures
        }
      }
    }

    const groceryListItems = Array.from(aggregatedIngredients.values()).map(item => ({
        ...item,
        quantity: parseFloat(item.quantity.toFixed(2)) // Round to 2 decimal places
    })); 

    const groceryListOutput = {
      planId: mealPlan.planId,
      planName: mealPlan.name,
      startDate: mealPlan.startDate,
      endDate: mealPlan.endDate,
      items: groceryListItems,
      generatedAt: new Date().toISOString(),
    };

    logger.info("generateGroceryListForPlan: Grocery list generated successfully.", { userId, planId, itemCount: groceryListItems.length });
    return { success: true, groceryList: groceryListOutput };

  } catch (error) {
    logger.error("generateGroceryListForPlan: Error generating grocery list.", {
      userId,
      planId,
      errorMessage: error.message,
      stack: error.stack,
      isHttpsError: error instanceof HttpsError
    });
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError("internal", "An unexpected error occurred while generating the grocery list.");
  }
});

/**
 * @typedef {object} RecipeIngredientItem
 * @property {string} name - Name of the ingredient.
 * @property {number} quantity - Quantity of the ingredient.
 * @property {string} unit - Unit for the quantity (e.g., "g", "ml", "cup", "tbsp").
 * @property {string} [notes] - Optional notes for the ingredient (e.g., "finely chopped", "to taste").
 */

/**
 * @typedef {object} FullRecipeOutput
 * @property {string} title - The title of the recipe.
 * @property {string} description - A brief description of the recipe.
 * @property {RecipeIngredientItem[]} ingredients - Detailed list of ingredients.
 * @property {string[]} instructions - Step-by-step cooking instructions.
 * @property {MacroTargets} estimatedMacros - Estimated macros per serving for the full recipe.
 * @property {number} prepTimeMinutes - Preparation time in minutes.
 * @property {number} cookTimeMinutes - Cooking time in minutes.
 * @property {number} servings - Number of servings the recipe yields.
 * @property {string[]} [tags] - Optional: e.g., ["vegetarian", "quick", "dinner"].
 * @property {string} [difficulty] - Optional: e.g., "Easy", "Medium", "Hard".
 * @property {string} [cuisine] - Optional: e.g., "Italian", "Mexican".
 */

/**
 * @typedef {object} PromoteStubParams
 * @property {RecipeStub} stub - The recipe stub to promote to a full recipe.
 * @property {string} [userPromptEnhancements] - Optional: Any additional requests from the user for the full recipe (e.g., "make sure it's dairy-free", "I prefer step-by-step photos in instructions if you can format for that idea").
 */

/**
 * Promotes a recipe stub to a full, detailed recipe using AI.
 * @param {PromoteStubParams} data - Parameters for promoting the stub.
 * @param {functions.https.CallableRequest} request - Firebase callable function request context.
 * @returns {Promise<{success: boolean, fullRecipe: FullRecipeOutput}>} The generated full recipe.
 * @throws {HttpsError} Throws HttpsError for various errors.
 */
exports.promoteStubToFullRecipe = functions.onCall(async (request) => {
  logger.debug("promoteStubToFullRecipe: Received request", { data: request.data });

  if (!request.auth) {
    logger.warn("promoteStubToFullRecipe: Unauthenticated access attempt.");
    throw new HttpsError("unauthenticated", "The function must be called while authenticated.");
  }
  const userId = request.auth.uid;

  const { stub, userPromptEnhancements } = request.data;

  if (!stub || typeof stub !== 'object' || !stub.title || !stub.estimatedMacros || !stub.keyIngredients) {
    throw new HttpsError("invalid-argument", "A valid RecipeStub (with title, estimatedMacros, keyIngredients) is required.");
  }

  let userPromptParts = [
    `Take the following recipe idea (stub) and expand it into a full, detailed recipe.`, 
    `Original Idea Title: "${stub.title}"`, 
    `Original Estimated Macros (per serving): Calories ${stub.estimatedMacros.calories}, Protein ${stub.estimatedMacros.protein}g, Carbs ${stub.estimatedMacros.carbs}g, Fat ${stub.estimatedMacros.fat}g.`, 
    `Original Key Ingredients: ${stub.keyIngredients.join(", ")}.`,
    `The full recipe should include a clear title, a brief description, a detailed list of ingredients with quantities and units, step-by-step instructions, estimated prep time, estimated cook time, the number of servings the recipe makes, and updated estimated macros per serving for the full recipe. If possible, also suggest some relevant tags, cuisine type, and difficulty level.`
  ];

  if (userPromptEnhancements) {
    userPromptParts.push(`Consider these additional user requests: "${userPromptEnhancements}".`);
  }

  const userFullPrompt = userPromptParts.join("\n");

  const systemInstruction = `You are an expert recipe creator AI. Your task is to generate a complete, well-structured recipe based on a provided recipe idea (stub) and user preferences. 
You MUST return your response as a single, valid JSON object. The root of the JSON object must be a recipe object with the following fields, and only these fields:
{
  "title": "string",
  "description": "string",
  "ingredients": [{"name": "string", "quantity": "number", "unit": "string", "notes": "string (optional)"}],
  "instructions": ["string"],
  "estimatedMacros": {"calories": "number", "protein": "number", "carbs": "number", "fat": "number"},
  "prepTimeMinutes": "number",
  "cookTimeMinutes": "number",
  "servings": "number",
  "tags": ["string"],
  "difficulty": "string",
  "cuisine": "string"
}
Ensure all quantities and times are numbers. The 'ingredients' array should contain objects. The 'instructions' and 'tags' arrays should contain strings. Be clear, concise, and make the recipe easy to follow. The macros should be for a single serving of the final recipe.`;

  try {
    await geminiClient.ensureGenAIInitialized();
    const contents = [{ role: "user", parts: [{ text: userFullPrompt }] }];
    const generationConfig = {
        temperature: 0.7,
        topK: 1,
        topP: 0.95,
        maxOutputTokens: 2048, // Allow more tokens for a full recipe
        responseMimeType: "application/json",
    };

    logger.info("promoteStubToFullRecipe: Calling Gemini model.", { userId, model: globalConfig.GEMINI_PRO_MODEL, promptLength: userFullPrompt.length });

    const response = await geminiClient.generateContent({
        modelName: globalConfig.GEMINI_PRO_MODEL, // Using Pro for better quality full recipe generation
        contents: contents,
        systemInstruction: { role: "system", parts: [{ text: systemInstruction }] },
        generationConfig: generationConfig,
    });

    if (!response.candidates || response.candidates.length === 0 || !response.candidates[0].content || !response.candidates[0].content.parts || !response.candidates[0].content.parts[0].text) {
        logger.error("promoteStubToFullRecipe: Gemini response was empty or malformed.", { userId, response });
        throw new HttpsError("internal", "AI service returned an empty or invalid response for full recipe generation.");
    }

    const rawJsonText = response.candidates[0].content.parts[0].text;
    logger.debug("promoteStubToFullRecipe: Raw JSON text from Gemini (first 200 chars):", { userId, rawJsonTextFirst200: rawJsonText.substring(0,200) });

    let fullRecipe;
    try {
        fullRecipe = JSON.parse(rawJsonText);
        // Add more robust validation of the fullRecipe structure here if needed
        if (!fullRecipe.title || !Array.isArray(fullRecipe.ingredients) || !Array.isArray(fullRecipe.instructions) || !fullRecipe.estimatedMacros) {
            throw new Error("Parsed full recipe is missing critical fields like title, ingredients, instructions, or estimatedMacros.");
        }
         // Ensure numeric fields are indeed numbers
        if (typeof fullRecipe.prepTimeMinutes !== 'number' || 
            typeof fullRecipe.cookTimeMinutes !== 'number' || 
            typeof fullRecipe.servings !== 'number') {
            throw new Error("prepTimeMinutes, cookTimeMinutes, or servings are not numbers in the parsed recipe.");
        }
        for(const ing of fullRecipe.ingredients) {
            if (typeof ing.quantity !== 'number') throw new Error (`Ingredient '${ing.name}' quantity is not a number.`);
        }

    } catch (parseError) {
        logger.error("promoteStubToFullRecipe: Failed to parse JSON response from Gemini.", { userId, rawJsonTextFirst500: rawJsonText.substring(0,500), error: parseError.message });
        throw new HttpsError("internal", "AI service returned an invalid JSON format for the full recipe. Details: " + parseError.message);
    }

    logger.info("promoteStubToFullRecipe: Full recipe generated successfully.", { userId, title: fullRecipe.title });
    return { success: true, fullRecipe: fullRecipe };

  } catch (error) {
    logger.error("promoteStubToFullRecipe: Error generating full recipe.", {
      userId,
      errorMessage: error.message,
      stack: error.stack,
      isHttpsError: error instanceof HttpsError
    });
    if (error instanceof HttpsError) {
      throw error;
    }
    if (error.message && error.message.toLowerCase().includes("safety settings")) {
        throw new HttpsError("resource-exhausted", "The request to generate a full recipe was blocked by safety filters. Please try a different stub or request.");
    }
    throw new HttpsError("internal", "An unexpected error occurred while generating the full recipe.");
  }
});
``` 