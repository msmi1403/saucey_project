const functions = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const { HttpsError } = require("firebase-functions/v2/https");
const geminiClient = require("@saucey/shared/services/geminiClient");
const globalConfig = require("@saucey/shared/config/globalConfig");
const { UserPreferenceAnalyzer } = require("../../shared/services/userPreferenceAnalyzer");
const { CookbookRecipeSelector } = require("../services/cookbookRecipeSelector");
const { MealVarietyTracker } = require("../services/mealVarietyTracker");
const UserPreferenceCacheManager = require("../services/userPreferenceCacheManager");
const fs = require('fs');
const path = require('path');

/**
 * @fileoverview Simplified single-call meal plan generator
 * Replaces the complex chunked approach with one intelligent AI call
 * while maintaining all user personalization features
 */

/**
 * Generates a complete meal plan in a single AI call
 * @param {object} data - The data sent by the client
 * @param {object} data.preferences - User meal plan preferences
 * @param {string} data.userId - User ID (optional, derived from auth)
 * @param {string} data.startDate - ISO date string for plan start (optional, defaults to today)
 * @param {functions.https.CallableRequest} request - Firebase callable function request context
 * @returns {Promise<{mealPlan: MealPlanDocument}>} The complete generated meal plan
 * @throws {HttpsError} Throws HttpsError for auth, validation, AI errors, or internal errors
 */
const generateMealPlan = functions.onCall({ timeoutSeconds: 300 }, async (request) => {
  logger.info("generateMealPlan: Called with simplified single-call approach", { data: request.data });

  if (!request.auth) {
    logger.warn("generateMealPlan: Unauthenticated access attempt");
    throw new HttpsError("unauthenticated", "The function must be called while authenticated.");
  }

  const userId = request.auth.uid;
  const { preferences, startDate } = request.data;

  // Validate inputs
  if (!preferences || typeof preferences !== 'object') {
    logger.warn("generateMealPlan: Missing or invalid preferences", { userId });
    throw new HttpsError("invalid-argument", "Preferences object is required");
  }

  // Parse start date or default to today
  let planStartDate = startDate ? new Date(startDate) : new Date();
  planStartDate.setHours(0, 0, 0, 0); // Normalize to start of day
  
  // Ensure start date is not in the past (use tomorrow if today is requested)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (planStartDate <= today) {
    planStartDate = new Date(today);
    planStartDate.setDate(today.getDate() + 1); // Start tomorrow
  }
  
  // Calculate week-aligned start date (always Sunday)
  const weekAlignedStartDate = getWeekAlignedStartDate(planStartDate);
  
  logger.info("generateMealPlan: Starting generation", {
    userId,
    originalStartDate: planStartDate.toISOString().split('T')[0],
    weekAlignedStartDate: weekAlignedStartDate.toISOString().split('T')[0],
    planDurationWeeks: preferences.planDurationWeeks
  });

  try {
    // PHASE 1: Gather all user context in parallel (keep the smart personalization)
    logger.info("generateMealPlan: Starting user context gathering", { userId });
    const userContext = await buildUserContext(userId);
    
    // PHASE 2: Build comprehensive prompt with all personalization data
    logger.info("generateMealPlan: Building personalized prompt", { userId });
    const prompt = await buildMealPlanPrompt(preferences, userContext, weekAlignedStartDate);
    
    // PHASE 3: Single AI call for complete plan
    logger.info("generateMealPlan: Generating meal plan with AI", { userId });
    const aiResponse = await callAiForMealPlan(prompt, userId);
    
    // PHASE 4: Transform response to MealPlanDocument
    logger.info("generateMealPlan: Finalizing meal plan", { userId });
    const mealPlan = transformAiResponseToMealPlan(aiResponse, preferences, weekAlignedStartDate, userId);
    
    logger.info("generateMealPlan: Successfully generated complete meal plan", {
      userId,
      planId: mealPlan.planId,
      totalDays: mealPlan.days.length
    });

    return { mealPlan };

  } catch (error) {
    logger.error("generateMealPlan: Error during generation", {
      userId,
      errorMessage: error.message,
      errorStack: error.stack,
      isHttpsError: error instanceof HttpsError
    });
    
    if (error instanceof HttpsError) throw error;
    
    let clientMsg = "An unexpected error occurred while generating your meal plan";
    if (error.message && error.message.includes("SAFETY")) {
      clientMsg = "The meal plan request was blocked by AI safety filters";
    } else if (error.message && error.message.includes("quota")) {
      clientMsg = "The AI service quota was exceeded. Please try again later";
    }
    
    throw new HttpsError("internal", clientMsg, { originalError: error.message });
  }
});

