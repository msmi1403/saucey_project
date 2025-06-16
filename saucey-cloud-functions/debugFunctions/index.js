const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const secretManagerClient = new SecretManagerServiceClient();

// Secured with onCall for authenticated testing only
exports.testSecretAccess = onCall(async (request) => {
    // Authentication check
    if (!request.auth) {
        logger.warn('testSecretAccess: Unauthenticated access attempt.');
        throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }

    logger.info("testSecretAccess: Function called by user:", request.auth.uid);
    const secretName = 'saucey-gemini-key'; // Using saucey-gemini-key as the test secret
    const projectId = process.env.GCLOUD_PROJECT || 'saucey-3fb0f'; // Your project ID
    const name = `projects/${projectId}/secrets/${secretName}/versions/latest`;

    try {
        logger.info(`testSecretAccess: Attempting to access secret: ${name}`);
        const [version] = await secretManagerClient.accessSecretVersion({ name });
        const payload = version.payload.data.toString("utf8");
        logger.info(`testSecretAccess: Successfully accessed secret '${secretName}'. Value starts with: ${payload.substring(0, 10)}...`);
        return { success: true, secretStart: payload.substring(0, 10) };
    } catch (error) {
        logger.error(`testSecretAccess: Error retrieving secret '${secretName}'. Code: ${error.code}, Message: ${error.message}`, { errorDetails: error.details, fullError: error });
        throw new HttpsError('internal', `Failed to access secret '${secretName}': ${error.message}`);
    }
}); 