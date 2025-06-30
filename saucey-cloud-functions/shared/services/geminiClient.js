// saucey-cloud-functions/shared/services/geminiClient.js
const { GoogleGenAI, HarmCategory, HarmBlockThreshold } = require("@google/genai");
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const globalConfig = require('@saucey/shared/config/globalConfig.js'); // Corrected path

let genAI; // Singleton for GoogleGenAI (new unified client)
let initializedModels = {}; // To store initialized models: { 'modelName': modelInstance }

// --- Modifications for Singleton Initialization ---
let apiKeyPromise; // Promise for fetching the API key
let genAIInitializationPromise; // Promise for initializing genAI

const GCLOUD_PROJECT_ID_FOR_SECRET = process.env.GCLOUD_PROJECT || globalConfig.PROJECT_ID;
const GEMINI_API_KEY_SECRET_ID = process.env.GEMINI_API_KEY_SECRET_ID_GLOBAL || 'saucey-gemini-key'; // Use the one from globalConfig
const SECRET_VERSION = 'latest';

const secretManagerClient = new SecretManagerServiceClient();

/**
 * Fetches the Gemini API Key from Google Secret Manager, ensuring it's fetched only once.
 * @returns {Promise<string>} The API key.
 */
async function getApiKey() {
    if (apiKeyPromise) {
        // If a fetch is already in progress, wait for it
        return apiKeyPromise;
    }

    // Start a new fetch operation
    apiKeyPromise = (async () => {
        const secretPath = `projects/${GCLOUD_PROJECT_ID_FOR_SECRET}/secrets/${GEMINI_API_KEY_SECRET_ID}/versions/${SECRET_VERSION}`;
        console.log(`Shared GeminiClient: Accessing API Key from Secret Manager path: ${secretPath}`);
        try {
            const [versionAccessResponse] = await secretManagerClient.accessSecretVersion({
                name: secretPath,
            });
            const key = versionAccessResponse.payload.data.toString('utf8');
            if (!key) {
                throw new Error('Shared GeminiClient: Fetched API key from Secret Manager is empty.');
            }
            console.log('Shared GeminiClient: Successfully fetched API Key from Secret Manager.');
            return key;
        } catch (error) {
            apiKeyPromise = null; // Reset promise on error so next call can retry
            console.error(`CRITICAL: Shared GeminiClient: Failed to fetch API Key. Error: ${error.message}`);
            throw new Error(`Shared GeminiClient: Could not retrieve API Key. Original error: ${error.message}`);
        }
    })();

    return apiKeyPromise;
}

/**
 * Initializes the core GoogleGenAI client if not already done, ensuring it happens only once.
 * @returns {Promise<void>}
 */
async function ensureGenAIInitialized() {
    if (genAI) { // Quick exit if already initialized
        return;
    }

    if (genAIInitializationPromise) {
        // If initialization is already in progress, wait for it
        return genAIInitializationPromise;
    }

    // Start a new initialization operation
    genAIInitializationPromise = (async () => {
        try {
            const apiKey = await getApiKey(); // This now uses the promise-based getApiKey
            if (!apiKey) { // Should not happen if getApiKey throws on failure
                const errorMessage = "Shared GeminiClient: API Key was not available. Cannot initialize Gemini service.";
                console.error(`CRITICAL: ${errorMessage}`);
                throw new Error(errorMessage);
            }
            // New unified SDK initialization - defaults to Gemini Developer API
            genAI = new GoogleGenAI({apiKey: apiKey});
            console.log("Shared GeminiClient: GoogleGenAI unified client initialized.");
        } catch (initError) {
            genAIInitializationPromise = null; // Reset promise on error so next call can retry
            console.error("CRITICAL: Shared GeminiClient: Error during GoogleGenAI client initialization:", initError);
            throw initError;
        }
    })();

    return genAIInitializationPromise;
}

