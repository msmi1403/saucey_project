// saucey-cloud-functions/index.js

/**
 * Root Firebase Cloud Functions index file for the Saucey project.
 * This file initializes Firebase Admin and exports all deployable Cloud Functions
 * from various modules within the project using the modern Gen 2 export style.
 */

// Firebase Admin SDK - for interacting with Firebase services
const admin = require('firebase-admin');
const { logger } = require("firebase-functions/v2"); // Use Gen 2 logger

// Initialize Firebase Admin SDK ONCE at the very top.
if (admin.apps.length === 0) {
    admin.initializeApp();
    logger.log("Firebase Admin SDK initialized successfully in root index.js.");
} else {
    logger.log("Firebase Admin SDK was already initialized.");
}

// --- DIRECT GEN 2 EXPORTS ---

// Each function or group is now exported directly, making it Gen 2 compatible.

// Test Auth Functions removed

// Feedback Functions
// Assuming "./feedbackFunctions/feedbackService" exports all its functions directly
Object.assign(exports, require("./feedbackFunctions/feedbackService"));

// HandleRecipeChatTurn Functions
// Assuming "./handleRecipeChatTurn" exports handleRecipeChatTurn
exports.handleRecipeChatTurn = require("./handleRecipeChatTurn").handleRecipeChatTurn;

// App Call Functions
// Assuming these modules export their functions directly or as a group
Object.assign(exports, require("./app-call-functions/recipeManagement"));
Object.assign(exports, require("./app-call-functions/userProfile"));
Object.assign(exports, require("./app-call-functions/discovery"));
Object.assign(exports, require("./app-call-functions/recipeRetrieval"));
Object.assign(exports, require("./app-call-functions/personalizedPrompts"));

// Billing Functions
Object.assign(exports, require("./app-call-functions/billing"));

// Notifications Module
// Assuming "./notifications" exports all its notification functions directly (after our previous refactor of notifications/index.js)
Object.assign(exports, require("./notifications"));

Object.assign(exports, require("./triggers/authTriggers"));

// ——— Other Gen 2 triggers ———
Object.assign(exports, require("./triggers/firestoreTriggers"));
Object.assign(exports, require("./triggers/scheduledTriggers"));

// Meal Plan Functions
// Assuming "./mealPlanFunctions" (which should point to mealPlanService.js) exports all its Gen 2 functions directly
Object.assign(exports, require("./mealPlanFunctions"));

// My Ingredients Functions
Object.assign(exports, require("./myIngredientsFunctions/analyzeMyIngredients"));

// Speech Recognition Functions
Object.assign(exports, require("./speechRecognitionFunctions/transcribeAudio"));

logger.log("Saucey Cloud Functions (root index.js) processed for FULL deployment. Exports prepared.");