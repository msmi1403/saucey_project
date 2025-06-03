/**
 * @fileoverview Validation helpers for meal plan functions.
 */
const { logger } = require("firebase-functions/v2");

/**
 * @typedef {import('../services/mealPlanService').GenerateAiMealPlanParams} GenerateAiMealPlanParams
 */

/**
 * Validates common base parameters for AI meal plan generation.
 * @param {object} params - The parameters to validate (subset of GenerateAiMealPlanParams).
 * @param {string[]} errors - Array to accumulate errors.
 */
function validateBaseMealPlanParams(params, errors) {
  // Example for targetMacros (if provided)
  if (params.targetMacros) {
    if (typeof params.targetMacros !== 'object' || params.targetMacros === null) {
      errors.push("'targetMacros' must be an object if provided.");
    } else {
      const allowedMacroKeys = ['calories', 'protein', 'carbs', 'fat'];
      for (const key in params.targetMacros) {
        if (!allowedMacroKeys.includes(key)) {
          errors.push(`Invalid key in 'targetMacros': ${key}.`);
        }
        if (params.targetMacros[key] !== undefined && (typeof params.targetMacros[key] !== 'number' || params.targetMacros[key] < 0)) {
          errors.push(`Macro '${key}' must be a non-negative number if provided.`);
        }
      }
    }
  }
  
  // Example for includeMealTypes (if provided)
  if (params.includeMealTypes !== undefined) {
    if (!Array.isArray(params.includeMealTypes)) {
     errors.push("'includeMealTypes' must be an array if provided.");
    } else {
        params.includeMealTypes.forEach((type, index) => { // Added index for better error reporting
            if (typeof type !== 'string' || type.trim() === "") { // Check for empty strings too
                errors.push(`Meal type at index ${index} in 'includeMealTypes' must be a non-empty string.`);
            }
        });
    }
  }

  if (params.numberOfSnacks !== undefined && (typeof params.numberOfSnacks !== 'number' || params.numberOfSnacks < 0 || !Number.isInteger(params.numberOfSnacks))) {
    errors.push("'numberOfSnacks' must be a non-negative integer if provided.");
  }

  if (params.maxPrepTimePerMealMinutes !== undefined && (typeof params.maxPrepTimePerMealMinutes !== 'number' || params.maxPrepTimePerMealMinutes <= 0)) {
    errors.push("'maxPrepTimePerMealMinutes' must be a positive number if provided.");
  }

  if (params.dietaryNotes !== undefined && (typeof params.dietaryNotes !== 'string')) {
    errors.push("'dietaryNotes' must be a string if provided.");
  }
  
  if (params.cuisinePreference !== undefined && (typeof params.cuisinePreference !== 'string')) {
    errors.push("'cuisinePreference' must be a string if provided.");
  }
  // Add other common validations here (e.g., age, weightKg, preferredCookingDays)
}

/**
 * Validates the parameters for AI meal plan generation (original, non-chunked).
 * @param {GenerateAiMealPlanParams} params - The parameters to validate.
 * @returns {{isValid: boolean, errors: string[]}} Validation result.
 */
function validateGenerateAiMealPlanParams(params) {
  const errors = [];
  if (!params) {
    errors.push("Request params are missing.");
    return { isValid: false, errors };
  }

  if (typeof params.durationDays !== 'number' || params.durationDays <= 0) {
    errors.push("Parameter 'durationDays' must be a positive number.");
  }

  validateBaseMealPlanParams(params, errors); // Call refactored base validation

  if (errors.length > 0) {
    logger.warn("validateGenerateAiMealPlanParams: Validation failed.", { params, errors });
    return { isValid: false, errors };
  }

  return { isValid: true, errors: [] };
}

/**
 * Validates the parameters for AI meal plan generation (chunked).
 * @param {object} params - The parameters to validate, including chunkIndex and totalChunks.
 * @returns {{isValid: boolean, errors: string[]}} Validation result.
 */
