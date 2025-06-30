const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const FormData = require('form-data');
const fetch = require('node-fetch');
const globalConfig = require('@saucey/shared/config/globalConfig.js');

let openaiApiKey; // Singleton for OpenAI API key
let apiKeyPromise; // Promise for fetching the API key

const GCLOUD_PROJECT_ID_FOR_SECRET = process.env.GCLOUD_PROJECT || globalConfig.PROJECT_ID;
const OPENAI_API_KEY_SECRET_ID = process.env.OPENAI_API_KEY_SECRET_ID_GLOBAL || 'OPENAI_API_KEY';
const SECRET_VERSION = 'latest';
const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';

const secretManagerClient = new SecretManagerServiceClient();

/**
 * Fetches the OpenAI API Key from Google Secret Manager, ensuring it's fetched only once.
 * @returns {Promise<string>} The API key.
 */
async function getApiKey() {
    if (apiKeyPromise) {
        // If a fetch is already in progress, wait for it
        return apiKeyPromise;
    }

    // Start a new fetch operation
    apiKeyPromise = (async () => {
        const secretPath = `projects/${GCLOUD_PROJECT_ID_FOR_SECRET}/secrets/${OPENAI_API_KEY_SECRET_ID}/versions/${SECRET_VERSION}`;
        console.log(`Shared OpenAIClient: Accessing API Key from Secret Manager path: ${secretPath}`);
        try {
            const [versionAccessResponse] = await secretManagerClient.accessSecretVersion({
                name: secretPath,
            });
            const key = versionAccessResponse.payload.data.toString('utf8');
            if (!key) {
                throw new Error('Shared OpenAIClient: Fetched API key from Secret Manager is empty.');
            }
            console.log('Shared OpenAIClient: Successfully fetched API Key from Secret Manager.');
            return key;
        } catch (error) {
            apiKeyPromise = null; // Reset promise on error so next call can retry
            console.error(`CRITICAL: Shared OpenAIClient: Failed to fetch API Key. Error: ${error.message}`);
            throw new Error(`Shared OpenAIClient: Could not retrieve API Key. Original error: ${error.message}`);
        }
    })();

    return apiKeyPromise;
}

/**
 * Transcribe audio using OpenAI Whisper API
 * @param {Buffer} audioBuffer - The audio file buffer
 * @param {string} fileName - The name of the audio file (should include extension)
 * @param {Object} options - Additional options for transcription
 * @param {string} options.language - Language code (e.g., 'en', 'es') - optional
 * @param {string} options.prompt - Context or previous transcript to improve accuracy - optional
 * @param {number} options.temperature - Sampling temperature (0-1) - optional
 * @returns {Promise<Object>} Transcription result with text and metadata
 */
async function transcribeAudio(audioBuffer, fileName, options = {}) {
    if (!audioBuffer || audioBuffer.length === 0) {
        throw new Error('Shared OpenAIClient: Audio buffer is required and cannot be empty.');
    }

    if (!fileName) {
        throw new Error('Shared OpenAIClient: File name is required.');
    }

    console.log(`Shared OpenAIClient: Starting transcription for file: ${fileName}, size: ${audioBuffer.length} bytes`);

    try {
        const apiKey = await getApiKey();
        
        // Create form data for multipart upload
        const formData = new FormData();
        formData.append('file', audioBuffer, {
            filename: fileName,
            contentType: getContentType(fileName)
        });
        formData.append('model', 'whisper-1');
        
        // Add optional parameters
        if (options.language) {
            formData.append('language', options.language);
        }
        if (options.prompt) {
            formData.append('prompt', options.prompt);
        }
        if (options.temperature !== undefined) {
            formData.append('temperature', options.temperature.toString());
        }

        const response = await fetch(`${OPENAI_API_BASE_URL}/audio/transcriptions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                ...formData.getHeaders()
            },
            body: formData
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Shared OpenAIClient: Whisper API error (${response.status}): ${errorText}`);
            throw new Error(`Whisper API request failed with status ${response.status}: ${errorText}`);
        }

        const result = await response.json();
        
        if (!result.text) {
            console.error('Shared OpenAIClient: Whisper API returned no transcription text');
            throw new Error('Whisper API returned no transcription text');
        }

        console.log(`Shared OpenAIClient: Successfully transcribed audio. Text length: ${result.text.length} characters`);
        
        return {
            text: result.text,
            language: result.language || options.language || 'unknown',
            duration: result.duration || null
        };

    } catch (error) {
        console.error('Shared OpenAIClient: Error in transcribeAudio:', error);
        
        // Provide more specific error messages for common issues
        if (error.message.includes('413')) {
            throw new Error('Audio file is too large. Maximum size is 25MB.');
        } else if (error.message.includes('400')) {
            throw new Error('Invalid audio file format. Please use MP3, WAV, M4A, or other supported formats.');
        } else if (error.message.includes('429')) {
            throw new Error('Rate limit exceeded. Please try again later.');
        } else if (error.message.includes('401')) {
            throw new Error('OpenAI API authentication failed. Please check your API key.');
        }
        
        throw new Error(`Shared OpenAIClient: Transcription failed: ${error.message || String(error)}`);
    }
}

/**
 * Get appropriate content type based on file extension
 * @param {string} fileName - The file name with extension
 * @returns {string} MIME type
 */
function getContentType(fileName) {
    const extension = fileName.toLowerCase().split('.').pop();
    const contentTypes = {
        'mp3': 'audio/mpeg',
        'wav': 'audio/wav',
        'm4a': 'audio/m4a',
        'mp4': 'audio/mp4',
        'webm': 'audio/webm',
        'flac': 'audio/flac',
        'ogg': 'audio/ogg'
    };
    return contentTypes[extension] || 'audio/mpeg';
}

/**
 * Validate audio file format and size
 * @param {Buffer} audioBuffer - The audio file buffer
 * @param {string} fileName - The file name
 * @returns {Object} Validation result
 */
function validateAudioFile(audioBuffer, fileName) {
    const maxSize = 25 * 1024 * 1024; // 25MB in bytes
    const supportedFormats = ['mp3', 'wav', 'm4a', 'mp4', 'webm', 'flac', 'ogg', 'mpga', 'mpeg'];
    
    if (!audioBuffer || audioBuffer.length === 0) {
        return { valid: false, error: 'Audio buffer is empty' };
    }
    
    if (audioBuffer.length > maxSize) {
        return { valid: false, error: `File size (${Math.round(audioBuffer.length / 1024 / 1024)}MB) exceeds maximum of 25MB` };
    }
    
    const extension = fileName.toLowerCase().split('.').pop();
    if (!supportedFormats.includes(extension)) {
        return { valid: false, error: `Unsupported format: ${extension}. Supported: ${supportedFormats.join(', ')}` };
    }
    
    return { valid: true };
}

module.exports = {
    transcribeAudio,
    validateAudioFile,
    getContentType
}; 