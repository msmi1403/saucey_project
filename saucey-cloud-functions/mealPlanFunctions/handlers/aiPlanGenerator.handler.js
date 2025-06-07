const functions = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const { HttpsError } = require("firebase-functions/v2/https");
const geminiClient = require("@saucey/shared/services/geminiClient");
const globalConfig = require("@saucey/shared/config/globalConfig");
const { validateGenerateAiMealPlanChunkParams } = require("../utils/validationHelper");
const { UserPreferenceAnalyzer } = require("../services/userPreferenceAnalyzer");
const { CookbookRecipeSelector } = require("../services/cookbookRecipeSelector");
const { MealVarietyTracker } = require("../services/mealVarietyTracker");
const UserPreferenceCacheManager = require("../services/userPreferenceCacheManager");
const PromptPersonalizationFormatter = require("../utils/promptPersonalizationFormatter");
const fs = require('fs');
const path = require('path');

const FIXED_TOTAL_CHUNKS_FOR_CONTEXT = 5; // e.g., a 5-week plan context
const FIXED_DURATION_DAYS_PER_CHUNK = 7;

/**
 * @fileoverview Handler for the aiPlanGenerator Firebase Callable Function.
 * This function now generates a single chunk (e.g., one week) of a meal plan.
 * @see /saucey-cloud-functions/mealPlanFunctions/types.js for type definitions (GenerateAiMealPlanParams, AiGeneratedPlan)
 */

/**
 * Generates a single chunk of a meal plan using AI based on user parameters and a chunk index.
 * @param {object} data - The data sent by the client.
 * @param {GenerateAiMealPlanParams} data.params - Parameters for AI meal plan generation.
 * @param {number} data.params.chunkIndex - The 0-based index of the chunk to generate.
 * @param {functions.https.CallableRequest} request - Firebase callable function request context.
 * @returns {Promise<{generatedPlanChunk: AiGeneratedPlan}>} The AI-generated meal plan chunk.
 * @throws {HttpsError} Throws HttpsError for auth, validation, AI errors, or internal errors.
 */
