# Cursor Agent Notes – Saucey Cloud Functions

This document provides guidelines for the Cursor AI agent to follow when modifying or generating code in this JavaScript-based Firebase Cloud Functions project. [cite: 1] All files are either `.js` (JavaScript) or `.json` (JSON). [cite: 2] The goal is to ensure consistent, maintainable, and secure code adhering to modern Node.js and Firebase best practices.


## 🤖 For Cursor AI Agent (Instruction)
When generating or modifying code, follow these conventions strictly. This file should be used as context for any AI-generated code.

- Always assume Node.js v20
- Always validate Firebase auth context
- Always prefer structured logging using `logger`
- Always throw `HttpsError` for client-visible errors in `onCall`
- Always refer to project’s file structure and reuse helpers from `@saucey/shared` when possible
- Avoid hardcoding secrets. Never do this
- NEVER use placeholder text or code



## 🔧 General Project Rules

-   **Node.js Version**: Use syntax compatible with **Node.js v20**. [cite: 3]
    * The project is configured for Node.js 20 (as seen in `package.json` engine specifications).
    * Avoid deprecated Node.js APIs.
-   **Module System**:
    * The project currently uses **CommonJS** (`require`/`module.exports`) extensively across its existing workspaces and functions (e.g., root `index.js`, `shared/index.js`, `notifications/index.js`). [cite: 5]
    * **For existing files**: Continue using CommonJS to maintain consistency.
    * **For genuinely new, standalone modules or utility files within the `shared` workspace or new workspaces**: Prefer ES Modules (`import`/`export`) if it doesn't create interoperability issues with the predominantly CommonJS project structure. [cite: 4]
-   **Code Modularity**:
    * Separate business logic from Firebase function entry points. [cite: 5]
    * Within each workspace/package (e.g., `handleRecipeChatTurn`, `notifications`), place reusable logic in subdirectories like `/utils` (for general utilities, validation, formatting) and `/services` (for business logic, external API interactions, Firestore operations). [cite: 6]
-   **Async Handling**: Use **async/await** for asynchronous operations. [cite: 6]
    * Avoid long `.then()` chains unless specifically managing multiple parallel promises (e.g., `Promise.all([...].then())`) or when interacting with legacy libraries that do not fully support promises for async operations. [cite: 7]
-   **Variable and Import Hygiene**: Remove unused variables, imports, or functions. Utilize ESLint (configured in the project with `no-unused-vars`) to help enforce this. [cite: 8]
-   **Error Handling**:
    * Catch and handle all errors explicitly. [cite: 9]
    * Log errors with meaningful context (e.g., `userId`, `functionName`, `chatId`, relevant input parameters). [cite: 9, 17]
-   **Code Formatting**: Follow Prettier settings defined in the project's `.prettierrc.json`. [cite: 10]
    * Key settings: `semi: true`, `trailingComma: "es5"`, `singleQuote: true`, `printWidth: 80`, `tabWidth: 2`. [cite: 11]
-   **JSDoc**: Use JSDoc comments for all exported functions, complex logic, and data structures to improve IDE support and code clarity. [cite: 11]

## 🧱 Firebase Cloud Functions Rules

-   **Function Types & SDK Versions**:
    * The project uses both v1 and v2 Firebase Functions SDKs.
    * **For new HTTP functions**: Prefer **Gen 2 `onRequest`** from `firebase-functions/v2/https` for public endpoints or non-Firebase clients. [cite: 13]
    * **For new callable functions**: Prefer **Gen 2 `onCall`** from `firebase-functions/v2/https` for authenticated, client-triggered functions.
    * **For new scheduled functions**: Use **Gen 2 `onSchedule`** from `firebase-functions/v2/scheduler` for recurring tasks (as seen in `feedbackFunctions` and `notifications`). [cite: 14]
    * When modifying existing functions, maintain consistency with their current SDK version unless a specific migration is planned.
-   **Logging**:
    * Use **`logger`** from `firebase-functions` (for v1 functions) or `firebase-functions/v2` (for v2 functions) for all logging (`logger.debug()`, `logger.info()`, `logger.warn()`, `logger.error()`). [cite: 15]
    * Avoid `console.log` to ensure logs are structured and optimally processed in Google Cloud Logging (Firebase Console). [cite: 16]
    * Include contextual information in logs (e.g., `userId`, `functionName`, `recipeId`, `chatId`) for effective debugging. [cite: 17]
-   **Error Handling in Functions**:
    * Catch all errors and log them using `logger.error()` with a descriptive message, error object (including stack trace if available), and relevant context. [cite: 18]
    * For `onCall` functions (v1 and v2), throw `functions.https.HttpsError` (for v1) or `HttpsError` (from `firebase-functions/v2/https` for v2) with standard error codes (e.g., `unauthenticated`, `invalid-argument`, `internal`). [cite: 19]