/**
 * Builds comprehensive user context with all personalization data
 */
async function buildUserContext(userId) {
  logger.info("generateMealPlan: Building user context", { userId });

  // Initialize services
  const userPreferenceAnalyzer = new UserPreferenceAnalyzer();
  const cookbookRecipeSelector = new CookbookRecipeSelector();
  const mealVarietyTracker = new MealVarietyTracker();
  const preferenceCache = new UserPreferenceCacheManager();

  // Gather all user data in parallel (keep existing smart analysis)
  const [userProfile, recentMeals, cookbookRecipes, ingredientContext] = await Promise.all([
    preferenceCache.getCachedUserPreferences(
      userId, 
      userPreferenceAnalyzer.generateUserPreferenceProfile.bind(userPreferenceAnalyzer)
    ),
    mealVarietyTracker.getRecentlyUsedRecipes(userId, 4),
    cookbookRecipeSelector.getUserCookbookRecipes(userId),
    userPreferenceAnalyzer.buildIngredientContext(userId)
  ]);

  logger.info("generateMealPlan: User context built", {
    userId,
    hasUserProfile: !!userProfile,
    recentMealsCount: recentMeals.length,
    cookbookRecipesCount: cookbookRecipes.length,
    hasIngredientContext: !!ingredientContext
  });

  return { userProfile, recentMeals, cookbookRecipes, ingredientContext };
}

/**
 * Builds the comprehensive meal plan prompt with all personalization
 */
async function buildMealPlanPrompt(preferences, userContext, startDate) {
  // Load base prompt template
  let prompt = fs.readFileSync(path.join(__dirname, '../prompts/simplifiedMealPlan.prompt.txt'), 'utf8');

  // Calculate total days
  const totalDays = preferences.planDurationWeeks * 7;
  prompt = prompt.replace('{{duration}}', totalDays.toString());

  // Build date context with cooking day constraints
  const dateContext = buildDateContext(startDate, preferences, totalDays);
  prompt = prompt.replace('{{dateContext}}', dateContext);

  // Add user personalization (keep the smart analysis)
  const personalization = buildPersonalizationContext(userContext);
  prompt = prompt.replace('{{personalizationContext}}', personalization);

  // Add recent meals for variety (keep variety tracking)
  const varietyContext = buildVarietyContext(userContext.recentMeals);
  prompt = prompt.replace('{{varietyContext}}', varietyContext);

  // Add cookbook recipes for prioritization
  const cookbookContext = buildCookbookContext(userContext.cookbookRecipes);
  prompt = prompt.replace('{{cookbookContext}}', cookbookContext);

  // Add ingredient context for kitchen inventory
  const ingredientContextForPrompt = userContext.ingredientContext || "No current kitchen inventory available.";
  prompt = prompt.replace('{{ingredientContext}}', ingredientContextForPrompt);

  // Add preferences and constraints
  const constraintsContext = buildConstraintsContext(preferences);
  prompt = prompt.replace('{{constraintsContext}}', constraintsContext);

  // Clean up prompt
  prompt = prompt.split('\n').filter(line => line.trim() !== '').join('\n');

  logger.info("generateMealPlan: Prompt built", { promptLength: prompt.length });
  return prompt;
}

/**
 * Builds date context with cooking day logic
 * Enhanced to support per-day per-meal preferences
 */
