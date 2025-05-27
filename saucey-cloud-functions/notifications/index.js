// saucey-cloud-functions/notifications/index.js
const admin = require("firebase-admin");
const functions = require("firebase-functions");

// Initialize Firebase Admin SDK if not already initialized (idempotent)
// It's good practice to have this at the entry point of your functions modules
// if (admin.apps.length === 0) {
//   admin.initializeApp();
// }
// The root index.js should handle initialization.

const scheduledFunctions = require("./triggers/scheduledNotifications");
const firestoreTriggers = require("./triggers/firestoreTriggers");
// If you add HTTP triggers later:
// const httpTriggers = require("./triggers/httpTriggers");

// Export all functions from this module
exports.notifications = {
    // Scheduled Functions
    sendWeeklyRecipeSuggestions: scheduledFunctions.sendWeeklyRecipeSuggestions,
    sendMealPlanReminders: scheduledFunctions.sendMealPlanReminders,
    sendWeeklyRecapNotifications: scheduledFunctions.sendWeeklyRecapNotifications,

    // Firestore Triggers
    notifyFollowersOnNewRecipe: firestoreTriggers.notifyFollowersOnNewRecipe,

    // HTTP Triggers (Example, if you add them)
    // sendTestNotification: httpTriggers.sendTestNotification,
};