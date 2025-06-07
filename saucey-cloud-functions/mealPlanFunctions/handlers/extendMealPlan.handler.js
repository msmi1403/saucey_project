const functions = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const { HttpsError } = require("firebase-functions/v2/https");
const geminiClient = require("@saucey/shared/services/geminiClient");
const globalConfig = require("@saucey/shared/config/globalConfig");
const fs = require('fs');
const path = require('path');

const FIXED_DURATION_DAYS_PER_CHUNK = 7;

/**
 * @fileoverview Handler for extending existing meal plans with a single new week.
 * Used for rolling meal plan functionality where expired weeks are dropped and new weeks added.
 */

/**
 * Extends an existing meal plan by generating a single new week.
 * @param {object} data - The data sent by the client.
 * @param {object} data.params - Parameters for extending the meal plan.
 * @param {Date} data.params.newWeekStartDate - Start date for the new week to generate.
 * @param {object} data.params.preferences - Current user preferences for meal generation.
 * @param {string} data.params.userId - User ID for the request.
 * @param {functions.https.CallableRequest} request - Firebase callable function request context.
 * @returns {Promise<{generatedWeek: AiGeneratedPlan}>} The AI-generated week plan.
 * @throws {HttpsError} Throws HttpsError for auth, validation, AI errors, or internal errors.
 */