function buildDateContext(startDate, preferences, totalDays) {
  const dates = [];
  
  // Check if using new enhanced daily meal preferences
  const hasEnhancedScheduling = preferences.dailyMealPreferences && 
    Object.keys(preferences.dailyMealPreferences).length > 0;
  
  // Fallback to old system if new system not configured
  const cookingDays = preferences.availableCookingDays || 
    ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  
  for (let i = 0; i < totalDays; i++) {
    const date = new Date(startDate);
    date.setDate(startDate.getDate() + i);
    
    const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
    const dateString = date.toISOString().split('T')[0];
    
    let shouldGenerateMeals = false;
    let mealInstructions = 'EMPTY MEALS OBJECT';
    
    if (hasEnhancedScheduling) {
      // NEW: Per-day per-meal scheduling
      const mealsForDay = preferences.dailyMealPreferences[dayName] || [];
      if (mealsForDay.length > 0) {
        shouldGenerateMeals = true;
        const mealTypesList = mealsForDay.join(', ');
        mealInstructions = `GENERATE ONLY: ${mealTypesList}`;
      }
    } else {
      // FALLBACK: Old system - all enabled meals on cooking days
      shouldGenerateMeals = cookingDays.includes(dayName);
      if (shouldGenerateMeals) {
        const enabledMeals = [];
        if (preferences.includeBreakfast) enabledMeals.push('breakfast');
        if (preferences.includeLunch) enabledMeals.push('lunch');
        if (preferences.includeDinner) enabledMeals.push('dinner');
        mealInstructions = enabledMeals.length > 0 ? `GENERATE FULL MEALS: ${enabledMeals.join(', ')}` : 'EMPTY MEALS OBJECT';
      }
    }
    
    dates.push({
      date: dateString,
      dayName,
      generateMeals: shouldGenerateMeals,
      mealInstructions
    });
  }

  // Create instructions for AI
  const instructions = dates.map(d => 
    `${d.date} (${d.dayName}): ${d.mealInstructions}`
  ).join('\n');

  const systemType = hasEnhancedScheduling ? 'Enhanced per-day per-meal scheduling' : 'Legacy cooking days system';
  
  return `EXACT DATE INSTRUCTIONS (${systemType}):\n${instructions}\n\nGenerate meals only as specified above. Use empty meals object {} when no meals are specified.`;
}

/**
 * Builds personalization context from user profile
 */
function buildPersonalizationContext(userContext) {
  const { userProfile } = userContext;
  
  if (!userProfile || !userProfile.dataQuality?.hasGoodData) {
    return "User Profile: New user with limited data. Use general healthy meal recommendations.";
  }

  const sections = [];
  
  // Cooking patterns
  if (userProfile.cookingPatterns) {
    sections.push(`Cooking Style: ${userProfile.cookingPatterns.frequency} cook, prefers ${userProfile.complexityPreference} recipes`);
  }

  // Preferred ingredients
  if (userProfile.preferredIngredients?.length > 0) {
    const ingredients = userProfile.preferredIngredients.slice(0, 8).map(i => i.ingredient).join(', ');
    sections.push(`Frequently Used Ingredients: ${ingredients}`);
  }

  // Protein preferences
  if (userProfile.favoriteProteins?.length > 0) {
    const proteins = userProfile.favoriteProteins.slice(0, 5).map(p => p.protein).join(', ');
    sections.push(`Preferred Proteins: ${proteins}`);
  }

  // Cuisine preferences
  if (userProfile.cuisineAffinities?.length > 0) {
    const cuisines = userProfile.cuisineAffinities.slice(0, 4).map(c => c.cuisine).join(', ');
    sections.push(`Favorite Cuisines: ${cuisines}`);
  }

  return sections.join('\n');
}

/**
 * Builds variety context from recent meals
 */
function buildVarietyContext(recentMeals) {
  if (!recentMeals || recentMeals.length === 0) {
    return "Recent Activity: No recent meals tracked. Focus on variety and fresh ideas.";
  }

  const recentTitles = recentMeals.map(meal => meal.title || meal.recipeTitle).filter(Boolean);
  
  if (recentTitles.length === 0) {
    return "Recent Activity: Limited recent meal data. Focus on variety.";
  }

  return `AVOID REPETITION - Recent meals (do not repeat): ${recentTitles.join(', ')}`;
}

/**
 * Builds cookbook context for recipe prioritization
 */
function buildCookbookContext(cookbookRecipes) {
  if (!cookbookRecipes || cookbookRecipes.length === 0) {
    return "Cookbook: No saved recipes. Generate fresh AI meal ideas.";
  }

  const recipeList = cookbookRecipes
    .filter(recipe => recipe.isBookmarked)
    .slice(0, 10)
    .map(recipe => `"${recipe.title}"${recipe.cuisine ? ` (${recipe.cuisine})` : ''}`)
    .join(', ');

  if (!recipeList) {
    return "Cookbook: No bookmarked recipes. Generate fresh AI meal ideas.";
  }

  return `PRIORITIZE THESE COOKBOOK RECIPES: ${recipeList}\n\nIncorporate 40-60% of meals from these saved recipes when possible.`;
}

