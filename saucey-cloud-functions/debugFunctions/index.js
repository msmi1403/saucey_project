const functions = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const secretManagerClient = new SecretManagerServiceClient();

// Changed from onCall to onRequest for easier curl testing
exports.testSecretAccess = functions.onRequest(async (request, response) => {
    logger.info("testSecretAccess (HTTP): Function called.");
    const secretName = 'saucey-gemini-key'; // Using saucey-gemini-key as the test secret
    const projectId = process.env.GCLOUD_PROJECT || 'saucey-3fb0f'; // Your project ID
    const name = `projects/${projectId}/secrets/${secretName}/versions/latest`;

    try {
        logger.info(`testSecretAccess (HTTP): Attempting to access secret: ${name}`);
        const [version] = await secretManagerClient.accessSecretVersion({ name });
        const payload = version.payload.data.toString("utf8");
        logger.info(`testSecretAccess (HTTP): Successfully accessed secret '${secretName}'. Value starts with: ${payload.substring(0, 10)}...`);
        response.status(200).json({ success: true, secretStart: payload.substring(0, 10) });
    } catch (error) {
        logger.error(`testSecretAccess (HTTP): Error retrieving secret '${secretName}'. Code: ${error.code}, Message: ${error.message}`, { errorDetails: error.details, fullError: error });
        response.status(500).json({
            success: false,
            message: `Failed to access secret '${secretName}': ${error.message}`,
            errorCode: error.code,
            errorDetails: error.details
        });
    }
}); 