-   **Response Structure**:
    * For `onCall` functions, return consistent JSON responses:
        ```javascript
        // Success
        { success: true, data: { /* response data */ } } // Or just the data for v2 by default
        // Error: Should be handled by throwing HttpsError, which client SDKs will interpret.
        ```
        *The example in the original rules shows returning an error object, but for `onCall`, throwing `HttpsError` is the standard way for the client to receive a structured error.*
    * For `onRequest` functions, use appropriate HTTP status codes (e.g., `200 OK`, `201 Created`, `400 Bad Request`, `401 Unauthorized`, `403 Forbidden`, `500 Internal Server Error`). [cite: 21]
-   **Authentication**:
    * In `onCall` functions, rigorously validate `context.auth` (v1) or `request.auth` (v2). If authentication is required and missing or invalid, throw an `unauthenticated` HttpsError. [cite: 22]
    * Derive user-specific data (like UID) from the `auth` object rather than relying on client-sent UIDs for security-sensitive operations. [cite: 23]
-   **Performance**:
    * Minimize cold starts by lazy-initializing global variables/SDK clients where appropriate, especially if they are large or only used by specific functions. (e.g., initialize Firestore or other SDKs outside function handlers if shared, or within if specific to one rarely-used function). [cite: 24]
    * Optimize Firebase Admin SDK usage: batch Firestore operations when modifying multiple documents, design queries efficiently, and avoid redundant data fetching. [cite: 25]
-   **Environment Configuration & Secrets**:
    * Utilize environment variables for configuration. These can be set during deployment (e.g., `gcloud functions deploy --set-env-vars`) or defined using `param` types with `.env` files for Firebase Gen 2 functions.
    * Store sensitive data like API keys in Secret Manager and access them securely within functions (as seen with `SecretManagerServiceClient` in `shared/services/geminiClient.js` and `feedbackFunctions/feedbackService.js`). Avoid hardcoding secrets. [cite: 27]
-   **Testing**:
    * Write unit tests for business logic (e.g., services, utils). Jest is a good option. [cite: 28]
    * Place tests in a relevant `/test` or `/tests` directory within each workspace/package.
    * Mock Firebase Admin SDK, other external services (like Gemini client calls), and Firestore interactions during unit testing. [cite: 29]

## 📂 Project Structure (Observed Monorepo with Workspaces)

The project is structured as a monorepo using npm workspaces, with main Cloud Functions code located in the root `functions` directory which then references these workspaces.

/saucey-cloud-functions  (Root of the functions project)
/feedbackFunctions               // Workspace for feedback-related functions
feedbackService.js             // Entry point and logic for feedback functions
config.js
package.json
/handleRecipeChatTurn            // Workspace for recipe chat handling
index.js                       // Entry point for handleRecipeChat
/services
/processors
/utils
/prompts
config.js
package.json
/notifications                   // Workspace for notification logic
index.js                       // Aggregates notification functions
/aiLogic
/config
/services
/triggers
package.json (implicitly, not provided but typical for a workspace)
/shared                          // Workspace for shared utilities and services
index.js                       // Exports shared modules
/config
/middleware
/services
/utils
package.json
/debugFunctions                  // Workspace for debug utilities
sendDebugNotification.js
package.json (implicitly)
index.js                         // Root Firebase entry point, aggregates and exports functions
package.json                     // Root package.json defining workspaces
firebase.json
.prettierrc.json
... other config files


-   **Workspaces**: Each major feature area (e.g., `feedbackFunctions`, `handleRecipeChatTurn`, `notifications`) is a separate workspace/package. Shared code resides in the `@saucey/shared` workspace.
-   **Modularity within Workspaces**: Inside each workspace, code is further organized into directories like `/services`, `/utils`, `/config`, `/prompts`, `/triggers` as appropriate.
-   **Function Entry Points**: Firebase function entry points are typically defined in a main file within each workspace (e.g., `feedbackService.js`, `handleRecipeChatTurn/index.js`) and then aggregated and re-exported by the root `index.js`.

## 🛠️ Code Style and Best Practices

-   **Naming Conventions**:
    * Functions and variables: `camelCase`.
    * Constants: `UPPER_SNAKE_CASE`.
    * Files: `kebab-case.js` or `camelCase.js` (project shows a mix, `kebab-case.js` is generally good for discoverability, `camelCase.js` is also common). `recipeJsonSchema.js` is an example of camelCase. Let's prefer `camelCase.js` for JS files and `kebab-case.json` for JSON to align with some existing patterns, but consistency within a workspace is key. [cite: 32, 33]