/**
 * Builds constraints context from preferences
 */
function buildConstraintsContext(preferences) {
  const constraints = [];

  // General goals
  if (preferences.mealPlanObjectives && preferences.mealPlanObjectives.length > 0) {
    constraints.push(`User's goals: ${preferences.mealPlanObjectives.join(', ')}.`);
  }

  // Dietary needs and allergies
  if (preferences.dietaryPreferences && preferences.dietaryPreferences.length > 0) {
    const dietary = preferences.dietaryPreferences.map(pref => pref.rawValue || pref).join(', ');
    constraints.push(`Strictly adhere to these dietary needs: ${dietary}.`);
  }
  if (preferences.allergies && preferences.allergies.length > 0) {
    constraints.push(`CRITICAL ALLERGIES TO AVOID: ${preferences.allergies.join(', ')}.`);
  }

  // Cuisines, kitchen tools, and cooking style
  if (preferences.preferredCuisines && preferences.preferredCuisines.length > 0) {
    constraints.push(`Favorite cuisines: ${preferences.preferredCuisines.join(', ')}.`);
  }
  if (preferences.availableKitchenTools && preferences.availableKitchenTools.length > 0) {
    constraints.push(`IMPORTANT: The user does NOT have the following tools: ${preferences.availableKitchenTools.join(', ')}. Do NOT suggest recipes that require these specific tools.`);
  }
  if (preferences.cookingExperience) {
    constraints.push(`User's cooking skill level: ${preferences.cookingExperience}.`);
  }
  if (preferences.prepVolume) {
    constraints.push(`User prefers a ${preferences.prepVolume} prep volume (cooking for multiple days vs daily).`);
  }
  if (preferences.preppedMealPreference) {
    constraints.push(`User's cooking style is '${preferences.preppedMealPreference}'.`);
  }
  if (preferences.recipeSourcePriority) {
    constraints.push(`Recipe source priority: ${preferences.recipeSourcePriority}.`);
  }
  if (preferences.favoriteGroceryStores && preferences.favoriteGroceryStores.length > 0) {
    constraints.push(`Suggest ingredients commonly found at: ${preferences.favoriteGroceryStores.join(', ')}.`);
  }

  // Per-meal cook time preferences
  if (preferences.breakfastPreferences?.cookTimePreference && preferences.breakfastPreferences.cookTimePreference !== "Doesn't Matter") {
    const timeLimit = getTimeLimit(preferences.breakfastPreferences.cookTimePreference);
    constraints.push(`Breakfasts must be quick, under ${timeLimit}.`);
  }
  if (preferences.lunchPreferences?.cookTimePreference && preferences.lunchPreferences.cookTimePreference !== "Doesn't Matter") {
    const timeLimit = getTimeLimit(preferences.lunchPreferences.cookTimePreference);
    constraints.push(`Lunches must be quick, under ${timeLimit}.`);
  }
  if (preferences.dinnerPreferences?.cookTimePreference && preferences.dinnerPreferences.cookTimePreference !== "Doesn't Matter") {
    const timeLimit = getTimeLimit(preferences.dinnerPreferences.cookTimePreference);
    constraints.push(`Dinners must be quick, under ${timeLimit}.`);
  }

  return constraints.length > 0 ? `\n--- USER CONSTRAINTS ---\n${constraints.join('\n')}\n` : '';
}

/**
 * Helper function to convert cook time preference to time limit string
 * Updated to handle new string-based cook time preferences
 */
function getTimeLimit(cookTimePreference) {
  const timeMapping = {
    'Quick (<10min)': '10 minutes',
    '<30min': '30 minutes',
    'Doesn\'t matter': 'no time limit',
    // Legacy support for old enum values
    'quick': '10 minutes',
    'thirtyMinutes': '30 minutes', 
    'any': 'no time limit'
  };
  return timeMapping[cookTimePreference] || '30 minutes'; // Default fallback
}

/**
 * Makes the AI call for meal plan generation
 */
