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
  const defaultChapters = ["Breakfast", "Lunch", "Dinner", "Desserts"];

  const batch = db.batch();
  const chaptersCollectionRef = db
    .collection("users")
    .doc(userId)
    .collection("chapters");

  defaultChapters.forEach((chapterName) => {
    const newChapterRef = chaptersCollectionRef.doc(); // Firestore auto-generates ID
    batch.set(newChapterRef, {
      name: chapterName,
      createdAt: admin.firestore.FieldValue.serverTimestamp(), // Good practice to add a timestamp
      recipeCount: 0, // Initialize recipe count
    });
    console.log(`${logPrefix}  - Added '${chapterName}' to batch.`);
  });

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