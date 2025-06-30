const { onCall } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const { transcribeAudio, validateAudioFile } = require('../shared/services/openaiClient');

/**
 * Firebase Cloud Function: transcribeAudio (Secure onCall)
 * Securely transcribes audio files using OpenAI Whisper API
 * 
 * Expected request data:
 * {
 *   audioData: string,     // Base64 encoded audio file
 *   fileName: string,      // File name with extension (e.g., "recording.mp3")
 *   language?: string,     // Optional language code (e.g., 'en', 'es')
 *   prompt?: string,       // Optional context to improve transcription accuracy
 *   temperature?: number   // Optional sampling temperature (0-1)
 * }
 * 
 * Response:
 * {
 *   success: true,
 *   transcription: { text: string, language: string, duration: number }
 * }
 * 
 * Error Response:
 * {
 *   success: false,
 *   error: string
 * }
 */
const transcribeAudioFunction = onCall(
    {
        // Cloud Function configuration
        maxInstances: 10,
        timeoutSeconds: 540, // 9 minutes (max for Cloud Functions)
        memory: "1GiB",
        cpu: 1,
        // Enable App Check for additional security (optional)
        // enforceAppCheck: true
    },
    async (request) => {
        const logPrefix = "transcribeAudio:";
        const { data, auth } = request;
        
        try {
            // Log request info (without sensitive data)
            logger.info(`${logPrefix} Received transcription request from user: ${auth?.uid || 'anonymous'}`);

            // Validate required fields
            if (!data || typeof data !== 'object') {
                const error = "Invalid request data. Expected object with audioData and fileName.";
                logger.error(`${logPrefix} ${error}`);
                return { success: false, error };
            }

            const { audioData, fileName, language, prompt, temperature } = data;

            // Validate required fields
            if (!audioData || typeof audioData !== 'string') {
                const error = "Missing or invalid audioData. Expected base64 encoded string.";
                logger.error(`${logPrefix} ${error}`);
                return { success: false, error };
            }

            if (!fileName || typeof fileName !== 'string') {
                const error = "Missing or invalid fileName. Expected string with file extension.";
                logger.error(`${logPrefix} ${error}`);
                return { success: false, error };
            }

            // Convert base64 to buffer
            let audioBuffer;
            try {
                audioBuffer = Buffer.from(audioData, 'base64');
            } catch (decodeError) {
                const error = "Invalid base64 audio data.";
                logger.error(`${logPrefix} ${error}:`, decodeError);
                return { success: false, error };
            }

            logger.info(`${logPrefix} Processing file: ${fileName}, size: ${audioBuffer.length} bytes`);

            // Validate the audio file
            const validation = validateAudioFile(audioBuffer, fileName);
            if (!validation.valid) {
                logger.error(`${logPrefix} File validation failed: ${validation.error}`);
                return { success: false, error: validation.error };
            }

            // Validate optional parameters
            if (language && typeof language !== 'string') {
                const error = "Invalid language parameter. Expected string.";
                logger.error(`${logPrefix} ${error}`);
                return { success: false, error };
            }

            if (prompt && typeof prompt !== 'string') {
                const error = "Invalid prompt parameter. Expected string.";
                logger.error(`${logPrefix} ${error}`);
                return { success: false, error };
            }

            if (temperature !== undefined) {
                if (typeof temperature !== 'number' || temperature < 0 || temperature > 1) {
                    const error = "Invalid temperature parameter. Expected number between 0 and 1.";
                    logger.error(`${logPrefix} ${error}`);
                    return { success: false, error };
                }
            }

            // Build options object
            const options = {};
            if (language) options.language = language;
            if (prompt) options.prompt = prompt;
            if (temperature !== undefined) options.temperature = temperature;

            logger.info(`${logPrefix} Starting transcription with options:`, { 
                language: options.language || 'auto-detect', 
                hasPrompt: !!options.prompt,
                temperature: options.temperature || 'default'
            });

            try {
                // Call OpenAI Whisper API through our secure client
                const transcriptionResult = await transcribeAudio(audioBuffer, fileName, options);
                
                logger.info(`${logPrefix} Transcription successful. Text length: ${transcriptionResult.text.length} characters`);
                
                // Return successful response
                return {
                    success: true,
                    transcription: {
                        text: transcriptionResult.text,
                        language: transcriptionResult.language,
                        duration: transcriptionResult.duration,
                        options_used: options
                    }
                };
                
            } catch (transcriptionError) {
                logger.error(`${logPrefix} Transcription failed:`, transcriptionError);
                
                // Provide user-friendly error messages
                let errorMessage = "Transcription failed. Please try again.";
                
                if (transcriptionError.message.includes('too large')) {
                    errorMessage = "Audio file is too large. Maximum size is 25MB.";
                } else if (transcriptionError.message.includes('format')) {
                    errorMessage = "Invalid audio format. Please use MP3, WAV, M4A, or other supported formats.";
                } else if (transcriptionError.message.includes('rate limit')) {
                    errorMessage = "Service temporarily unavailable due to high demand. Please try again in a moment.";
                } else if (transcriptionError.message.includes('authentication')) {
                    errorMessage = "Service configuration error. Please contact support.";
                } else if (transcriptionError.message.includes('network') || transcriptionError.message.includes('timeout')) {
                    errorMessage = "Network error. Please check your connection and try again.";
                }
                
                return { success: false, error: errorMessage };
            }

        } catch (error) {
            logger.error(`${logPrefix} Unexpected error:`, error);
            return { success: false, error: "An unexpected error occurred. Please try again." };
        }
    }
);

module.exports = {
    transcribeAudio: transcribeAudioFunction
}; 