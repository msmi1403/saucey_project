const globalConfig = require('@saucey/shared/config/globalConfig.js');
const { logger } = require("firebase-functions/v2");

/**
 * Validates image MIME type against supported types
 * @param {string} mimeType - The MIME type to validate
 * @returns {boolean} - True if valid
 */
function isValidImageMimeType(mimeType) {
    return globalConfig.SUPPORTED_IMAGE_MIME_TYPES.includes(mimeType);
}

/**
 * Validates image size against maximum allowed size
 * @param {Buffer} imageBuffer - The image buffer to check
 * @returns {boolean} - True if valid size
 */
function isValidImageSize(imageBuffer) {
    return imageBuffer.length <= globalConfig.MAX_IMAGE_UPLOAD_SIZE_BYTES;
}

/**
 * Validates base64 image data and returns buffer
 * @param {string} imageDataBase64 - Base64 encoded image data
 * @param {string} imageMimeType - MIME type of the image
 * @returns {Object} - { isValid: boolean, buffer?: Buffer, error?: string }
 */
function validateImageData(imageDataBase64, imageMimeType) {
    // Check required fields
    if (!imageDataBase64 || !imageMimeType) {
        return {
            isValid: false,
            error: 'Missing required fields: imageDataBase64 and imageMimeType'
        };
    }

    // Validate MIME type
    if (!isValidImageMimeType(imageMimeType)) {
        return {
            isValid: false,
            error: `Invalid image MIME type: ${imageMimeType}. Supported: ${globalConfig.SUPPORTED_IMAGE_MIME_TYPES.join(', ')}`
        };
    }

    // Validate base64 data
    let imageBuffer;
    try {
        imageBuffer = Buffer.from(imageDataBase64, 'base64');
    } catch (error) {
        return {
            isValid: false,
            error: 'Invalid base64 image data'
        };
    }

    // Validate size
    if (!isValidImageSize(imageBuffer)) {
        return {
            isValid: false,
            error: `Image size too large (max ${globalConfig.MAX_IMAGE_UPLOAD_SIZE_BYTES / (1024 * 1024)}MB). Current size: ${(imageBuffer.length / (1024 * 1024)).toFixed(2)}MB`
        };
    }

    logger.info(`Shared ImageProcessor: Image validation passed - Size: ${imageBuffer.length} bytes, MIME: ${imageMimeType}`);

    return {
        isValid: true,
        buffer: imageBuffer
    };
}

/**
 * Prepares image data for Gemini API calls
 * @param {string} imageDataBase64 - Base64 encoded image data
 * @param {string} imageMimeType - MIME type of the image
 * @returns {Object} - { success: boolean, imagePart?: Object, error?: string }
 */
function prepareImageForGemini(imageDataBase64, imageMimeType) {
    const validation = validateImageData(imageDataBase64, imageMimeType);
    
    if (!validation.isValid) {
        return {
            success: false,
            error: validation.error
        };
    }

    // Create the image part for Gemini API
    const imagePart = {
        inlineData: {
            data: imageDataBase64,
            mimeType: imageMimeType
        }
    };

    logger.info(`Shared ImageProcessor: Image prepared for Gemini - MIME: ${imageMimeType}, Size: ${validation.buffer.length} bytes`);

    return {
        success: true,
        imagePart
    };
}

/**
 * Validates an imageURL to ensure it's a proper HTTP/HTTPS URL
 * @param {string|null} imageUrl - The URL to validate
 * @returns {string|null} - Valid URL or null
 */
function validateImageURL(imageUrl) {
    if (!imageUrl || typeof imageUrl !== 'string') {
        return null;
    }
    
    const trimmed = imageUrl.trim();
    if (!trimmed) {
        return null;
    }
    
    // Reject obvious descriptive text
    if (trimmed.toLowerCase().includes('image of') || 
        trimmed.toLowerCase().includes('photo of') || 
        trimmed.toLowerCase().includes('picture of') ||
        trimmed.includes(' ') && !trimmed.includes('://')) {
        logger.info(`Shared ImageProcessor: Rejecting descriptive text: "${trimmed}"`);
        return null;
    }
    
    try {
        const url = new URL(trimmed);
        if (url.protocol === 'http:' || url.protocol === 'https:') {
            return trimmed;
        }
    } catch (e) {
        // Invalid URL
    }
    
    logger.info(`Shared ImageProcessor: Rejecting invalid URL: "${trimmed}"`);
    return null;
}

/**
 * Processes and validates image input following the proven working approach
 * @param {string} imageDataBase64 - Base64 encoded image data
 * @param {string} imageMimeType - MIME type of the image
 * @param {string} functionName - Name of the calling function (for logging)
 * @returns {Object} - { success: boolean, imagePart?: Object, buffer?: Buffer, error?: string }
 */
function processImageInput(imageDataBase64, imageMimeType, functionName = 'Unknown') {
    logger.info(`Shared ImageProcessor: Processing image for ${functionName}...`);

    const validation = validateImageData(imageDataBase64, imageMimeType);
    
    if (!validation.isValid) {
        logger.error(`Shared ImageProcessor: Validation failed for ${functionName}: ${validation.error}`);
        return {
            success: false,
            error: validation.error
        };
    }

    const imagePart = {
        inlineData: {
            data: imageDataBase64,
            mimeType: imageMimeType
        }
    };

    logger.info(`Shared ImageProcessor: Successfully processed image for ${functionName} - Size: ${validation.buffer.length} bytes, MIME: ${imageMimeType}`);

    return {
        success: true,
        imagePart,
        buffer: validation.buffer
    };
}

module.exports = {
    // Main processing functions
    processImageInput,
    prepareImageForGemini,
    
    // Validation functions
    validateImageData,
    isValidImageMimeType,
    isValidImageSize,
    validateImageURL,
    
    // Constants (re-exported for convenience)
    MAX_IMAGE_UPLOAD_SIZE_BYTES: globalConfig.MAX_IMAGE_UPLOAD_SIZE_BYTES,
    SUPPORTED_IMAGE_MIME_TYPES: globalConfig.SUPPORTED_IMAGE_MIME_TYPES,
}; 