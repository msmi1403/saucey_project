/**
 * @fileoverview JSDoc type definitions for the Meal Plan feature.
 * These types are used across various files in the mealPlanFunctions workspace.
 */

/**
 * @typedef {object} EstimatedMacros
 * @property {number} [calories]
 * @property {number} [protein]
 * @property {number} [carbs]
 * @property {number} [fat]
 */

/**
 * @typedef {object} MealSlotItem
 * @property {string} id - Typically a UUID, client-generated.
 * @property {string | null} [recipeId] - ID of the recipe if it's from the cookbook.
 * @property {string} title - Title of the meal item.
 * @property {EstimatedMacros | null} [estimatedMacros]
 * @property {number} servings
 * @property {boolean} isStub - True if this is a placeholder/AI-generated stub.
 * @property {string} source - e.g., "stub", "cookbook", "user_added"
 * @property {string[] | null} [keyIngredients]
 */

/**
 * @typedef {object} DayPlan
 * @property {string} id - Typically a UUID, client-generated.
 * @property {string} date - ISO8601 date string (YYYY-MM-DD).
 * @property {string} dayOfWeek - e.g., "Monday", "Tuesday".
 * @property {Object.<string, MealSlotItem[]>} meals - Keys are meal types (e.g., "breakfast", "lunch", "dinner", "snack1").
 */

/**
 * @typedef {object} MealPlanDocument
 * @property {string} planId - UUID for the plan, client-generated.
 * @property {string} name - User-defined name for the plan.
 * @property {string} startDate - ISO8601 date string (YYYY-MM-DD).
 * @property {string} endDate - ISO8601 date string (YYYY-MM-DD).
 * @property {DayPlan[]} days - Array of day plans.
 * @property {string} createdAt - ISO8601 timestamp for when the plan was created.
 * @property {string} [updatedAt] - ISO8601 timestamp for when the plan was last updated.
 * @property {string} [userId] - UID of the user who owns this plan (added server-side).
 */

/**
 * @typedef {object} TargetMacrosInput
 * @property {number} [calories]
 * @property {number} [protein]
 * @property {number} [carbs]
 * @property {number} [fat]
 */

/**
 * @typedef {object} MealPlanPreferences
 * @property {string[]} [availableCookingDays] - List of days when user can cook (e.g., ["Monday", "Friday"]).
 * @property {string} [recipeSourcePriority] - User's preference for recipe sources ("cookbookOnly", "balancedMix", "discoverNew").
 */

/**
 * @typedef {object} GenerateAiMealPlanParams
 * @property {number} durationDays - Number of days for the meal plan.
 * @property {TargetMacrosInput} [targetMacros] - Optional target macronutrients.
 * @property {string[]} [preferredCookingDays] - Optional list of preferred cooking days (e.g., ["Monday", "Friday"]).
 * @property {string} [dietaryNotes] - Optional string of combined dietary notes (e.g., "Vegetarian, Avoid peanuts").
 * @property {string} [cuisinePreference] - Optional string of preferred cuisines (e.g., "Italian, Mexican").
 * @property {number} [maxPrepTimePerMealMinutes] - Optional maximum prep time per meal in minutes.
 * @property {string[]} [includeMealTypes] - Optional list of meal types to include (e.g., ["breakfast", "lunch", "dinner"]).
 * @property {number} [numberOfSnacks] - Optional number of snacks per day.
 * @property {number} [age] - Optional user age.
 * @property {string} [gender] - Optional user gender (e.g., "male", "female", "other").
 * @property {number} [weightKg] - Optional user weight in kilograms.
 * @property {string} [activityLevel] - Optional user activity level (e.g., "sedentary", "light", "moderate", "active", "very_active").
 * @property {string} [cookingExperience] - Optional user cooking experience (e.g., "beginner", "intermediate", "advanced").
 * @property {string[]} [availableKitchenTools] - Optional list of available kitchen tools.
 * @property {string} [prepVolume] - Optional preference for meal prep volume (e.g., "single_servings", "batch_cooking").
 * @property {MealPlanPreferences} [preferences] - Optional meal plan preferences object.
 * @property {number} [chunkIndex] - The 0-based index of the chunk to generate.
 * @property {string} [planStartDate] - ISO8601 date string for the plan start date.
 */

/**
 * @typedef {object} AiMealItem
 * @property {string} title - Title of the AI-generated meal item.
 * @property {EstimatedMacros} estimatedMacros - Estimated macros for the meal.
 * @property {string[]} [keyIngredients] - Optional list of key ingredients.
 * @property {string} [notes] - Optional notes from AI, e.g. quick prep tips for this item.
 */

/**
 * @typedef {object} AiDayPlan
 * @property {string} dayOfWeek - e.g., "Monday", "Tuesday". Could also be Day 1, Day 2 for simplicity from AI.
 * @property {Object.<string, AiMealItem[]>} meals - Keys are meal types (e.g., "breakfast", "lunch", "dinner", "snack1").
 * @property {EstimatedMacros} [dailyTotals] - Optional AI calculated daily total macros for the day plan.
 */

/**
 * @typedef {object} AiGeneratedPlan
 * @property {AiDayPlan[]} plan - Array of AI-generated day plans.
 * @property {string} [summaryNotes] - Optional overall notes or summary from the AI about the generated plan.
 */

/**
 * @typedef {object} GroceryListItem
 * @property {string} name - Name of the grocery item.
 * @property {number} quantity - Quantity of the item.
 * @property {string} unit - Unit of measurement (e.g., "g", "ml", "pcs", "cups").
 * @property {string} category - Store category (e.g., "Produce", "Protein", "Pantry"). Added for grocery list generation.
 * @property {string[]} recipeSourceTitles - Titles of the recipes this ingredient is for.
 * @property {string} [notes] - Optional notes (e.g., "fresh", "canned", "low-sodium").
 */

/**
 * @typedef {object} GroceryList
 * @property {string} planId - ID of the meal plan this grocery list is for.
 * @property {string} [planName] - Name of the meal plan.
 * @property {string} startDate - ISO8601 start date of the meal plan.
 * @property {string} endDate - ISO8601 end date of the meal plan.
 * @property {GroceryListItem[]} items - Array of grocery list items.
 * @property {string} generatedAt - ISO8601 timestamp of when the list was generated.
 */

/**
 * @typedef {object} GenerateRecipeStubParams
 * @property {string} mealType - e.g., "breakfast", "lunch", "dinner", "snack".
 * @property {EstimatedMacros} [targetMacros] - Optional target macronutrients for this specific meal stub.
 * @property {string} [dietaryNotes] - Optional string of combined dietary notes (e.g., "Vegetarian, Avoid peanuts").
 * @property {string} [cuisinePreference] - Optional string of preferred cuisines (e.g., "Italian, Mexican").
 * @property {string[]} [existingIngredients] - Optional list of ingredients the user already has and might want to use.
 */

/**
 * @typedef {object} RecipeStub
 * @property {string} title - Title of the recipe stub.
 * @property {EstimatedMacros} estimatedMacros - Estimated macros for the stub.
 * @property {string[]} keyIngredients - List of key ingredients for the stub.
 */ 