// In saucey-cloud-functions/shared/middleware/authMiddleware.js
// 
// DEPRECATED: This middleware is no longer needed as functions have been converted to onCall
// which provides built-in authentication. This file can be removed once all functions
// have been migrated away from onRequest pattern.

const admin = require('firebase-admin');

// Initialize Firebase Admin SDK only once
try {
    if (admin.apps.length === 0) {
        admin.initializeApp();
        console.log('Firebase Admin SDK initialized in authMiddleware.');
    }
} catch (e) {
    console.error('CRITICAL: Firebase Admin SDK initialization error in authMiddleware:', e.message, e.stack); // Log stack too
    throw new Error(`Failed to initialize Firebase Admin SDK in authMiddleware: ${e.message}`); // Re-throw
}

/**
 * Middleware to verify Firebase ID token.
 * If valid, attaches the decoded token and userId to the request object.
 * If invalid or missing, sends a 401/403 response.
 */
const authenticateFirebaseToken = async (req, res, next) => {
    const authorizationHeader = req.headers.authorization;

    if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) {
        console.warn('No Firebase ID token was passed as a Bearer token in the Authorization header.');
        return res.status(401).json({
            error: 'Unauthorized: No token provided.',
            status: 'error'
        });
    }

    const idToken = authorizationHeader.split('Bearer ')[1];

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.user = decodedToken; // Attach decoded token (includes uid, email, etc.)
        req.userId = decodedToken.uid; // Specifically attach userId for convenience
        console.log(`Authenticated user: ${req.userId}`);
        return next(); // Proceed to the main function handler
    } catch (error) {
        console.error('Error verifying Firebase ID token:', error.message, 'Code:', error.code);
        let statusCode = 403; // Forbidden
        let errorMessage = 'Forbidden: Invalid or expired token.';

        if (error.code === 'auth/id-token-expired') {
            statusCode = 401; // Unauthorized - token expired
            errorMessage = 'Unauthorized: Token expired. Please re-authenticate.';
        } else if (error.code === 'auth/argument-error') {
            // This can happen if the token is malformed or verifyIdToken isn't setup correctly
            statusCode = 401;
            errorMessage = 'Unauthorized: Malformed token or authentication setup issue.';
        }
        // Add more specific error handling based on Firebase Auth error codes if needed

        return res.status(statusCode).json({
            error: errorMessage,
            status: 'error'
        });
    }
};

module.exports = {
    authenticateFirebaseToken
};