function validateGenerateAiMealPlanChunkParams(params) {
  const errors = [];
  if (!params) {
    errors.push("Request params for chunked generation are missing.");
    return { isValid: false, errors };
  }

  if (typeof params.chunkIndex !== 'number' || params.chunkIndex < 0 || !Number.isInteger(params.chunkIndex)) {
    errors.push("Parameter 'chunkIndex' must be a non-negative integer.");
  }

  if (typeof params.totalChunks !== 'number' || params.totalChunks <= 0 || !Number.isInteger(params.totalChunks)) {
    errors.push("Parameter 'totalChunks' must be a positive integer.");
  }

  if (typeof params.chunkIndex === 'number' && typeof params.totalChunks === 'number' && params.chunkIndex >= params.totalChunks) {
    errors.push("'chunkIndex' must be less than 'totalChunks'.");
  }
  
  if (params.durationDaysPerChunk !== undefined && (typeof params.durationDaysPerChunk !== 'number' || params.durationDaysPerChunk <= 0 || !Number.isInteger(params.durationDaysPerChunk))) {
    errors.push("Optional parameter 'durationDaysPerChunk' must be a positive integer if provided.");
  }

  validateBaseMealPlanParams(params, errors); // Call refactored base validation

  if (errors.length > 0) {
    logger.warn("validateGenerateAiMealPlanChunkParams: Validation failed.", { params, errors });
    return { isValid: false, errors };
  }

  return { isValid: true, errors: [] };
}

/**
 * Validates if a planId is provided and is a non-empty string.
 * @param {string} planId - The plan ID to validate.
 * @returns {{isValid: boolean, errors: string[]}} Validation result.
 */
function validatePlanId(planId) {
  const errors = [];
  if (!planId || typeof planId !== 'string' || planId.trim() === "") {
    errors.push("Parameter 'planId' must be a non-empty string.");
  }
  if (errors.length > 0) {
    logger.warn("validatePlanId: Validation failed.", { planId, errors });
    return { isValid: false, errors };
  }
  return { isValid: true, errors: [] };
}

/**
 * @typedef {import('../services/mealPlanService').GenerateRecipeStubParams} GenerateRecipeStubParams
 */

/**
 * Validates the parameters for generating a recipe stub.
 * @param {GenerateRecipeStubParams} params - The parameters to validate.
 * @returns {{isValid: boolean, errors: string[]}} Validation result.
 */
function validateGenerateRecipeStubParams(params) {
  const errors = [];
  if (!params) {
    errors.push("Request params for GenerateRecipeStubParams are missing.");
    return { isValid: false, errors };
  }

  if (!params.mealType || typeof params.mealType !== 'string' || params.mealType.trim() === "") {
    errors.push("Parameter 'mealType' must be a non-empty string.");
  }

  if (params.targetMacros) {
    if (typeof params.targetMacros !== 'object' || params.targetMacros === null) {
      errors.push("'targetMacros' must be an object if provided.");
    } else {
      const allowedMacroKeys = ['calories', 'protein', 'carbs', 'fat'];
      for (const key in params.targetMacros) {
        if (!allowedMacroKeys.includes(key)) {
          errors.push(`Invalid key in 'targetMacros': ${key}.`);
        }
        if (params.targetMacros[key] !== undefined && (typeof params.targetMacros[key] !== 'number' || params.targetMacros[key] < 0)) {
          errors.push(`Macro '${key}' must be a non-negative number if provided.`);
        }
      }
    }
  }

  if (params.dietaryNotes && typeof params.dietaryNotes !== 'string') {
    errors.push("'dietaryNotes' must be a string if provided.");
  }

  if (params.cuisinePreference && typeof params.cuisinePreference !== 'string') {
    errors.push("'cuisinePreference' must be a string if provided.");
  }

  if (params.existingIngredients) {
    if (!Array.isArray(params.existingIngredients)) {
      errors.push("'existingIngredients' must be an array if provided.");
    } else {
      params.existingIngredients.forEach((ing, index) => {
        if (typeof ing !== 'string' || ing.trim() === "") {
          errors.push(`Ingredient at index ${index} in 'existingIngredients' must be a non-empty string.`);
        }
      });
    }
  }

  if (errors.length > 0) {
    logger.warn("validateGenerateRecipeStubParams: Validation failed.", { params, errors });
    return { isValid: false, errors };
  }

  return { isValid: true, errors: [] };
}

module.exports = {
  validateGenerateAiMealPlanParams,
  validateGenerateAiMealPlanChunkParams,
  validatePlanId,
  validateGenerateRecipeStubParams,
}; 