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
  
  // Example for mealTypesToInclude (if provided)
  if (params.mealTypesToInclude !== undefined) {
    if (!Array.isArray(params.mealTypesToInclude)) {
     errors.push("'mealTypesToInclude' must be an array if provided.");
    } else {
        params.mealTypesToInclude.forEach((type, index) => { // Added index for better error reporting
            if (typeof type !== 'string' || type.trim() === "") { // Check for empty strings too
                errors.push(`Meal type at index ${index} in 'mealTypesToInclude' must be a non-empty string.`);
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
 * @param {object} params - The parameters to validate.
 * @param {number} maxTotalChunks - Maximum allowed total chunks for context.
 * @returns {{isValid: boolean, errors: string[]}} Validation result.
 */
function validateGenerateAiMealPlanChunkParams(params, maxTotalChunks) {
  const errors = [];

  // Required parameters
  if (typeof params.chunkIndex !== 'number' || params.chunkIndex < 0) {
    errors.push('chunkIndex must be a non-negative number.');
  }

  // REMOVED: durationDays validation - this is handled by the handler automatically
  // The handler sets FIXED_DURATION_DAYS_PER_CHUNK = 7 for chunks
  // iOS app doesn't need to send durationDays for chunk-based generation

  // Optional parameters validation
  if (params.targetMacros && typeof params.targetMacros !== 'object') {
    errors.push('targetMacros must be an object.');
  }

  if (params.mealTypesToInclude && !Array.isArray(params.mealTypesToInclude)) {
    errors.push('mealTypesToInclude must be an array.');
  }

  if (params.numberOfSnacks && (typeof params.numberOfSnacks !== 'number' || params.numberOfSnacks < 0)) {
    errors.push('numberOfSnacks must be a non-negative number.');
  }

  if (params.maxPrepTimePerMealMinutes && (typeof params.maxPrepTimePerMealMinutes !== 'number' || params.maxPrepTimePerMealMinutes <= 0)) {
    errors.push('maxPrepTimePerMealMinutes must be a positive number.');
  }

  // Map iOS maxTimePerMealMinutes to maxPrepTimePerMealMinutes if needed
  if (params.maxTimePerMealMinutes && !params.maxPrepTimePerMealMinutes) {
    params.maxPrepTimePerMealMinutes = params.maxTimePerMealMinutes;
    delete params.maxTimePerMealMinutes; // Clean up the old key
  }

  if (params.dietaryNotes && typeof params.dietaryNotes !== 'string') {
    errors.push('dietaryNotes must be a string.');
  }

  if (params.cuisinePreference && typeof params.cuisinePreference !== 'string') {
    errors.push('cuisinePreference must be a string.');
  }

  // NEW: Validate preferences object
  if (params.preferences) {
    if (typeof params.preferences !== 'object') {
      errors.push('preferences must be an object.');
    } else {
      // Validate recipeSourcePriority - ENHANCED WITH DISPLAY NAME MAPPING
      if (params.preferences.recipeSourcePriority) {
        const validSourcePriorities = ['cookbookOnly', 'balancedMix', 'discoverNew'];
        
        // Map display names to enum values
        const displayNameMapping = {
          'Cookbook Only': 'cookbookOnly',
          'Balanced Mix': 'balancedMix', 
          'Prioritize New Recipes': 'discoverNew'
        };
        
        // Auto-convert display names to enum values
        if (displayNameMapping[params.preferences.recipeSourcePriority]) {
          params.preferences.recipeSourcePriority = displayNameMapping[params.preferences.recipeSourcePriority];
        }
        
        if (!validSourcePriorities.includes(params.preferences.recipeSourcePriority)) {
          errors.push(`recipeSourcePriority must be one of: ${validSourcePriorities.join(', ')}`);
        }
      }

      // Validate availableCookingDays
      if (params.preferences.availableCookingDays) {
        if (!Array.isArray(params.preferences.availableCookingDays)) {
          errors.push('availableCookingDays must be an array.');
        } else {
          const validDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
          const invalidDays = params.preferences.availableCookingDays.filter(day => !validDays.includes(day));
          if (invalidDays.length > 0) {
            errors.push(`availableCookingDays contains invalid days: ${invalidDays.join(', ')}`);
          }
        }
      }

      // Validate cookTimePreference - ADD DISPLAY NAME MAPPING
      if (params.preferences.cookTimePreference) {
        const validCookTimes = ['any', 'sixtyMinutes', 'thirtyMinutes', 'fifteenMinutes'];
        
        // Map display names to enum values for cookTimePreference
        const cookTimeMapping = {
          "Doesn't Matter": 'any',
          '< 60 min': 'sixtyMinutes',
          '< 30 min': 'thirtyMinutes', 
          '< 15 min': 'fifteenMinutes'
        };
        
        // Auto-convert display names to enum values
        if (cookTimeMapping[params.preferences.cookTimePreference]) {
          params.preferences.cookTimePreference = cookTimeMapping[params.preferences.cookTimePreference];
        }
      }

      // Validate prepVolume - ADD DISPLAY NAME MAPPING  
      if (params.preferences.prepVolume) {
        const validPrepVolumes = ['daily', 'lightPrep', 'mediumPrep', 'batchPrep'];
        
        // Map display names to enum values for prepVolume
        const prepVolumeMapping = {
          '1-2 days': 'daily',
          '2-3 Days': 'lightPrep',
          '3-4 Days': 'mediumPrep',
          '5-7 Days': 'batchPrep'
        };
        
        // Auto-convert display names to enum values
        if (prepVolumeMapping[params.preferences.prepVolume]) {
          params.preferences.prepVolume = prepVolumeMapping[params.preferences.prepVolume];
        }
      }

      // Validate activityLevel - ADD DISPLAY NAME MAPPING
      if (params.preferences.activityLevel) {
        const validActivityLevels = ['sedentary', 'lightlyActive', 'moderatelyActive', 'veryActive', 'extremelyActive'];
        
        // Map display names to enum values for activityLevel
        const activityLevelMapping = {
          'Sedentary': 'sedentary',
          'Lightly Active': 'lightlyActive',
          'Moderately Active': 'moderatelyActive',
          'Very Active': 'veryActive',
          'Extremely Active': 'extremelyActive'
        };
        
        // Auto-convert display names to enum values
        if (activityLevelMapping[params.preferences.activityLevel]) {
          params.preferences.activityLevel = activityLevelMapping[params.preferences.activityLevel];
        }
      }

      // Validate cookingExperience - ADD DISPLAY NAME MAPPING
      if (params.preferences.cookingExperience) {
        const validCookingExperience = ['beginner', 'intermediate', 'advanced'];
        
        // Map display names to enum values for cookingExperience
        const cookingExperienceMapping = {
          'Beginner': 'beginner',
          'Intermediate': 'intermediate', 
          'Advanced': 'advanced'
        };
        
        // Auto-convert display names to enum values
        if (cookingExperienceMapping[params.preferences.cookingExperience]) {
          params.preferences.cookingExperience = cookingExperienceMapping[params.preferences.cookingExperience];
        }
      }
    }
  }

  // Validate planStartDate if provided
  if (params.planStartDate && typeof params.planStartDate !== 'string') {
    errors.push('planStartDate must be a string.');
  }

  return {
    isValid: errors.length === 0,
    errors: errors
  };
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