async function callAiForMealPlan(prompt, userId) {
  const generationConfig = {
    temperature: globalConfig.GEMINI_TEXT_TEMPERATURE || 0.6,
    maxOutputTokens: globalConfig.GEMINI_TEXT_MAX_OUTPUT_TOKENS || 8192,
    responseMimeType: "application/json",
  };

  const startTime = Date.now();
  logger.info("generateMealPlan: Calling AI for complete plan", { userId });

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
  logger.info("generateMealPlan: AI call completed", {
    userId,
    duration: `${(endTime - startTime) / 1000}s`
  });

  if (!modelResponse.candidates?.[0]?.content?.parts?.[0]?.text) {
    logger.error("generateMealPlan: AI response was empty or malformed", { userId, modelResponse });
    throw new HttpsError("internal", "AI service returned an empty or malformed response");
  }

  const aiResponseText = modelResponse.candidates[0].content.parts[0].text;
  logger.info("generateMealPlan: Received AI response", {
    userId,
    responseLength: aiResponseText.length
  });

  try {
    // Strip markdown formatting if present (```json ... ```)
    let cleanedResponse = aiResponseText.trim();
    if (cleanedResponse.startsWith('```json')) {
      cleanedResponse = cleanedResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleanedResponse.startsWith('```')) {
      cleanedResponse = cleanedResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }
    
    const parsedResponse = JSON.parse(cleanedResponse);
    if (!parsedResponse.plan || !Array.isArray(parsedResponse.plan)) {
      throw new Error("AI response missing 'plan' array");
    }
    return parsedResponse;
  } catch (parseError) {
    logger.error("generateMealPlan: Failed to parse AI response", {
      userId,
      parseError: parseError.message,
      responseText: aiResponseText.substring(0, 500)
    });
    throw new HttpsError("internal", "Failed to parse AI response. AI may not have returned valid JSON");
  }
}

/**
 * Transforms AI response to MealPlanDocument
 */
function transformAiResponseToMealPlan(aiResponse, preferences, startDate, userId) {
  const planId = generatePlanId();
  const now = new Date().toISOString();
  
  // Calculate batch servings based on prep volume
  const getBatchServings = () => {
    if (preferences.prepVolume === 'batchPrep') {
      const cookingDays = preferences.availableCookingDays?.length || 7;
      return Math.ceil(7 / cookingDays); // Days of food per cooking session
    }
    return 1.0; // Individual servings for meal-by-meal
  };
  
  const batchServings = getBatchServings();
  
  // Transform AI days to DayPlan format
  const dayPlans = aiResponse.plan.map((aiDay, index) => {
    const dayDate = new Date(startDate);
    dayDate.setDate(startDate.getDate() + index);
    const dateString = dayDate.toISOString().split('T')[0];
    
    // Transform meals
    const meals = {};
    for (const [mealType, mealItems] of Object.entries(aiDay.meals || {})) {
      meals[mealType] = mealItems.map(item => ({
        id: generateItemId(),
        recipeId: null,
        title: item.title,
        estimatedMacros: item.estimatedMacros,
        servings: batchServings, // Use calculated batch servings
        isStub: true,
        source: 'stub',
        keyIngredients: item.keyIngredients || []
      }));
    }

    return {
      date: dateString,
      dayOfWeek: aiDay.dayOfWeek,
      meals,
      dailyTotals: aiDay.dailyTotals || { calories: 0, protein: 0, carbs: 0, fat: 0 }
    };
  });

  // Calculate end date
  const endDate = new Date(startDate);
  endDate.setDate(startDate.getDate() + (preferences.planDurationWeeks * 7) - 1);

  return {
    planId,
    userId,
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
    name: `AI Meal Plan - ${new Date().toLocaleDateString()}`,
    days: dayPlans,
    createdAt: now,
    updatedAt: now
  };
}

/**
 * Helper functions
 */
function getWeekAlignedStartDate(date) {
  const weekdayOfDate = date.getDay(); // 0 = Sunday, 1 = Monday, etc.
  
  // If it's already Sunday (0), don't subtract any days
  // Otherwise, find the most recent Sunday
  const daysToSubtract = weekdayOfDate === 0 ? 0 : weekdayOfDate;
  
  const weekAlignedDate = new Date(date);
  weekAlignedDate.setDate(date.getDate() - daysToSubtract);
  weekAlignedDate.setHours(0, 0, 0, 0);
  
  return weekAlignedDate;
}

function generatePlanId() {
  // Generate UUID-style ID compatible with Swift UUID
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function generateItemId() {
  // Generate UUID-style ID compatible with Swift UUID
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

module.exports = { generateMealPlan }; 