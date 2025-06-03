// triggers/authTriggers.js
const functions = require("firebase-functions");   // v6.x (still installed in package.json)
const admin     = require("firebase-admin");

const db = admin.firestore();

/**
 * HTTPS Endpoint: createDefaultChapters
 * Expects a POST payload { uid: "<newUserUid>" }.
 * Call this from your client immediately after you complete sign-up.
 */
exports.createDefaultChapters = functions.https.onRequest(async (req, res) => {
  // Only allow POST
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const uid = req.body.uid;
  if (typeof uid !== "string" || !uid.match(/^.{20,}$/)) {
    res.status(400).send("Invalid or missing UID");
    return;
  }

  const logPrefix = `createDefaultChapters[User:${uid}]`;

  functions.logger.log(`${logPrefix}: received request.`);

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
    functions.logger.log(`${logPrefix}: successfully created default chapter.`);
    res.status(200).send({ success: true });
  } catch (err) {
    functions.logger.error(`${logPrefix}: error creating chapter:`, err);
    res.status(500).send({ error: err.message });
  }
});