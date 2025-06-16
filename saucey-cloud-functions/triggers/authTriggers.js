// triggers/authTriggers.js
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const admin = require("firebase-admin");

const db = admin.firestore();

/**
 * Callable Function: createDefaultChapters
 * Creates default chapters for the authenticated user.
 * Call this from your client immediately after you complete sign-up.
 * User authentication is required - UID is automatically derived from the authenticated token.
 */
exports.createDefaultChapters = onCall(async (request) => {
  // Add authentication check
  if (!request.auth) {
    logger.warn("createDefaultChapters: Unauthenticated access attempt");
    throw new HttpsError("unauthenticated", "The function must be called while authenticated.");
  }

  // Use authenticated user's UID
  const uid = request.auth.uid;
  const logPrefix = `createDefaultChapters[User:${uid}]`;

  logger.info(`${logPrefix}: Creating chapters for authenticated user: ${uid}`);

  const defaultChapter = {
    name:        "Favorites",
    iconName:    "icon_pasta",
    colorHex:    "#FF2D55",
    description: "Your most loved recipes.",
    recipeCount: 0,
    createdAt:   admin.firestore.FieldValue.serverTimestamp(),
  };

  try {
    const chaptersRef = db
      .collection("users")
      .doc(uid)
      .collection("chapters");

    await chaptersRef.doc().set(defaultChapter);
    logger.info(`${logPrefix}: successfully created default chapter.`);
    return { success: true };
  } catch (err) {
    logger.error(`${logPrefix}: error creating chapter:`, err);
    throw new HttpsError("internal", "Failed to create default chapters", err.message);
  }
});