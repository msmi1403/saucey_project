// CORRECTED: saucey-cloud-functions/notifications/index.js

const scheduledFunctions = require("./triggers/scheduledNotifications");
const firestoreTriggers = require("./triggers/firestoreTriggers");
const { dispatchNotification } = require("./services/sendNotification");
const badgeFunctions = require("./clearBadgeFunctions");

// Directly export each function that should be deployable
// or callable from other services.

// Utility/Service functions (if meant to be called by other modules directly, though less common for triggers)
exports.dispatchNotification = dispatchNotification;

// Scheduled Functions
exports.sendWeeklyRecipeSuggestions = scheduledFunctions.sendWeeklyRecipeSuggestions;
exports.sendMealPlanReminders = scheduledFunctions.sendMealPlanReminders;
exports.sendWeeklyRecapNotifications = scheduledFunctions.sendWeeklyRecapNotifications;

// Firestore Triggers
exports.notifyFollowersOnNewRecipe = firestoreTriggers.notifyFollowersOnNewRecipe;

// Badge Management Functions
exports.clearBadgeCount = badgeFunctions.clearBadgeCount;

// If you add HTTP Triggers later, they would be exported here too:
// exports.someHttpTrigger = require("./triggers/httpTriggers").someHttpTrigger;