const extendMealPlan = functions.onCall({ timeoutSeconds: 180 }, async (request) => {
  logger.info("extendMealPlan: Called from handler", { data: request.data });

  if (!request.auth) {
    logger.warn("extendMealPlan: Unauthenticated access attempt.");
    throw new HttpsError("unauthenticated", "The function must be called while authenticated.");
  }
  const userId = request.auth.uid;

  let { params } = request.data;

  if (!params || typeof params !== 'object') {
    logger.warn(`extendMealPlan: Client did not send params object or it's invalid. UserId: ${userId}`);
    throw new HttpsError("invalid-argument", "Params object is missing or invalid.", { userId });
  }

  // Validate required parameters
  if (!params.newWeekStartDate || !params.preferences || !params.userId) {
    logger.warn("extendMealPlan: Missing required parameters.", { userId, params });
    throw new HttpsError("invalid-argument", "Missing required parameters: newWeekStartDate, preferences, userId.");
  }

  logger.info(`extendMealPlan: Generating new week starting ${params.newWeekStartDate} for user ${userId}.`);

  let fullPrompt = fs.readFileSync(path.join(__dirname, '../prompts/aiPlanGenerator.prompt.txt'), 'utf8');
  
  // Replace duration placeholder
  fullPrompt = fullPrompt.replace('{{durationDays}}', FIXED_DURATION_DAYS_PER_CHUNK.toString());

  // Add context for single week extension
  const weekContextPrompt = `This is a new week being added to extend an existing meal plan. Generate fresh, varied meal ideas for this 7-day period.`;

  let targetMacrosPrompt = "";
  if (params.preferences.macroTargets) {
    let macroString = "Aim for these daily target macronutrients (approximate):";
    if (params.preferences.macroTargets.calories) macroString += ` ~${params.preferences.macroTargets.calories} kcal;`;
    if (params.preferences.macroTargets.protein) macroString += ` ~${params.preferences.macroTargets.protein}g protein;`;
    if (params.preferences.macroTargets.carbs) macroString += ` ~${params.preferences.macroTargets.carbs}g carbs;`;
    if (params.preferences.macroTargets.fat) macroString += ` ~${params.preferences.macroTargets.fat}g fat;`;
    targetMacrosPrompt = macroString;
  }
  fullPrompt = fullPrompt.replace('{{targetMacrosPrompt}}', targetMacrosPrompt);

  // Determine meal types to include
  let includeMealTypesPrompt = "";
  const mealTypesToInclude = [];
  if (params.preferences.includeBreakfast) mealTypesToInclude.push("breakfast");
  if (params.preferences.includeLunch) mealTypesToInclude.push("lunch");
  if (params.preferences.includeDinner) mealTypesToInclude.push("dinner");
  
  if (mealTypesToInclude.length > 0) {
    includeMealTypesPrompt = `Include these meal types: ${mealTypesToInclude.join(", ")}.`;
  } else {
    includeMealTypesPrompt = "Include dinner by default.";
    mealTypesToInclude.push("dinner");
  }

  // Calculate specific cooking days for this week
  let dayByDayInstructions = "";
  if (params.preferences.availableCookingDays && params.preferences.availableCookingDays.length > 0) {
    const cookingDays = params.preferences.availableCookingDays;
    const allDaysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    
    const newWeekStartDate = new Date(params.newWeekStartDate);
    newWeekStartDate.setHours(0, 0, 0, 0);
    
    // Generate day-by-day instructions for this specific week
    const dateSpecificInstructions = [];
    const daysToInclude = [];
    const daysToSkip = [];
    
    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
      const currentDayDate = new Date(newWeekStartDate);
      currentDayDate.setDate(newWeekStartDate.getDate() + dayIndex);
      
      const dayName = allDaysOfWeek[currentDayDate.getDay()];
      const isCookingDay = cookingDays.includes(dayName);
      
      const dateString = currentDayDate.toLocaleDateString('en-US', { 
        weekday: 'long', 
        month: 'short', 
        day: 'numeric' 
      });
      
      if (isCookingDay) {
        daysToInclude.push(`${dayName} (${dateString})`);
        dateSpecificInstructions.push(`✅ ${dayName}, ${dateString}: GENERATE FULL MEALS`);
      } else {
        daysToSkip.push(`${dayName} (${dateString}) - not a cooking day`);
        dateSpecificInstructions.push(`❌ ${dayName}, ${dateString}: EMPTY MEALS (not a cooking day)`);
      }
    }
    
    logger.info(`extendMealPlan: Week starts ${newWeekStartDate.toISOString().split('T')[0]}, cooking days: ${cookingDays}`);
    logger.info(`extendMealPlan: Days to include: ${daysToInclude.join(', ')}`);
    
    dayByDayInstructions = `

🎯 EXACT GENERATION INSTRUCTIONS FOR THIS NEW WEEK:

Week starts: ${newWeekStartDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}

SPECIFIC DAY-BY-DAY INSTRUCTIONS:
${dateSpecificInstructions.join('\n')}

SUMMARY:
- GENERATE MEALS FOR: ${daysToInclude.length > 0 ? daysToInclude.join(", ") : "NO DAYS (no cooking days in this week)"}
- LEAVE EMPTY: ${daysToSkip.map(d => d.split(' (')[0]).join(", ")}

Your JSON response must include entries for all 7 days:
${Array.from({length: 7}, (_, idx) => {
  const currentDayDate = new Date(newWeekStartDate);
  currentDayDate.setDate(newWeekStartDate.getDate() + idx);
  const day = allDaysOfWeek[currentDayDate.getDay()];
  const shouldHaveMeals = cookingDays.includes(day);
  
  return `{"dayOfWeek": "${day}", "meals": ${shouldHaveMeals ? '{"dinner": [{"title": "Recipe Name", ...}]}' : '{}'}}`;
}).join(',\n')}`;
  }
  
  fullPrompt = fullPrompt.replace('{{includeMealTypesPrompt}}', includeMealTypesPrompt);
  fullPrompt = fullPrompt.replace('{{weekContext}}', weekContextPrompt + dayByDayInstructions);

  // Handle other preference prompts
  let numberOfSnacksPrompt = "";
  fullPrompt = fullPrompt.replace('{{numberOfSnacksPrompt}}', numberOfSnacksPrompt);
  
  let dietaryNotesPrompt = "";
  if (params.preferences.dietaryPreferences) {
    dietaryNotesPrompt = `Dietary considerations: ${params.preferences.dietaryPreferences.join(", ")}.`;
  }
  fullPrompt = fullPrompt.replace('{{dietaryNotesPrompt}}', dietaryNotesPrompt);

  let cuisinePreferencePrompt = "";
  if (params.preferences.preferredCuisines && params.preferences.preferredCuisines.length > 0) {
    cuisinePreferencePrompt = `Preferred cuisines: ${params.preferences.preferredCuisines.join(", ")}.`;
  }
  fullPrompt = fullPrompt.replace('{{cuisinePreferencePrompt}}', cuisinePreferencePrompt);

  let maxPrepTimePrompt = "";
  if (params.preferences.cookTimePreference) {
    const timeMapping = {
      'fifteenMinutes': 15,
      'thirtyMinutes': 30,
      'fortyFiveMinutes': 45,
      'oneHour': 60
    };
    const maxTime = timeMapping[params.preferences.cookTimePreference] || 30;
    maxPrepTimePrompt = `Aim for a maximum prep time of ${maxTime} minutes per meal.`;
  }
  fullPrompt = fullPrompt.replace('{{maxPrepTimePrompt}}', maxPrepTimePrompt);
  fullPrompt = fullPrompt.split('\n').filter(line => line.trim() !== '').join('\n');

  logger.info(`extendMealPlan: Constructed prompt for new week`, { userId, promptLength: fullPrompt.length });

  try {
    const generationConfig = {
      temperature: globalConfig.GEMINI_TEXT_TEMPERATURE || 0.6,
      maxOutputTokens: globalConfig.GEMINI_TEXT_MAX_OUTPUT_TOKENS || 8192,
      responseMimeType: "application/json",
    };

    const startTime = Date.now();
    logger.info(`extendMealPlan: Calling AI for new week generation...`, { userId });

    const modelResponse = await geminiClient.generateContent({
      modelName: globalConfig.GEMINI_MODEL_NAME,
      contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
      generationConfig,
      safetySettings: globalConfig.GEMINI_SAFETY_SETTINGS.map(s => ({
        category: geminiClient.HarmCategory[s.category],
        threshold: geminiClient.HarmBlockThreshold[s.threshold],
      })),
    });
    
    const endTime = Date.now();
    logger.info(`extendMealPlan: AI call completed. Duration: ${(endTime - startTime) / 1000}s.`, { userId });

    if (!modelResponse.candidates || modelResponse.candidates.length === 0 || !modelResponse.candidates[0].content || !modelResponse.candidates[0].content.parts || !modelResponse.candidates[0].content.parts[0].text) {
      logger.error(`extendMealPlan: AI response was empty or malformed.`, { userId, modelResponse });
      throw new HttpsError("internal", `AI service returned an empty or malformed response.`);
    }

    const aiResponseText = modelResponse.candidates[0].content.parts[0].text;
    logger.info(`extendMealPlan: Received raw text from AI.`, { userId, first100Chars: aiResponseText.substring(0,100) });

    let generatedWeek;
    try {
      generatedWeek = JSON.parse(aiResponseText);
      if (!generatedWeek.plan || !Array.isArray(generatedWeek.plan)) {
        throw new Error(`Parsed AI response is missing 'plan' array or it's not an array.`);
      }
    } catch (parseError) {
      logger.error(`extendMealPlan: Failed to parse AI JSON response.`, { userId, parseError, aiResponseText });
      throw new HttpsError("internal", `Failed to parse AI response. AI may not have returned valid JSON.`, { aiRawOutput: aiResponseText });
    }

    logger.info(`extendMealPlan: Successfully processed new week. Days in week: ${generatedWeek.plan.length}`, { userId });

    return { generatedWeek: generatedWeek };

  } catch (error) {
    const errorTime = Date.now();
    logger.error(`extendMealPlan: Error during AI meal plan extension.`, {
      userId,
      errorMessage: error.message,
      errorStack: error.stack,
      isHttpsError: error instanceof HttpsError,
      errorDetails: error.details,
    });
    
    if (error instanceof HttpsError) throw error;
    
    let clientMsg = `An unexpected error occurred while extending meal plan.`;
    if (error.message && error.message.includes("SAFETY")) clientMsg = `The meal plan extension request was blocked by AI safety filters.`;
    else if (error.message && error.message.includes("quota")) clientMsg = `The AI service quota was exceeded. Please try again later.`;
    
    throw new HttpsError("internal", clientMsg, { originalError: error.message });
  }
});

module.exports = { extendMealPlan }; 