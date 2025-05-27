// saucey-cloud-functions/feedbackFunctions/config.js

// --- Email Configuration ---
const GMAIL_SENDER_EMAIL = process.env.GMAIL_SENDER_EMAIL || 'malcolmdsmith1@gmail.com';
const FEEDBACK_RECIPIENT_EMAIL = process.env.FEEDBACK_RECIPIENT_EMAIL || 'malcolmdsmith1@gmail.com';

const GMAIL_APP_PASSWORD_SECRET_ID = process.env.GMAIL_APP_PASSWORD_SECRET_ID || 'saucey-feedback-email-app-password';
const GMAIL_APP_PASSWORD_SECRET_VERSION = process.env.GMAIL_APP_PASSWORD_SECRET_VERSION || 'latest';

// --- Gemini Configuration ---
// Model name for feedback summarization. The API key will be handled by the shared geminiClient.
const GEMINI_MODEL_NAME_FOR_SUMMARY = process.env.GEMINI_SUMMARY_MODEL || 'gemini-2.0-flash'; // Or your preferred model for summaries

// --- Firestore Collection ---
const FEEDBACK_COLLECTION_NAME = 'feedback_submissions';

// --- Schedules and Periods ---
const FEEDBACK_SUMMARY_SCHEDULE = process.env.FEEDBACK_SUMMARY_SCHEDULE || 'every monday 09:00';
const FEEDBACK_SUMMARY_PERIOD_DAYS = parseInt(process.env.FEEDBACK_SUMMARY_PERIOD_DAYS, 10) || 30;

const FEEDBACK_CLEANUP_SCHEDULE = process.env.FEEDBACK_CLEANUP_SCHEDULE || '0 3 1 * *';
const FEEDBACK_RETENTION_DAYS = parseInt(process.env.FEEDBACK_RETENTION_DAYS, 10) || 90;

module.exports = {
  GMAIL_SENDER_EMAIL,
  FEEDBACK_RECIPIENT_EMAIL,
  GMAIL_APP_PASSWORD_SECRET_ID,
  GMAIL_APP_PASSWORD_SECRET_VERSION,

  GEMINI_MODEL_NAME_FOR_SUMMARY, // Still needed

  FEEDBACK_COLLECTION_NAME,
  FEEDBACK_SUMMARY_SCHEDULE,
  FEEDBACK_SUMMARY_PERIOD_DAYS,
  FEEDBACK_CLEANUP_SCHEDULE,
  FEEDBACK_RETENTION_DAYS,
};
