const functions = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const { HttpsError } = require("firebase-functions/v2/https");

/**
 * Creates a generic stub callable function for testing and placeholder purposes.
 * @param {string} functionName - The name of the function, used in logging.
 * @returns {functions.https.CallableFunction}
 */
const createStubFunction = (functionName) => {
  return functions.onCall(async (request) => {
    logger.info(`${functionName}_stub: Called`);
    if (!request.auth) {
      logger.warn(`${functionName}_stub: Unauthenticated access attempt.`);
      throw new HttpsError("unauthenticated", "The function must be called while authenticated.");
    }
    logger.info(`${functionName}_stub: Authenticated user: ${request.auth.uid}`, { data: request.data });
    return { success: true, message: `${functionName} stub executed successfully.`, inputData: request.data };
  });
};

module.exports = { createStubFunction }; 