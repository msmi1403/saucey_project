const functions = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const { HttpsError } = require("firebase-functions/v2/https");
const geminiClient = require("@saucey/shared/services/geminiClient");
const globalConfig = require("@saucey/shared/config/globalConfig");
const { validateGenerateAiMealPlanChunkParams } = require("../utils/validationHelper");
const fs = require('fs');
const path = require('path');

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
 * @param {number} data.params.totalChunks - The total number of chunks planned for generation.
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

  let { params } = request.data;

  if (!params || typeof params !== 'object') {
    logger.warn(`aiPlanGenerator (chunk mode): Client did not send params object or it's invalid. UserId: ${userId}`);
    throw new HttpsError("invalid-argument", "Params object is missing or invalid.", { userId });
  }
  
  // chunkIndex and totalChunks are now required parameters from the client.
  // Validation for these (and others) is handled by validateGenerateAiMealPlanChunkParams

  const validation = validateGenerateAiMealPlanChunkParams(params); 
  if (!validation.isValid) {
    logger.warn("aiPlanGenerator (chunk mode): Invalid parameters.", { userId, errors: validation.errors, params });
    throw new HttpsError("invalid-argument", "Invalid parameters for AI meal plan generation.", { errors: validation.errors });
  }

  const CHUNK_DURATION_DAYS = params.durationDaysPerChunk || 7; // Allow client to specify or default to 7
  const chunkIndex = params.chunkIndex;
  const totalChunks = params.totalChunks; // Expecting totalChunks from client
  const dayOffset = chunkIndex * CHUNK_DURATION_DAYS;

  logger.info(`aiPlanGenerator (chunk mode): Generating chunk ${chunkIndex}/${totalChunks -1} (${CHUNK_DURATION_DAYS} days, starting global day ${dayOffset + 1}).`, { userId });

  let fullPrompt = fs.readFileSync(path.join(__dirname, '../prompts/aiPlanGenerator.prompt.txt'), 'utf8');
  
  // Replace duration placeholder
  fullPrompt = fullPrompt.replace('{{durationDays}}', CHUNK_DURATION_DAYS.toString());

  // Add week context for the AI
  const weekContextPrompt = `This is for Week ${chunkIndex + 1} of ${totalChunks}. Please generate meal ideas primarily for this segment.`
  fullPrompt = fullPrompt.replace('{{weekContext}}', weekContextPrompt); // Assumes {{weekContext}} placeholder in prompt file

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
  if (params.includeMealTypes && params.includeMealTypes.length > 0) {
    includeMealTypesPrompt = `Include these meal types: ${params.includeMealTypes.join(", ")}.`;
  } else {
    includeMealTypesPrompt = "Include breakfast, lunch, and dinner by default.";
  }
  fullPrompt = fullPrompt.replace('{{includeMealTypesPrompt}}', includeMealTypesPrompt);

  let numberOfSnacksPrompt = "";
  if (params.numberOfSnacks && params.numberOfSnacks > 0) {
    numberOfSnacksPrompt = `Include ${params.numberOfSnacks} snack(s) per day.`;
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
  fullPrompt = fullPrompt.split('\n').filter(line => line.trim() !== '').join('\n');

  logger.info(`aiPlanGenerator (chunk mode): Constructed prompt for chunk ${chunkIndex} (days ${dayOffset + 1}-${dayOffset + CHUNK_DURATION_DAYS})`, { userId, promptLength: fullPrompt.length, weekContext: weekContextPrompt });

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
    
    // Adjust dayOfWeek in the chunk's plan to be globally unique for the entire plan
    generatedChunkPlan.plan.forEach((dayPlan, index) => {
      const globalDayNumber = dayOffset + index + 1;
      dayPlan.dayOfWeek = `Day ${globalDayNumber}`;
      // logger.info(`aiPlanGenerator (chunk mode): Remapped chunk day ${index+1} to global Day ${globalDayNumber}`, {userId}); 
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

module.exports = { aiPlanGenerator }; 