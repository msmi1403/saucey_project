/**
 * Root Firebase Cloud Functions index file for the Saucey project.
 * This file initializes Firebase Admin and exports all deployable Cloud Functions
 * from various modules within the project.
 */

// Firebase Admin SDK - for interacting with Firebase services
const admin = require('firebase-admin');
// Firebase Functions SDK - for defining Cloud Functions
const functions = require('firebase-functions'); // Using v1 functions for root, ensure compatibility
const { logger } = functions; // Using functions.logger for root logging

// Initialize Firebase Admin SDK ONCE at the very top.
// This is crucial to ensure it's initialized before any function tries to use it.
if (admin.apps.length === 0) {
    admin.initializeApp();
    logger.log("Firebase Admin SDK initialized successfully in root index.js.");
} else {
    logger.log("Firebase Admin SDK was already initialized.");
}

// --- Import Functions from Project Modules ---

// Feedback Functions
// These are imported from feedbackService.js, which exports them directly.
// Functions include scheduled tasks and callable functions for feedback management.
const feedbackService = require("./feedbackFunctions/feedbackService");

// HandleRecipeChatTurn Functions
// This module (handleRecipeChatTurn/index.js) exports the 'handleRecipeChat' callable function.
const handleRecipeChatTurnFns = require("./handleRecipeChatTurn");

// Debug Functions
// This module (debugFunctions/sendDebugNotification.js) exports the 'sendDebugNotification' callable function.
const debugNotificationFns = require("./debugFunctions/sendDebugNotification");

// Notifications Module
// This module (notifications/index.js) exports an object 'notifications' which contains
// all notification-related functions (scheduled, Firestore-triggered, etc.).
const notificationModule = require("./notifications");


// --- Export All Functions for Firebase Deployment ---
// Firebase expects all deployable functions to be top-level properties of the exported module.

module.exports = {
    // --- Feedback Functions ---
    // Directly exposing functions imported from feedbackService
    summarizeAndReportFeedbackV2: feedbackService.summarizeAndReportFeedbackV2,
    cleanupOldFeedbackV2: feedbackService.cleanupOldFeedbackV2,
    recordFeedbackV2: feedbackService.recordFeedbackV2,
    getFeedbackSummaryV2: feedbackService.getFeedbackSummaryV2,
    getFeedbackEntriesV2: feedbackService.getFeedbackEntriesV2,
    updateFeedbackEntryV2: feedbackService.updateFeedbackEntryV2,
    deleteFeedbackEntryV2: feedbackService.deleteFeedbackEntryV2,

    // --- HandleRecipeChatTurn Functions ---
    // The handleRecipeChatTurn/index.js exports an object like { handleRecipeChat: [Function] }
    handleRecipeChat: handleRecipeChatTurnFns.handleRecipeChat,

    // --- Debug Functions ---
    // The debugFunctions/sendDebugNotification.js exports an object like { sendDebugNotification: [Function] }
    sendDebugNotification: debugNotificationFns.sendDebugNotification,

    // --- Notifications Functions ---
    // The notifications/index.js exports an object: { notifications: { func1, func2, ... } }
    // We spread the 'notifications' object from the imported module to make its functions top-level.
    // For example, if notificationModule.notifications has sendWeeklyRecipeSuggestions,
    // it will be exported as 'sendWeeklyRecipeSuggestions'.
    ...notificationModule.notifications,
};

logger.log("Saucey Cloud Functions (root index.js) fully processed. All function exports are prepared for deployment.");
