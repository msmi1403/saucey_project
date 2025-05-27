// saucey-cloud-functions/shared/utils/commonUtils.js
const { v4: uuidv4 } = require('uuid'); // Still needed

/**
 * Generates a unique UUID.
 * @returns {string} A unique UUID string.
 */
function generateUniqueId() {
    return uuidv4();
}

/**
 * Attempts to clean common issues from a JSON string (often from LLM outputs)
 * and then parses it.
 * @param {string} rawJsonString - The raw string suspected to contain JSON.
 * @returns {object|Array} The parsed JSON object or array.
 * @throws {Error} If parsing fails even after cleaning.
 */
function scrubAndParseJsonString(rawJsonString) {
    if (typeof rawJsonString !== 'string') {
        console.warn(`scrubAndParseJsonString expected a string, got ${typeof rawJsonString}`);
        rawJsonString = String(rawJsonString);
    }

    // Remove markdown ```json ... ``` and ``` fences, trim whitespace
    let processedString = rawJsonString.replace(/^```(?:json)?\s*|\s*```$/gim, '').trim();

    try {
        return JSON.parse(processedString);
    } catch (e) {
        console.warn(`Initial JSON parse failed (first 500 chars): ${processedString.substring(0, 500)}... Error: ${e.message}`);

        // Attempt common fixes
        // 1. Remove single-line // comments
        let fixedString = processedString.replace(/\/\/.*$/gm, '');
        // 2. Remove multi-line /* ... */ comments
        fixedString = fixedString.replace(/\/\*[\s\S]*?\*\//g, '');
        // 3. Remove trailing commas before closing brackets/braces
        fixedString = fixedString.replace(/,\s*([\]}])/g, '$1');
        // 4. Normalize Python/JS literals to JSON
        fixedString = fixedString
            .replace(/\bNone\b/g, 'null')
            .replace(/\bTrue\b/g, 'true')
            .replace(/\bFalse\b/g, 'false')
            .replace(/\bundefined\b/g, 'null')
            .replace(/…/g, '...'); // Ellipsis

        try {
            return JSON.parse(fixedString);
        } catch (finalError) {
            console.error(`JSON parsing still failed after fixes (first 500 chars): ${fixedString.substring(0, 500)}... Error: ${finalError.message}`);
            throw new Error(`Invalid JSON format after cleaning: ${finalError.message}`);
        }
    }
}


/**
 * Extracts the first valid JSON object or array string from a larger text blob
 * and then parses it using scrubAndParseJsonString.
 * @param {string} text - The text containing potential JSON.
 * @returns {object|Array} The parsed JSON object or array.
 * @throws {Error} If no JSON is found or parsing fails.
 */
function extractJsonFromText(text) {
    if (typeof text !== 'string') {
        console.warn(`extractJsonFromText expected a string, got ${typeof text}. Attempting to stringify.`);
        text = String(text);
    }
    // Regex to find content between the first '{' and last '}' or first '[' and last ']'
    // This is a common pattern for LLM outputs that might have leading/trailing text.
    const matchObject = text.match(/\{[\s\S]*\}/);
    const matchArray = text.match(/\[[\s\S]*\]/);

    let jsonStr;

    if (matchObject && matchArray) {
        // If both object and array are found, pick the one that appears first
        jsonStr = text.indexOf(matchObject[0]) < text.indexOf(matchArray[0]) ? matchObject[0] : matchArray[0];
    } else if (matchObject) {
        jsonStr = matchObject[0];
    } else if (matchArray) {
        jsonStr = matchArray[0];
    } else {
        // If no clear object or array, try to parse the whole thing after basic scrubbing
        console.warn('No clear JSON object or array delimiters found, attempting to parse entire text after scrubbing.');
        try {
            return scrubAndParseJsonString(text); // Try to parse the whole text if no clear delimiters
        } catch (e) {
            throw new Error(`No JSON object or array found in text, and full text parsing failed: ${e.message}`);
        }
    }
    return scrubAndParseJsonString(jsonStr);
}

/**
 * Validates if a given MIME type is present in an array of allowed MIME types.
 * @param {string} mimeType - The MIME type string to validate.
 * @param {string[]} allowedTypesArray - An array of allowed MIME type strings (case-insensitive).
 * @returns {boolean} True if valid and in the array, false otherwise.
 */
function isValidMimeType(mimeType, allowedTypesArray) {
    if (!mimeType || typeof mimeType !== 'string' || !Array.isArray(allowedTypesArray)) {
        return false;
    }
    return allowedTypesArray.map(type => type.toLowerCase()).includes(mimeType.toLowerCase());
}

module.exports = {
    generateUniqueId,
    scrubAndParseJsonString,
    extractJsonFromText,
    isValidMimeType, // Add the new generic function
};