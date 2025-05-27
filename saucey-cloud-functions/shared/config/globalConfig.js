// saucey-cloud-functions/shared/config/globalConfig.js
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'saucey-3fb0f';
const LOCATION   = process.env.FUNCTION_REGION || 'us-central1';

// Optional: If these are truly universal for all current and future functions
const CORS_HEADERS = {
  'Access-Control-Allow-Origin' : '*', // Or your more specific origin
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET', // Add GET if needed by other functions
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '3600',
};

// Optional: If Gemini settings are the same for all functions using Gemini
const GEMINI_MODEL_NAME        = process.env.GEMINI_MODEL_NAME || 'gemini-2.0-flash';
const GEMINI_VISION_MODEL_NAME = process.env.GEMINI_VISION_MODEL_NAME || 'gemini-2.0-flash';
const GEMINI_TEXT_TEMPERATURE = parseFloat(process.env.GEMINI_TEXT_TEMPERATURE) || 0.6;
const GEMINI_TEXT_MAX_OUTPUT_TOKENS = parseInt(process.env.GEMINI_TEXT_MAX_OUTPUT_TOKENS, 10) || 8192;

// Default Gemini Safety Settings
// These can be made configurable via environment variables if needed, e.g., by parsing a JSON string.
const GEMINI_SAFETY_SETTINGS = [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
];

module.exports = {
    PROJECT_ID,
    LOCATION,
    CORS_HEADERS, // if shared
    GEMINI_MODEL_NAME, // if shared
    GEMINI_VISION_MODEL_NAME, // if shared
    GEMINI_TEXT_TEMPERATURE, // if shared
    GEMINI_TEXT_MAX_OUTPUT_TOKENS, // if shared
    GEMINI_SAFETY_SETTINGS, // Export the safety settings
};