/**
 * Gets a specific generative model instance, initializing it if necessary.
 * Note: In the new unified SDK, we don't pre-cache model instances since
 * the API pattern is different (models.generateContent vs getGenerativeModel)
 * @param {string} modelName - The name of the model to get (e.g., 'gemini-1.5-flash-latest').
 * @returns {Promise<string>} The model name (for backwards compatibility).
 */
async function getModel(modelName) {
    await ensureGenAIInitialized(); // This will now correctly await the single initialization
    if (!genAI) { // Should be caught by ensureGenAIInitialized, but as a safeguard
        throw new Error("Shared GeminiClient: genAI not initialized before getModel call.");
    }
    
    // In the new SDK, we don't need to pre-initialize models
    // Just validate that the client is ready and return the model name
    console.log(`Shared GeminiClient: Model '${modelName}' validated and ready for use.`);
    return modelName; // Return model name for backwards compatibility
}

const DEFAULT_SAFETY_SETTINGS = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

async function generateContent({
    modelName,
    contents,
    systemInstruction,
    generationConfig,
    safetySettings = DEFAULT_SAFETY_SETTINGS
}) {
    if (!modelName || !contents || !generationConfig) {
        throw new Error("Shared GeminiClient: modelName, contents, and generationConfig are required for generateContent.");
    }

    await ensureGenAIInitialized(); // Ensure client is ready
    console.log(`Shared GeminiClient: Generating content with model '${modelName}'.`);

    try {
        // New unified SDK API pattern
        const requestConfig = {
            model: modelName,
            contents: contents,
            config: {
                generationConfig: generationConfig,
                safetySettings: safetySettings
            }
        };

        // Add system instruction if provided
        if (systemInstruction) {
            requestConfig.config.systemInstruction = systemInstruction;
        }

        const result = await genAI.models.generateContent(requestConfig);

        if (!result || !result.candidates) {
            console.error(`Shared GeminiClient: Model '${modelName}' returned no response object. Full result:`, JSON.stringify(result, null, 2));
            throw new Error(`AI service (model: ${modelName}) returned no response object.`);
        }
        
        if (result.candidates.length === 0) {
            const blockReason = result.promptFeedback?.blockReason;
            const responseSafetyRatings = result.promptFeedback?.safetyRatings;
            console.error(`Shared GeminiClient: Model '${modelName}' returned no candidates. Block Reason: ${blockReason}, Safety Ratings: ${JSON.stringify(responseSafetyRatings)}`);
            let errorMessage = `AI service (model: ${modelName}) returned no candidates.`;
            if (blockReason) errorMessage += ` Reason: ${blockReason}.`;
            if (result.promptFeedback?.blockReason === 'SAFETY' || (responseSafetyRatings && responseSafetyRatings.some(r => r.blocked))) {
                 errorMessage = `Request to model '${modelName}' was blocked due to safety settings.`;
            }
            throw new Error(errorMessage);
        }

        // Create backwards-compatible response object
        const response = {
            candidates: result.candidates,
            promptFeedback: result.promptFeedback,
            usageMetadata: result.usageMetadata,
            text: () => {
                if (result.candidates && result.candidates[0] && result.candidates[0].content && result.candidates[0].content.parts) {
                    return result.candidates[0].content.parts.map(part => part.text).join('');
                }
                return '';
            }
        };

        return response;
    } catch (error) {
        console.error(`Shared GeminiClient: Error in generateContent call to model '${modelName}':`, error);
        if (error.message && error.message.toLowerCase().includes("safety")) {
             console.error(`Shared GeminiClient: Model '${modelName}' safety settings likely blocked the response. Error details:`, JSON.stringify(error));
             throw new Error(`Request or generated response for model '${modelName}' was blocked due to safety settings.`);
        }
        throw new Error(`Shared GeminiClient: API call to model '${modelName}' failed: ${error.message || String(error)}`);
    }
}

module.exports = {
    generateContent,
    getModel,
    HarmCategory,
    HarmBlockThreshold,
    ensureGenAIInitialized // Exposing this if any service wants to "warm up" the client
};