const aiPlanGenerator = functions.onCall({ timeoutSeconds: 300 }, async (request) => {
  logger.info("aiPlanGenerator (chunk mode): Called from handler", { data: request.data });

  if (!request.auth) {
    logger.warn("aiPlanGenerator (chunk mode): Unauthenticated access attempt.");
    throw new HttpsError("unauthenticated", "The function must be called while authenticated.");
  }
  const userId = request.auth.uid;

  // Initialize services
  const userPreferenceAnalyzer = new UserPreferenceAnalyzer();
  const cookbookRecipeSelector = new CookbookRecipeSelector();
  const mealVarietyTracker = new MealVarietyTracker();
  const preferenceCache = new UserPreferenceCacheManager();
  const promptFormatter = new PromptPersonalizationFormatter();

  let { params } = request.data;

  if (!params || typeof params !== 'object') {
    logger.warn(`aiPlanGenerator (chunk mode): Client did not send params object or it's invalid. UserId: ${userId}`);
    throw new HttpsError("invalid-argument", "Params object is missing or invalid.", { userId });
  }

  // chunkIndex and totalChunks are now required parameters from the client.
  // Validation for these (and others) is handled by validateGenerateAiMealPlanChunkParams

  const validation = validateGenerateAiMealPlanChunkParams(params, FIXED_TOTAL_CHUNKS_FOR_CONTEXT); 
  if (!validation.isValid) {
    logger.warn("aiPlanGenerator (chunk mode): Invalid parameters.", { userId, errors: validation.errors, params });
    throw new HttpsError("invalid-argument", "Invalid parameters for AI meal plan generation.", { errors: validation.errors });
  }

  const chunkIndex = params.chunkIndex;
  // const totalChunks = params.totalChunks; // No longer from client for AI context
  const dayOffset = chunkIndex * FIXED_DURATION_DAYS_PER_CHUNK;

  logger.info(`aiPlanGenerator (chunk mode): Generating chunk ${chunkIndex}/${FIXED_TOTAL_CHUNKS_FOR_CONTEXT -1} (${FIXED_DURATION_DAYS_PER_CHUNK} days, starting global day ${dayOffset + 1}).`, { userId });

  // PHASE 1: Get User Preference Profile (with caching)
  logger.info(`aiPlanGenerator: Getting user preference profile for ${userId}`);
  const userProfile = await preferenceCache.getCachedUserPreferences(
    userId, 
    userPreferenceAnalyzer.generateUserPreferenceProfile.bind(userPreferenceAnalyzer)
  );
  
  // PHASE 2: Get Recent Meals for Variety Tracking
  logger.info(`aiPlanGenerator: Fetching recent meals for variety tracking`);
  const recentMeals = await mealVarietyTracker.getRecentlyUsedRecipes(userId, 4);
  
  // PHASE 3: Calculate Recipe Distribution
  const recipeSourcePriority = params.preferences?.recipeSourcePriority || 'balancedMix';
  const totalMealSlots = calculateTotalMealSlots(params);
  const { cookbookCount, aiCount } = cookbookRecipeSelector.calculateRecipeDistribution(recipeSourcePriority, totalMealSlots);
  
  logger.info(`aiPlanGenerator: Recipe distribution - ${cookbookCount} cookbook, ${aiCount} AI recipes`);
  
  // PHASE 4: Select Optimal Cookbook Recipes
  const mealContext = {
    targetMacros: params.targetMacros,
    mealTypes: params.mealTypesToInclude,
    maxCookTime: params.maxPrepTimePerMealMinutes,
    cuisinePreference: params.cuisinePreference
  };
  
  const recentRecipeIds = recentMeals.map(meal => meal.recipeId).filter(Boolean);
  const selectedCookbookRecipes = await cookbookRecipeSelector.selectOptimalCookbookRecipes(
    userId, 
    cookbookCount, 
    userProfile, 
    mealContext, 
    recentRecipeIds
  );

    let fullPrompt = fs.readFileSync(path.join(__dirname, '../prompts/aiPlanGenerator.prompt.txt'), 'utf8');
    
  // Replace duration placeholder
  fullPrompt = fullPrompt.replace('{{durationDays}}', FIXED_DURATION_DAYS_PER_CHUNK.toString());

  // Add week context for the AI - DON'T replace yet, wait until we have cooking constraints
  const weekContextPrompt = `This is for Week ${chunkIndex + 1} of ${FIXED_TOTAL_CHUNKS_FOR_CONTEXT}. Please generate meal ideas primarily for this segment.`

    let targetMacrosPrompt = "";
    if (params.targetMacros) {
      let macroString = "Aim for these daily target macronutrients (approximate):";
      if (params.targetMacros.calories) macroString += ` ~${params.targetMacros.calories} kcal;`;
      if (params.targetMacros.protein) macroString += ` ~${params.targetMacros.protein}g protein;`;
      if (params.targetMacros.carbs) macroString += ` ~${params.targetMacros.carbs}g carbs;`;
      if (params.targetMacros.fat) macroString += ` ~${params.targetMacros.fat}g fat;`;
      targetMacrosPrompt = macroString;
    }
    fullPrompt = fullPrompt.replace('{{targetMacrosPrompt}}', targetMacrosPrompt);

    let includeMealTypesPrompt = "";
    if (params.mealTypesToInclude && params.mealTypesToInclude.length > 0) {
      includeMealTypesPrompt = `Include these meal types: ${params.mealTypesToInclude.join(", ")}.`;
    } else {
      includeMealTypesPrompt = "Include breakfast, lunch, and dinner by default.";
    }
    
    // Calculate specific cooking days for this week chunk and create explicit day-by-day instructions
    let dayByDayInstructions = "";
    if (params.preferences && params.preferences.availableCookingDays && params.preferences.availableCookingDays.length > 0) {
      const cookingDays = params.preferences.availableCookingDays;
      const allDaysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      
      // FIXED: Use consistent week-aligned date calculation
      let planStartDate;
      if (params.planStartDate) {
        planStartDate = new Date(params.planStartDate);
        planStartDate.setHours(0, 0, 0, 0); // Normalize to start of day
      } else {
        // Fallback to server date calculation (for backward compatibility)
        planStartDate = new Date();
        planStartDate.setHours(0, 0, 0, 0);
      }
      
      // FIXED: Calculate week-aligned start date (always Sunday)
      // This should match the Swift getWeekAlignedStartDate logic
      const weekAlignedStartDate = getWeekAlignedStartDate(planStartDate);
      
      // FIXED: Calculate the start date for this chunk based on the week-aligned start date
      // Each chunk represents a consecutive 7-day period starting from week-aligned Sunday
      const chunkStartDate = new Date(weekAlignedStartDate);
      chunkStartDate.setDate(weekAlignedStartDate.getDate() + (chunkIndex * 7));
      
      // Generate day-by-day instructions with specific dates
      const dateSpecificInstructions = [];
      const daysToInclude = [];
      const daysToSkip = [];
      
      for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
        const currentDayDate = new Date(chunkStartDate);
        currentDayDate.setDate(chunkStartDate.getDate() + dayIndex);
        
        // Get the actual day name for this calendar date
        const dayName = allDaysOfWeek[currentDayDate.getDay()];
        
        // Use the centralized helper function (ready for vacation days)
        const shouldGenerateMeals = shouldGenerateMealsForDate(currentDayDate, cookingDays, planStartDate);
        
        // Format date as readable string
        const dateString = currentDayDate.toLocaleDateString('en-US', { 
          weekday: 'long', 
          month: 'short', 
          day: 'numeric' 
        });
        
        if (shouldGenerateMeals) {
          daysToInclude.push(`${dayName} (${dateString})`);
          dateSpecificInstructions.push(`✅ ${dayName}, ${dateString}: GENERATE FULL MEALS`);
        } else {
          // Determine reason for skipping
          const isCurrentDateInFuture = currentDayDate >= planStartDate;
          const isCookingDay = cookingDays.includes(dayName);
          
          let reason;
          if (!isCookingDay) {
            reason = 'not a cooking day';
          } else if (!isCurrentDateInFuture) {
            reason = 'in the past';
          } else {
            reason = 'vacation day'; // For future use
          }
          
          daysToSkip.push(`${dayName} (${dateString}) - ${reason}`);
          dateSpecificInstructions.push(`❌ ${dayName}, ${dateString}: EMPTY MEALS (${reason})`);
        }
      }
      
      logger.info(`aiPlanGenerator: Chunk ${chunkIndex}, cooking days: ${cookingDays}, week-aligned start: ${weekAlignedStartDate.toISOString().split('T')[0]}, chunk week starts: ${chunkStartDate.toISOString().split('T')[0]}`);
      logger.info(`aiPlanGenerator: Days to include: ${daysToInclude.join(', ')}`);
      logger.info(`aiPlanGenerator: Original plan start date: ${planStartDate.toISOString().split('T')[0]}, Week-aligned start: ${weekAlignedStartDate.toISOString().split('T')[0]}, Chunk ${chunkIndex} dates: ${chunkStartDate.toISOString().split('T')[0]} to ${new Date(chunkStartDate.getTime() + 6 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}`);
      
      dayByDayInstructions = `

🎯 EXACT GENERATION INSTRUCTIONS FOR THIS WEEK (Week ${chunkIndex + 1}):

Week starts: ${chunkStartDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}

SPECIFIC DAY-BY-DAY INSTRUCTIONS:
${dateSpecificInstructions.join('\n')}

SUMMARY:
- GENERATE MEALS FOR: ${daysToInclude.length > 0 ? daysToInclude.join(", ") : "NO DAYS (no future cooking days in this week)"}
- LEAVE EMPTY: ${daysToSkip.map(d => d.split(' (')[0]).join(", ")}

Your JSON response must include entries for all 7 days:
${Array.from({length: 7}, (_, idx) => {
  const currentDayDate = new Date(chunkStartDate);
  currentDayDate.setDate(chunkStartDate.getDate() + idx);
  const day = allDaysOfWeek[currentDayDate.getDay()];
  const shouldHaveMeals = shouldGenerateMealsForDate(currentDayDate, cookingDays, planStartDate);
  
  return `{"dayOfWeek": "${day}", "meals": ${shouldHaveMeals ? '{"dinner": [{"title": "Recipe Name", ...}]}' : '{}'}}`;
}).join(',\n')}`;
    }
    
    fullPrompt = fullPrompt.replace('{{includeMealTypesPrompt}}', includeMealTypesPrompt);
    fullPrompt = fullPrompt.replace('{{weekContext}}', weekContextPrompt + dayByDayInstructions);

    let numberOfSnacksPrompt = "";
    if (params.numberOfSnacks && params.numberOfSnacks > 0) {
      if (params.preferences && params.preferences.availableCookingDays && params.preferences.availableCookingDays.length > 0) {
        numberOfSnacksPrompt = `Include ${params.numberOfSnacks} snack(s) per day, but only on days where meals are being generated.`;
      } else {
        numberOfSnacksPrompt = `Include ${params.numberOfSnacks} snack(s) per day.`;
      }
    }
    fullPrompt = fullPrompt.replace('{{numberOfSnacksPrompt}}', numberOfSnacksPrompt);
    
    let dietaryNotesPrompt = "";
    if (params.dietaryNotes) {
      dietaryNotesPrompt = `Dietary considerations: ${params.dietaryNotes}.`;
    }
    fullPrompt = fullPrompt.replace('{{dietaryNotesPrompt}}', dietaryNotesPrompt);

    let cuisinePreferencePrompt = "";
    if (params.cuisinePreference) {
      cuisinePreferencePrompt = `Preferred cuisines: ${params.cuisinePreference}.`;
    }
    fullPrompt = fullPrompt.replace('{{cuisinePreferencePrompt}}', cuisinePreferencePrompt);

    let maxPrepTimePrompt = "";
    if (params.maxPrepTimePerMealMinutes) {
      maxPrepTimePrompt = `Aim for a maximum prep time of ${params.maxPrepTimePerMealMinutes} minutes per meal.`;
    }
    fullPrompt = fullPrompt.replace('{{maxPrepTimePrompt}}', maxPrepTimePrompt);
    
    // PHASE 5: Generate Optimized Personalization Context
    const varietyGuidance = mealVarietyTracker.generateVarietyGuidanceForPrompt(recentMeals);
    
    // Use new compact formatter
    const personalizationPrompt = promptFormatter.formatPersonalizationPrompt(
      userProfile, 
      selectedCookbookRecipes, 
      varietyGuidance
    );
    
    // Log token efficiency metrics
    const estimatedTokens = promptFormatter.estimateTokenCount(personalizationPrompt);
    logger.info(`aiPlanGenerator: Personalization section - ${estimatedTokens} tokens, ${personalizationPrompt.length} chars`);
    
    // Fallback to natural language if structured format is too dense
    const finalPersonalizationPrompt = promptFormatter.isWithinTokenLimits(personalizationPrompt) 
      ? personalizationPrompt
      : promptFormatter.formatNaturalLanguagePrompt(userProfile, selectedCookbookRecipes);
    
    fullPrompt = fullPrompt.replace('{{personalizationPrompt}}', finalPersonalizationPrompt);
    fullPrompt = fullPrompt.split('\n').filter(line => line.trim() !== '').join('\n');

  logger.info(`aiPlanGenerator (chunk mode): Constructed prompt for chunk ${chunkIndex} (days ${dayOffset + 1}-${dayOffset + FIXED_DURATION_DAYS_PER_CHUNK})`, { userId, promptLength: fullPrompt.length, weekContext: weekContextPrompt });

    try {
      const generationConfig = {
        temperature: globalConfig.GEMINI_TEXT_TEMPERATURE || 0.6,
        maxOutputTokens: globalConfig.GEMINI_TEXT_MAX_OUTPUT_TOKENS || 8192, // Ensured this uses the larger token limit
        responseMimeType: "application/json",
      };

      const chunkStartTime = Date.now();
    logger.info(`aiPlanGenerator (chunk mode): [CHUNK ${chunkIndex}] Calling AI...`, { userId });

      const modelResponse = await geminiClient.generateContent({
        modelName: globalConfig.GEMINI_MODEL_NAME,
        contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
        generationConfig,
        safetySettings: globalConfig.GEMINI_SAFETY_SETTINGS.map(s => ({
          category: geminiClient.HarmCategory[s.category],
          threshold: geminiClient.HarmBlockThreshold[s.threshold],
        })),
      });
      const chunkEndTime = Date.now();
    logger.info(`aiPlanGenerator (chunk mode): [CHUNK ${chunkIndex}] AI call completed. Duration: ${(chunkEndTime - chunkStartTime) / 1000}s.`, { userId });

      if (!modelResponse.candidates || modelResponse.candidates.length === 0 || !modelResponse.candidates[0].content || !modelResponse.candidates[0].content.parts || !modelResponse.candidates[0].content.parts[0].text) {
      logger.error(`aiPlanGenerator (chunk mode): AI response was empty or malformed for chunk ${chunkIndex}.`, { userId, modelResponse });
      throw new HttpsError("internal", `AI service returned an empty or malformed response for chunk ${chunkIndex} (handler).`);
      }

      const aiResponseText = modelResponse.candidates[0].content.parts[0].text;
    logger.info(`aiPlanGenerator (chunk mode): Received raw text from AI for chunk ${chunkIndex}.`, { userId, first100Chars: aiResponseText.substring(0,100) });

    let generatedChunkPlan;
      try {
      generatedChunkPlan = JSON.parse(aiResponseText);
      if (!generatedChunkPlan.plan || !Array.isArray(generatedChunkPlan.plan)) {
        throw new Error(`Parsed AI response for chunk ${chunkIndex} is missing 'plan' array or it's not an array.`);
        }
      } catch (parseError) {
      logger.error(`aiPlanGenerator (chunk mode): Failed to parse AI JSON response for chunk ${chunkIndex}.`, { userId, parseError, aiResponseText });
      throw new HttpsError("internal", `Failed to parse AI response for chunk ${chunkIndex}. AI may not have returned valid JSON (handler).`, { aiRawOutput: aiResponseText });
      }
      
      // Keep original day names but log the mapping for debugging
      generatedChunkPlan.plan.forEach((dayPlan, index) => {
        const globalDayNumber = dayOffset + index + 1;
        // Don't overwrite the dayOfWeek - keep Sunday, Monday, etc. as specified by AI
        logger.info(`aiPlanGenerator (chunk mode): Chunk day ${index+1} (${dayPlan.dayOfWeek}) maps to global Day ${globalDayNumber}`, {userId}); 
      });

    logger.info(`aiPlanGenerator (chunk mode): Successfully processed chunk ${chunkIndex}. Days in chunk: ${generatedChunkPlan.plan.length}`, { userId });

    return { generatedPlanChunk: generatedChunkPlan }; // Return the single generated chunk

    } catch (error) {
      const errorTime = Date.now();
    const durationString = chunkStartTime ? `Duration of failed/partial chunk ${chunkIndex}: ${(errorTime - chunkStartTime) / 1000}s.` : `Chunk ${chunkIndex} start time not recorded.`;
    logger.error(`aiPlanGenerator (chunk mode): Error during AI meal plan generation for chunk ${chunkIndex}. ${durationString}`, {
        userId,
        errorMessage: error.message,
        errorStack: error.stack,
        isHttpsError: error instanceof HttpsError,
        errorDetails: error.details,
      });
    if (error instanceof HttpsError) throw error;
    let clientMsg = `An unexpected error occurred while generating AI meal plan for chunk ${chunkIndex} (handler).`;
    if (error.message && error.message.includes("SAFETY")) clientMsg = `The meal plan request for chunk ${chunkIndex} was blocked by AI safety filters (handler).`;
    else if (error.message && error.message.includes("quota")) clientMsg = `The AI service quota was exceeded for chunk ${chunkIndex}. Please try again later (handler).`;
      throw new HttpsError("internal", clientMsg, { originalError: error.message });
  }
});

