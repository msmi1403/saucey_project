// /handleRecipeChatTurn/config.js

// 1. Require the shared global configuration using the workspace path
const globalConfig = require('@saucey/shared/config/globalConfig.js');

// 2. Require prompts (paths are relative to this config.js file)
const CHEF_PERSONALITY_PROMPTS = require('./prompts/chefPersonalities');

// --- Recipe-Specific Gemini Model Configuration ---
// These allow handleRecipeChatTurn to use specific env vars or fallback to global, then to a default.
const GEMINI_MODEL_NAME = process.env.GEMINI_MODEL_NAME_RECIPE || globalConfig.GEMINI_MODEL_NAME || 'gemini-2.0-flash';
const GEMINI_VISION_MODEL_NAME = process.env.GEMINI_VISION_MODEL_NAME_RECIPE || globalConfig.GEMINI_VISION_MODEL_NAME || 'gemini-2.0-flash';
const GEMINI_TEXT_TEMPERATURE = parseFloat(process.env.GEMINI_TEXT_TEMPERATURE_RECIPE) || globalConfig.GEMINI_TEXT_TEMPERATURE || 0.6;
const GEMINI_TEXT_MAX_OUTPUT_TOKENS = parseInt(process.env.GEMINI_TEXT_MAX_OUTPUT_TOKENS_RECIPE) || globalConfig.GEMINI_TEXT_MAX_OUTPUT_TOKENS || 8192;

// --- GCS & App Defaults (Specific to handleRecipeChatTurn) ---
const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'saucey-images-saucey-3fb0f';
const GCS_USER_IMAGE_FOLDER = process.env.GCS_USER_IMAGE_FOLDER || 'user-images';
const DEFAULT_SERVINGS = parseInt(process.env.DEFAULT_SERVINGS, 10) || 4;
const DEFAULT_DIFFICULTY = process.env.DEFAULT_DIFFICULTY || 'Medium';
const DEFAULT_RECIPE_CATEGORY = process.env.DEFAULT_RECIPE_CATEGORY || 'General';
const DEFAULT_RECIPE_TITLE = process.env.DEFAULT_RECIPE_TITLE || 'Untitled Recipe';
const DEFAULT_INGREDIENT_NAME = process.env.DEFAULT_INGREDIENT_NAME || 'Ingredient';
const DEFAULT_INGREDIENT_CATEGORY = process.env.DEFAULT_INGREDIENT_CATEGORY || 'Miscellaneous';
const UNKNOWN_STEP_TEXT = process.env.UNKNOWN_STEP_TEXT || 'No specific instruction provided for this step.';
const USERS_COLLECTION = process.env.USERS_COLLECTION || 'users';
const RECIPES_SUBCOLLECTION = process.env.RECIPES_SUBCOLLECTION || 'my_recipes';

// --- CORS & Limits (Specific to handleRecipeChatTurn, if not using global CORS_HEADERS directly) ---
// If globalConfig.CORS_HEADERS is suitable, you don't need to redefine CORS_HEADERS here.
// If handleRecipeChatTurn has different CORS needs, define them here. For this example, we'll assume
// the CORS_HEADERS from globalConfig are used (they will be available via the ...globalConfig spread).

const URL_FETCH_TIMEOUT_MS = parseInt(process.env.URL_FETCH_TIMEOUT_MS, 10) || 15000; // 15 seconds

// --- Function Runtime Options (Gen 2) ---
const REGION = process.env.FUNCTION_REGION || globalConfig.LOCATION || 'us-central1'; // Default to global location or us-central1
const MEMORY = process.env.FUNCTION_MEMORY || '1GiB'; // Default memory for this function
const TIMEOUT_SECONDS = parseInt(process.env.FUNCTION_TIMEOUT_SECONDS, 10) || 300; // Default timeout
const MIN_INSTANCES = parseInt(process.env.FUNCTION_MIN_INSTANCES, 10) || 0; // Default min instances

// --- Supported Types (Specific to handleRecipeChatTurn) ---
// Note: Image size and base MIME types now come from globalConfig, but we keep recipe-specific ones here
const SUPPORTED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

// Kept for potential other uses or legacy
const RECIPE_SYSTEM_PROMPT_JSON = {
  system: 'You are a helpful cooking assistant.',
  user:   'Here is a recipe in JSON-LD. Turn it into step-by-step instructions.',
};

// 3. Export a merged configuration
module.exports = {
  // Spread global config first. This makes PROJECT_ID, LOCATION, global CORS_HEADERS,
  // and global Gemini settings (if defined there and not overridden below) available.
  ...globalConfig,

  // Now export handleRecipeChatTurn specific configurations.
  // If a key here is the same as a key in globalConfig, this local one will take precedence.
  GEMINI_MODEL_NAME, // Uses the recipe-specific one defined above
  GEMINI_VISION_MODEL_NAME, // Uses the recipe-specific one defined above
  GEMINI_TEXT_TEMPERATURE, // Uses the recipe-specific one defined above
  GEMINI_TEXT_MAX_OUTPUT_TOKENS, // Uses the recipe-specific one defined above

  GCS_BUCKET_NAME,
  GCS_USER_IMAGE_FOLDER,
  DEFAULT_SERVINGS,
  DEFAULT_DIFFICULTY,
  DEFAULT_RECIPE_CATEGORY,
  DEFAULT_RECIPE_TITLE,
  DEFAULT_INGREDIENT_NAME,
  DEFAULT_INGREDIENT_CATEGORY,
  UNKNOWN_STEP_TEXT,
  URL_FETCH_TIMEOUT_MS,
  SUPPORTED_IMAGE_MIME_TYPES,
  USERS_COLLECTION,
  RECIPES_SUBCOLLECTION,

  // Prompts (these are specific to handleRecipeChatTurn)
  CHEF_PERSONALITY_PROMPTS,
  RECIPE_SYSTEM_PROMPT_JSON,

  // Runtime options for Gen 2 functions
  REGION,
  MEMORY,
  TIMEOUT_SECONDS,
  MIN_INSTANCES,

  // Note: PROJECT_ID, LOCATION, and CORS_HEADERS (if defined in globalConfig)
  // are available because of the ...globalConfig spread.
  // There's no need to list them again explicitly unless you are overriding them,
  // in which case you'd define them as constants above and list them here.
};