-   **Comments**:
    * Use JSDoc for all exported functions and complex internal functions:
        ```javascript
        /**
         * Brief description of the function's purpose.
         * @param {type} paramName - Description of the parameter.
         * @param {string} paramName.property - Description of a property if param is an object.
         * @returns {Promise<type>} Description of the returned value, wrapped in Promise if async.
         * @throws {HttpsError} Description of errors thrown (especially for onCall).
         */
        ```
    * Add inline comments to explain non-obvious logic. Avoid comments that merely restate the code. [cite: 33]
-   **Dependencies**:
    * Minimize external dependencies to reduce bundle size and cold start times. Favor using shared utilities where possible. [cite: 34]
    * Use specific versions in `package.json` (e.g., `"@google-cloud/firestore": "^7.0.0"`) and rely on `package-lock.json` to ensure reproducible builds. Avoid overly broad version ranges for direct dependencies. [cite: 35]
-   **Security**:
    * Sanitize user inputs, especially for direct database queries or when constructing dynamic responses. [cite: 36]
    * Do not log raw sensitive data (e.g., full API keys, user's personal details beyond UID for context). Redact sensitive parts if necessary for debugging. [cite: 37]
    * Be mindful of data returned to clients; only send what's necessary.
-   **Firestore**:
    * Ensure Firestore security rules are in place and align with function logic to prevent unauthorized data access or modification. [cite: 38]
    * Use Firestore transactions for operations that require atomic updates across multiple documents. [cite: 39]
    * Leverage the `shared/services/firestoreHelper.js` for common operations.

## 🚀 Example Function (Adjusted for CommonJS and Project Structure)

Example of a well-structured `onCall` function, reflecting current project patterns:

```javascript
// Example: in a file like /your-feature-workspace/userFunctions.js
const functions = require('firebase-functions'); // Or specific v2 import
const { logger } = functions; // Or from v2
// Assuming authMiddleware might be used differently for onCall, or manual check as per rules.
// const { authenticateFirebaseToken } -- typically for onRequest. onCall provides context.auth.
const { HttpsError } = require('firebase-functions/v2/https'); // For v2
// const { validateInput } = require('@saucey/shared/utils/validators'); // Assuming a validator utility
// const { updateUserProfile } = require('./services/userService'); // Local service

/**
 * Updates a user's profile data.
 * @param {object} data - The data sent by the client. Expected to contain profile details.
 * @param {functions.https.CallableContext} context - Firebase callable function context.
 * @returns {Promise<{success: boolean, data?: object, error?: string, code?: string}>} Structured response.
 */
exports.updateUserProfile = functions.https.onCall(async (data, context) => { // Or v2: onCall(async (request) => { const data = request.data; const context = request; ... })
  // 1. Authentication Check
  if (!context.auth) {
    logger.warn('updateUserProfile: Unauthenticated access attempt.');
    throw new HttpsError('unauthenticated', 'The function must be called while authenticated.'); // [cite: 19, 22]
  }
  const userId = context.auth.uid;

  try {
    // 2. Input Validation (Example)
    // const validatedData = validateInput(data, {
    //   displayName: { type: 'string', maxLength: 50, optional: true },
    //   // Add other fields and validation rules
    // });
    // if (!validatedData.valid) {
    //   logger.warn('updateUserProfile: Invalid input data.', { userId, errors: validatedData.errors });
    //   throw new HttpsError('invalid-argument', 'Invalid input data.', validatedData.errors);
    // }
    const { displayName } = data; // Assuming simple data for example
    if (typeof displayName !== 'string' || displayName.length === 0) {
        throw new HttpsError('invalid-argument', 'Display name must be a non-empty string.');
    }


    // 3. Business Logic (e.g., calling a service)
    // const result = await updateUserProfile(userId, validatedData.sanitizedData);
    // For example, directly update Firestore using the shared helper:
    const firestoreHelper = require('@saucey/shared/services/firestoreHelper');
    await firestoreHelper.saveDocument('users', userId, { displayName: displayName }, { merge: true });
    logger.info('updateUserProfile: Profile updated successfully.', { userId });

    return { // [cite: 20]
      success: true,
      data: { message: 'Profile updated successfully.' }
    };
  } catch (error) {
    logger.error('updateUserProfile: Error updating profile.', { // [cite: 18]
      userId,
      errorMessage: error.message,
      errorCode: error.code, // HttpsError code
      stack: error.stack,
    });

    if (error instanceof HttpsError) { // Or functions.https.HttpsError for v1
      throw error; // Re-throw HttpsError directly
    }
    // For other unexpected errors:
    throw new HttpsError('internal', 'An unexpected error occurred while updating the profile.');
  }
});