// ADDED: Helper function to get week-aligned start date (always Sunday)
// This matches the Swift getWeekAlignedStartDate logic
function getWeekAlignedStartDate(date) {
  const weekdayOfDate = date.getDay(); // 0 = Sunday, 1 = Monday, etc.
  
  // Always start weeks on Sunday (day = 0)
  const daysToSubtract = weekdayOfDate; // If it's Sunday (0), subtract 0. If Monday (1), subtract 1, etc.
  
  const weekAlignedDate = new Date(date);
  weekAlignedDate.setDate(date.getDate() - daysToSubtract);
  weekAlignedDate.setHours(0, 0, 0, 0); // Normalize to start of day
  
  return weekAlignedDate;
}

// ADDED: Helper function to determine if a date should have meals generated
// This centralizes the logic for future vacation day functionality
function shouldGenerateMealsForDate(date, cookingDays, planStartDate, vacationDates = []) {
  const allDaysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayName = allDaysOfWeek[date.getDay()];
  
  // Check if this date is in the future (including today)
  const isCurrentDateInFuture = date >= planStartDate;
  
  // Check if this is a cooking day
  const isCookingDay = cookingDays.includes(dayName);
  
  // Check if this date is a vacation day (for future implementation)
  const isVacationDay = vacationDates.some(vacationDate => {
    return date.getTime() === vacationDate.getTime();
  });
  
  // Generate meals if: cooking day AND future/today AND not vacation
  return isCookingDay && isCurrentDateInFuture && !isVacationDay;
}

