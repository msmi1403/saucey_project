const functions = require("firebase-functions/v2/https"); // Keep for type hints if any onCall is directly used, though unlikely now
const { logger } = require("firebase-functions/v2");

/**
 * @fileoverview Aggregates and exports all Meal Plan related Firebase Callable Functions.
 * Each function's core logic is now in its respective handler file within the 'handlers' directory.
 * JSDoc type definitions are located in '../types.js'.
 * Prompt templates are located in '../prompts/'.
 * Utility helpers like validation and stub creation are in '../utils/'.
 */

// Import handlers
const { fetchMealPlanPreferences } = require("../handlers/fetchMealPlanPreferences.handler");
// const { updateMealPlanPreferences } = require("../handlers/saveMealPlanPreferences.handler"); // Removed
const { saveMealPlan } = require("../handlers/saveMealPlan.handler"); // Corrected
const { fetchMealPlan } = require("../handlers/fetchMealPlan.handler"); // Corrected
const { generateRecipeStubForPlan } = require("../handlers/generateRecipeStubForPlan.handler");
const { aiPlanGenerator } = require("../handlers/aiPlanGenerator.handler");
const { generateMealPlan } = require("../handlers/generateMealPlan.handler"); // NEW: Simplified single-call generator
const { planGroceryLister } = require("../handlers/planGroceryLister.handler");
const { promoteStubToFullRecipe } = require("../handlers/promoteStubToFullRecipe.handler");
const { adaptRecipeStubForMacros } = require("../handlers/adaptRecipeStubForMacros.handler");
const { updateMealPlanPreferences_v2 } = require("../handlers/updateMealPlanPreferences_v2.handler"); // Added
const { extendMealPlan } = require("../handlers/extendMealPlan.handler"); // Added for rolling meal plans

// Export all functions
exports.fetchMealPlanPreferences = fetchMealPlanPreferences;
exports.saveMealPlan = saveMealPlan;
exports.fetchMealPlan = fetchMealPlan;
exports.generateRecipeStubForPlan = generateRecipeStubForPlan;
exports.aiPlanGenerator = aiPlanGenerator;
exports.generateMealPlan = generateMealPlan; // NEW: Simplified single-call generator
exports.planGroceryLister = planGroceryLister;
exports.promoteStubToFullRecipe = promoteStubToFullRecipe;
exports.adaptRecipeStubForMacros = adaptRecipeStubForMacros;
exports.updateMealPlanPreferences_v2 = updateMealPlanPreferences_v2; // Added
exports.extendMealPlan = extendMealPlan; // Added for rolling meal plans

logger.info("mealPlanService.js: All meal plan function handlers loaded and exported.");

module.exports = exports; 