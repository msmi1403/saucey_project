const functions = require("firebase-functions"); // Reverting to v1 for auth triggers
const admin = require("firebase-admin");

// Admin SDK should be initialized in root index.js, so we can just get db instance
const db = admin.firestore();

/**
 * Auth Trigger: onCreate - Creates default cookbook chapters for a new user.
 */
const createDefaultChapters = functions.auth.user().onCreate(async (userRecord) => {
  const userId = userRecord.uid;
  const logPrefix = `createDefaultChapters[User:${userId}]:`;

  console.log(`${logPrefix} Creating default chapters for new user.`);
  const defaultChapterDetails = {
    name: "Favorites",
    iconName: "icon_pasta",
    colorHex: "#FF2D55",
    description: "Your most loved recipes.",
    recipeCount: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  const batch = db.batch();
  const chaptersCollectionRef = db
    .collection("users")
    .doc(userId)
    .collection("chapters");

  // Create only the "Favorites" chapter with details
  const newChapterRef = chaptersCollectionRef.doc(); // Firestore auto-generates ID
  batch.set(newChapterRef, defaultChapterDetails);
  console.log(`${logPrefix}  - Added '${defaultChapterDetails.name}' chapter with details to batch.`);

  try {
    await batch.commit();
    console.log(`${logPrefix} Successfully created default chapters.`);
    return null;
  } catch (error) {
    console.error(`${logPrefix} Error creating default chapters:`, error);
    // Optionally, re-throw or handle more gracefully depending on desired error propagation
    return null; // Default behavior from original function
  }
});

module.exports = {
  createDefaultChapters,
}; 