// Helper function to calculate total meal slots needed
function calculateTotalMealSlots(params) {
  const mealTypes = params.mealTypesToInclude || ['breakfast', 'lunch', 'dinner'];
  const cookingDays = params.preferences?.availableCookingDays || ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  
  // Calculate how many days this week will have meals
  let activeDays = 0;
  if (params.planStartDate && cookingDays.length > 0) {
    const planStartDate = new Date(params.planStartDate);
    const weekAlignedStartDate = getWeekAlignedStartDate(planStartDate);
    const chunkStartDate = new Date(weekAlignedStartDate);
    chunkStartDate.setDate(weekAlignedStartDate.getDate() + (params.chunkIndex * 7));
    
    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
      const currentDayDate = new Date(chunkStartDate);
      currentDayDate.setDate(chunkStartDate.getDate() + dayIndex);
      
      if (shouldGenerateMealsForDate(currentDayDate, cookingDays, planStartDate)) {
        activeDays++;
      }
    }
  } else {
    activeDays = 7; // Fallback
  }
  
  const totalSlots = activeDays * mealTypes.length;
  logger.info(`calculateTotalMealSlots: ${activeDays} active days × ${mealTypes.length} meal types = ${totalSlots} total slots`);
  return totalSlots;
}

module.exports = { aiPlanGenerator }; 