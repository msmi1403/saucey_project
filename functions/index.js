// functions/index.js

const admin = require("firebase-admin");
//const functions = require("firebase-functions");
const cors = require("cors")({ origin: true });
const Typesense = require("typesense"); 
// --- Import the specific v2 triggers ---
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const functions = require("firebase-functions/v1");

const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");

const secretClient = new SecretManagerServiceClient();
admin.initializeApp();
const db = admin.firestore();


// Constants for recipe fetching
const DEFAULT_ITEMS_PER_CATEGORY = 7;
const CREATOR_PROFILE_FEATURED_LIMIT = 10; // Max featured on profile
const CREATOR_PROFILE_ALL_PUBLIC_LIMIT = 20;

// ==============================================
// --- Typesense Configuration & Initialization ---
// ==============================================

// Helper function to retrieve secrets securely
async function getSecretValue(secretName) {
  try {
    const projectId = process.env.GCLOUD_PROJECT; // Use the standard environment variable
    if (!projectId) {
      // Keep the error check
      console.error("FATAL: Google Cloud Project ID env not found.");
      throw new Error("Google Cloud Project ID not found.");
    }
    const name = `projects/${projectId}/secrets/${secretName}/versions/latest`;
    const [version] = await secretClient.accessSecretVersion({ name: name });
    const payload = version.payload.data.toString("utf8");
    console.log(`Successfully retrieved secret: ${secretName}`);
    return payload;
  } catch (error) {
    console.error(`Error retrieving secret ${secretName}:`, error);
    throw error; // Propagate the error
  }
}

// Initialize the Typesense client (async IIFE for top-level await)
// We use the ADMIN key here for the sync functions in this file.
let typesenseSearchClient; // Rename for clarity
(async () => {
  try {
    console.log("Initializing Typesense client for SEARCH...");
    const host = await getSecretValue("TYPESENSE_HOST");
    const port = await getSecretValue("TYPESENSE_PORT");
    const protocol = await getSecretValue("TYPESENSE_PROTOCOL");
    const searchApiKey = await getSecretValue("TYPESENSE_SEARCH_API_KEY"); // <-- SEARCH KEY

    typesenseSearchClient = new Typesense.Client({
      nodes: [{ host, port: parseInt(port, 10), protocol }],
      apiKey: searchApiKey, // <-- SEARCH KEY
      connectionTimeoutSeconds: 5, 
    });
    console.log("Typesense SEARCH client initialized successfully.");
  } catch (error) {
    console.error("FATAL: Failed to initialize Typesense SEARCH client:", error);
    typesenseSearchClient = null; 
  }
})();

// --- Typesense Schema Definition ---
const RECIPES_COLLECTION = "public_recipes"; // Collection name constant

const recipeSchema = {
  name: RECIPES_COLLECTION,
  fields: [
    // --- Swift `title: String` ---
    // Make it searchable (index: true) and required (no optional: true).
    { name: "title", type: "string", index: true },
    { name: "recipeId", type: "string", index: false },
    { name: "createdByUsername", type: "string", facet: true, optional: true },
    { name: "imageURL", type: "string", index: false, optional: true },
    { name: "cuisine", type: "string", facet: true, optional: true },
    { name: "tags", type: "string[]", facet: true, optional: true },
    { name: "saveCount", type: "int64", sort: true, default: 0 },
    { name: "averageRating", type: "float", sort: true, optional: true },
    { name: "reviewCount", type: "int64", optional: true, default: 0 },
    { name: "createdAt", type: "int64", sort: true, optional: true },
    { name: "isPublic", type: "bool", facet: true },
    { name: "difficulty", type: "string", facet: true, optional: true },
    { name: "category", type: "string", facet: true, optional: true },
    { name: "total_time", type: "string", optional: true, index: false },

    // --- Fields NOT included (User-Specific or Complex) ---
    // createdByUserId: Generally not needed if createdByUsername is present.
    // servings: Add as {"name": "servings", "type": "int64", "facet": true, "optional": true} if needed for filtering.
    // ingredients: See note below.
    // instructions: See note below.
    // source: Probably not needed for public searching/filtering.
    // cookedCount: User-specific.
    // privateNoteEntries: User-specific.
    // isBookmarked: User-specific.
    // lastCookedDate: User-specific.
  ],
  // --- Default Sorting Order ---
  // Results will be sorted by relevance (_text_match) first, then saveCount.
  default_sorting_field: "saveCount", // Can still override in search query
};

// --- Helper to Ensure Collection Exists ---
async function ensureTypesenseCollectionExists(client) {
  if (!client) {
    console.error("ensureTypesenseCollectionExists: FATAL - Client not provided.");
    // Example of splitting the error string
    throw new Error(
      "Typesense client not provided to " +
      "ensureTypesenseCollectionExists."
    );
  }
  const collectionName = RECIPES_COLLECTION; 
  try {
    console.log(
      `ensureTypesenseCollectionExists: Attempting to retrieve collection '${collectionName}'...`
    );
    await client.collections(collectionName).retrieve();
    console.log(
      `ensureTypesenseCollectionExists: Collection '${collectionName}' already exists.`
    );
  } catch (retrieveError) {
    console.log(
      `ensureTypesenseCollectionExists:during retrieve: Status=${retrieveError.httpStatus}, ` + // Split log
      `Message=${retrieveError.message}`
     );
     if (retrieveError.name === 'ObjectNotFound') {
      console.log(
        `ensureTypesenseCollectionExists: Collection '${collectionName}' not found (404), ` + // Split log
        `attempting creation...`
      );
      try {
        await client.collections().create(recipeSchema); 
        console.log(
          `ensureTypesenseCollectionExists: Successfully CREATED collection '${collectionName}'.`
        );
      } catch (createError) {
        console.error(
          `ensureTypesenseCollectionExists: FAILED to CREATE collection '${collectionName}':`, 
          createError
         );
        // Split error string
        throw new Error(
          `Failed to create Typesense collection: ${createError.message}`
        ); 
      }
    } else {
      console.error(
        `ensureTypesenseCollectionExists: Error retrieving coll '${collectionName}' (not 404):`, 
        retrieveError
       );
      // Split error string
      throw new Error(
        `Failed to retrieve Typesense collection info: ${retrieveError.message}`
      );
    }
  }
}

// ==============================================
// --- Cloud Functions ---
// ==============================================



exports.createDefaultChapters = functions.auth.user().onCreate(async (userRecord) => {
  const userId = userRecord.uid;

  console.log(`Creating default chapters for new user: ${userId}`);
  const defaultChapters = ["Breakfast", "Lunch", "Dinner", "Desserts"];

  const batch = db.batch();
  const chaptersCollectionRef = db.collection("users").doc(userId).collection("chapters");

  defaultChapters.forEach((chapterName) => {
    const newChapterRef = chaptersCollectionRef.doc();
    batch.set(newChapterRef, { name: chapterName });
    console.log(`  - Added '${chapterName}' to batch for user ${userId}`);
  });

  try {
    await batch.commit();
    console.log(`Successfully created default chapters for user: ${userId}`);
    return null;
  } catch (error) {
    console.error(`Error creating default chapters for user ${userId}:`, error);
    return null;
  }
});

/**
 * Firebase Cloud Function: getRecipeById
 */
exports.getRecipeById = onRequest(async (req, res) => { // New v2 syntax using imported onRequest
  // Enable CORS for requests from your app's domain
  cors(req, res, async () => {
    // --- 1. Check Request Method ---
    if (req.method !== "GET") {
      return res.status(405).send("Method Not Allowed");
    }

    // --- 2. Get recipeId from Query Parameter ---
    const recipeId = req.query.recipeId;
    if (!recipeId) {
      console.error("getRecipeById: Missing 'recipeId' query parameter.");
      return res.status(400).send("Bad Request: Missing 'recipeId' query parameter.");
    }
    console.log(`getRecipeById: Received request for recipeId: ${recipeId}`);

    try {
      // --- 3. Fetch Recipe Document from Firestore ---
      // ASSUMPTION: Recipes are stored in a top-level 'recipes' collection
      // *** ADJUST 'recipes' IF YOUR COLLECTION NAME IS DIFFERENT ***
      const recipeRef = db.collection("recipes").doc(recipeId);
      const docSnap = await recipeRef.get();

      // --- 4. Handle Document Not Found ---
      if (!docSnap.exists) {
        console.warn(`getRecipeById: Recipe document with ID ${recipeId} not found.`);
        return res.status(404).send(`Not Found: Recipe with ID ${recipeId} not found.`);
      }

      // --- 5. Extract and Format Data ---
      const recipeData = docSnap.data();

      // Construct the response object matching Swift's Recipe struct expectation
      // Adjust field names here if they differ in Firestore vs Swift
      const responseData = {
        recipeId: docSnap.id, // Use the document ID as recipeId
        title: recipeData.title || "No Title", // Provide defaults if fields might be missing
        total_time: recipeData.total_time || null,
        servings: recipeData.servings || null,
        // Ensure ingredients and instructions are arrays
        ingredients: Array.isArray(recipeData.ingredients) ? recipeData.ingredients : [],
        instructions: Array.isArray(recipeData.instructions) ? recipeData.instructions : [],
        // Add any other fields your Swift app expects for a Recipe
      };

      // --- 6. Send Success Response ---
      console.log(`getRecipeById: Successfully fetched recipe ${recipeId}.`);
      return res.status(200).json(responseData);
    } catch (error) {
      // --- 7. Handle Server Errors ---
      console.error(`getRecipeById: Error fetching recipe ${recipeId}:`, error);
      return res.status(500).send("Internal Server Error");
    }
    // Ensured no extra padding blank line before this closing brace for padded-blocks error
  }); // End CORS wrapper
}); // <-- End of getRecipeById function



exports.updatePublicRecipeRating = onDocumentWritten( // Renamed for clarity
  "public_recipes/{recipeId}/reviews/{userId}", // *** CHANGED PATH ***
  async (event) => {
    const recipeId = event.params.recipeId;
    console.log(`updatePublicRecipeRating: Triggered for public_recipeId: ${recipeId}`);

    // *** References point to public_recipes ***
    const recipeRef = db.collection("public_recipes").doc(recipeId);
    const reviewsRef = recipeRef.collection("reviews"); // Get subcollection reference

    try {
      const reviewsSnapshot = await reviewsRef.get();

      let totalRating = 0;
      let reviewCount = 0;

      if (reviewsSnapshot.empty) {
        // If no reviews exist (e.g., the last one was deleted)
        console.log(`updatePublicRecipeRating: No reviews found  ${recipeId}.`);
        await recipeRef.update({
          // Reset or delete fields
          averageRating: admin.firestore.FieldValue.delete(), // Option 1: Remove the field
          // averageRating: 0, // Option 2: Set to 0
          reviewCount: 0,
        });
        console.log(`updatePublicRecipeRating: Reset stats for public recipe ${recipeId}.`);
        return null;
      }

      // Calculate stats from existing reviews
      reviewsSnapshot.forEach((doc) => {
        const data = doc.data();
        // Ensure rating exists and is a valid number
        if (typeof data.rating === "number" && !isNaN(data.rating)) {
          totalRating += data.rating;
          reviewCount++;
        } else {
          console.warn(`updatePublicRecipeRating: ${doc.id} ${recipeId} 'rating':`, data.rating);
        }
      });

      // Calculate average, handle division by zero
      const averageRating = reviewCount > 0 ? totalRating / reviewCount : 0; // Default to 0 if count is somehow 0 but snapshot not empty

      console.log(`${recipeId}  ${reviewCount} ${averageRating.toFixed(1)}`);

      // Update the parent public_recipe document
      await recipeRef.update({
        averageRating: parseFloat(averageRating.toFixed(1)), // Store as number rounded to 1 decimal
        reviewCount: reviewCount,
      });

      console.log(`updatePublicRecipeRating: Updated public recipe ${recipeId} successfully.`);
      return null;
    } catch (error) {
      console.error(`for public recipe ${recipeId}:`, error);
      return null; // Indicate failure but don't crash everything
    }
  }
);// --- End of updatePublicRecipeRating function ---

exports.incrementSaveCount = onDocumentWritten(
  "users/{userId}/chapters/{chapterId}/recipes/{recipeId}", // Path to trigger on
  async (event) => {
    // We only care about the 'create' event (when a recipe is added)
    // event.data.before does not exist for create events
    // event.data.after exists for create and update events
    if (event.data.before.exists || !event.data.after.exists) {
      console.log(`incrementSaveCount: Not a create event for ${event.resource}`);
      return null; // Exit if it's not a document creation
    }

    // Get the recipeId from the path parameters
    const recipeId = event.params.recipeId;
    // Get the userId who saved the recipe (optional, for logging)
    const savingUserId = event.params.userId;

    console.log(`incrementSaveCount: For recipe ${recipeId} saved by ${savingUserId}`);

    // Reference to the document in the /public_recipes collection
    const publicRecipeRef = db.collection("public_recipes").doc(recipeId);

    try {
      // Check if the public recipe actually exists before trying to increment
      const publicDocSnap = await publicRecipeRef.get();

      if (!publicDocSnap.exists) {
        console.log(`incrementSaveCount: Pub ${recipeId} not found. No count.`);
        return null; // The saved recipe wasn't a public one (or no longer exists)
      }

      // Use FieldValue.increment to atomically update the saveCount
      // Initialize saveCount to 1 if it doesn't exist yet? No, increment assumes it exists.
      // We should ensure publishRecipe sets saveCount to 0 initially.
      await publicRecipeRef.update({
        saveCount: admin.firestore.FieldValue.increment(1),
      });

      console.log(`incrementSaveCount: Success saveCount for pub.  ${recipeId}.`);
      return null;
    } catch (error) {
      console.error(`incrementSaveCount: Error incr. count for  ${recipeId}:`, error);
      return null; // Don't block further function execution on error
    }
  }
);

exports.unpublishPublicRecipe = onCall(async (request) => { // Renamed arg to 'request'
  // 1. Check authentication using request.auth
  if (!request.auth) { // <--- CORRECT v2 AUTH CHECK
    console.error("unpublishPublicRecipe: Authentication required.");
    throw new HttpsError( // Use imported HttpsError
      "unauthenticated",
      "The function must be called while authenticated."
    );
  }

  const userId = request.auth.uid; // Get UID from request.auth.uid
  const recipeId = request.data.recipeId; // Get data from request.data

  // 2. Validate input
  if (!recipeId || typeof recipeId !== "string" || recipeId.length === 0) {
    throw new HttpsError( // Use imported HttpsError
      "invalid-argument",
      "The function must be called with a valid 'recipeId' string."
    );
  }

  const publicRecipeRef = db.collection("public_recipes").doc(recipeId);

  try {
    const publicRecipeDoc = await publicRecipeRef.get();

    // 3. Check if the public recipe document exists
    if (!publicRecipeDoc.exists) {
      console.log(
        `Recipe ${recipeId} not found in public_recipes. No action needed.`
      );
      return {
        success: true,
        message: "Recipe not found in public collection.",
      };
    }

    const recipeData = publicRecipeDoc.data();

    // 4. Verify ownership (Security Check)
    if (!recipeData.createdByUserId) {
      console.error(
        `Missing createdByUserId field on public recipe ${recipeId}. ` +
        `Cannot verify owner.`
      );
      throw new HttpsError( // Use imported HttpsError
        "failed-precondition",
        "Recipe is missing creator information."
      );
    }

    if (recipeData.createdByUserId !== userId) {
      console.error(
        `User ${userId} attempted to unpublish recipe ${recipeId} ` +
        `owned by ${recipeData.createdByUserId}`
      );
      throw new HttpsError( // Use imported HttpsError
        "permission-denied",
        "You do not have permission to unpublish this recipe."
      );
    }

    // 5. Perform the unpublish action (Set isPublic to false)
    await publicRecipeRef.update({ isPublic: false });
    console.log(
      `Successfully set isPublic=false for recipe ${recipeId} ` +
      `in public_recipes by owner ${userId}.`
    );
    return { success: true, message: "Recipe marked as not public." };
  } catch (error) {
    console.error(
      `Error unpublishing recipe ${recipeId} from public_recipes:`,
      error
    );
    if (error instanceof HttpsError) { // Check if it's already an HttpsError
      throw error;
    }
    throw new HttpsError( // Use imported HttpsError
      "internal",
      "An error occurred while unpublishing the recipe."
    );
  }
});// --- End of unpublishPublicRecipe function ---

exports.handleRecipeSave = onDocumentWritten(
  "users/{userId}/chapters/{chapterId}/recipes/{recipeId}", // Path to trigger on
  async (event) => {
    const recipeId = event.params.recipeId;
    const savingUserId = event.params.userId;

    // Determine if it's a save (create) or unsave (delete)
    const isSave = event.data.after.exists && !event.data.before.exists;
    const isUnsave = !event.data.after.exists && event.data.before.exists;

    if (!isSave && !isUnsave) {
      console.log(`handleRecipeSave: event for ${event.params.recipeId}. Ignoring.`);
      return null; // Ignore updates to the chapter recipe doc itself
    }

    console.log(`handleRecipeSave: ${recipeId} by ${savingUserId}.${isSave ? 'SAVE' : 'UNSAVE'}`);

    // Reference to the document in the /public_recipes collection
    const publicRecipeRef = db.collection("public_recipes").doc(recipeId);
    const recipeSavesCollection = db.collection("recipeSaves");

    try {
      // --- Check if the recipe being saved/unsaved is actually public ---
      const publicDocSnap = await publicRecipeRef.get();
      if (!publicDocSnap.exists) {
        console.log(`handleRecipeSave: Recipe ${recipeId} not found. No counts updated.`);
        return null;
      }

      // --- Update Total Save Count (increment/decrement) ---
      let incrementValue = 0;
      if (isSave) {
         incrementValue = 1;
      } else if (isUnsave) {
         incrementValue = -1;
      }

      if (incrementValue !== 0) {
          await publicRecipeRef.update({
              saveCount: admin.firestore.FieldValue.increment(incrementValue),
          });
          console.log(`handleRecipeSave: Updated total saveCount 
            for public recipe ${recipeId} by ${incrementValue}.`);
      }

      // --- Add/Remove entry in recipeSaves collection ---
      if (isSave) {
        // Add a document to recipeSaves to log this specific save event
        await recipeSavesCollection.add({
          recipeId: recipeId,
          userId: savingUserId,
          savedAt: admin.firestore.FieldValue.serverTimestamp(), // Use server time
        });
        console.log(`handleRecipeSave: Added save log entry 
          for recipe ${recipeId} by user ${savingUserId}.`);
      } else if (isUnsave) {
        // If unsaving, we need to find and delete the corresponding save entry.
        // Query for the specific save event by this user for this recipe.
        // NOTE: This assumes a user can only save a specific recipe *once*
        // in a way that triggers this function. If multiple saves are logged per user,
        // this delete logic needs refinement (e.g., find the latest one).
        const saveQuery = recipeSavesCollection
                            .where("recipeId", "==", recipeId)
                            .where("userId", "==", savingUserId)
                            .limit(1); // Find one entry to delete

        const saveSnapshot = await saveQuery.get();
        if (!saveSnapshot.empty) {
          const docToDelete = saveSnapshot.docs[0];
          await docToDelete.ref.delete();
          console.log(`handleRecipeSave:  ${docToDelete.id} for ${recipeId} by  ${savingUserId}.`);
        } else {
           console.log(`handleRecipeSave:${recipeId} by ${savingUserId}. Save count bad.`);
        }
      }

      return null;
    } catch (error) {
      console.error(`handleRecipeSave: Error for recipe ${recipeId}:`, error);
      return null; // Don't block further function execution on error
    }
  }
);

exports.updateAllRecentSaveCounts = onSchedule("every 6 hours", async () => { // Remove _event
  console.log("Scheduled function 'updateAllRecentSaveCounts' started.");

  const publicRecipesRef = db.collection("public_recipes");
  const recipeSavesRef = db.collection("recipeSaves");
  const batchSize = 200; // Process recipes in batches
  let lastDoc = null;
  let recipesProcessed = 0;

  // Calculate the timestamp for 7 days ago
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // Milliseconds
  const sevenDaysAgoTimestamp = admin.firestore.Timestamp.fromDate(sevenDaysAgo);
  console.log(`Calculating recent saves since: ${sevenDaysAgo.toISOString()}`);

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Query for a batch of public recipes
      let query = publicRecipesRef
          .orderBy(admin.firestore.FieldPath.documentId())
          .limit(batchSize);
      if (lastDoc) {
        query = query.startAfter(lastDoc);
      }

      const publicRecipesSnapshot = await query.get();
      if (publicRecipesSnapshot.empty) {
        break; // No more recipes to process
      }

      console.log(`Processing batch of ${publicRecipesSnapshot.size} public recipes...`);
      const batchCommits = []; // Store promises for batch commits

      // Use a Firestore WriteBatch for updates within this recipe batch
      let writeBatch = db.batch();
      let writeCount = 0;

      for (const recipeDoc of publicRecipesSnapshot.docs) {
        const recipeId = recipeDoc.id;

        // Query recipeSaves for recent saves of this recipe
        const recentSavesQuery = recipeSavesRef
          .where("recipeId", "==", recipeId)
          .where("savedAt", ">=", sevenDaysAgoTimestamp);

        // OPTION 1: Count total recent saves
        const recentSavesSnapshot = await recentSavesQuery.count().get();
        const recentCount = recentSavesSnapshot.data().count;

        /* // OPTION 2: Count unique users saving recently (more reads, potentially slower)
           const recentSavesSnapshot = await recentSavesQuery.get();
           const uniqueUserIds = new Set();
           recentSavesSnapshot.forEach(doc => uniqueUserIds.add(doc.data().userId));
           const recentCount = uniqueUserIds.size;
        */

        // Update the recentSaveCount on the public recipe doc in the batch
        // Only update if the count has actually changed to minimize writes
        const currentData = recipeDoc.data();
        if (currentData.recentSaveCount !== recentCount) {
            console.log(` ${recipeId} from ${currentData.recentSaveCount || 0} to ${recentCount}`);
            writeBatch.update(recipeDoc.ref, { recentSaveCount: recentCount });
            writeCount++;
        }


        // Commit batch periodically to avoid exceeding limits
        if (writeCount >= 490) { // Firestore batch limit is 500 writes
           console.log(`Committing batch of ${writeCount} updates...`);
           batchCommits.push(writeBatch.commit());
           writeBatch = db.batch(); // Start a new batch
           writeCount = 0;
        }
      } // End loop through recipe batch

      // Commit any remaining writes in the last batch
      if (writeCount > 0) {
         console.log(`Committing final batch of ${writeCount} updates...`);
         batchCommits.push(writeBatch.commit());
      }

      // Wait for all batch commits in this iteration to finish
      await Promise.all(batchCommits);

      recipesProcessed += publicRecipesSnapshot.size;
      lastDoc = publicRecipesSnapshot.docs[publicRecipesSnapshot.docs.length - 1]; // For pagination

      // Check if we processed fewer docs than the batch size, indicating the end
      if (publicRecipesSnapshot.size < batchSize) {
        break;
      }
    } // End while loop

    console.log(`'updateAllRecentSaveCounts' finished. ${recipesProcessed}`);
    return null;
  } catch (error) {
    console.error("Error in scheduled function 'updateAllRecentSaveCounts':", error);
    // Consider adding monitoring/alerting here
    return null;
  }
});

exports.getUserAveragePublicRating = onCall(async (request) => {
  if (!request.auth) {
    console.error("getUserAveragePublicRating: Authentication required.");
    throw new HttpsError("unauthenticated", "The function must be called while authenticated.");
  }
  const userId = request.auth.uid; // Recipes CREATED BY this user
  const logPrefix = `getUserAveragePublicRating[User:${userId}]:`;
  console.log(`${logPrefix} Function started.`);

  let totalAverageRatingSum = 0;
  let publicRecipeCountWithRating = 0;

  try {
    const publicRecipesRef = db.collection("public_recipes");
    const userPublicRecipesQuery = publicRecipesRef
        .where("createdByUserId", "==", userId)
        .where("isPublic", "==", true);

    const publicRecipesSnapshot = await userPublicRecipesQuery.get();

    if (publicRecipesSnapshot.empty) {
      console.log(`${logPrefix} User has no public recipes.`);
      return { averageRating: null, ratedRecipeCount: 0 }; // Use a distinct key for clarity
    }

    publicRecipesSnapshot.forEach((recipeDoc) => {
      const recipeData = recipeDoc.data();
      // Use the recipe's own averageRating and reviewCount
      if (typeof recipeData.averageRating === "number" && (recipeData.reviewCount || 0) > 0) {
        totalAverageRatingSum += recipeData.averageRating;
        publicRecipeCountWithRating++;
      }
    });

    const finalAverageRating = publicRecipeCountWithRating > 0 ?
      totalAverageRatingSum / publicRecipeCountWithRating :
      null;

    const result = {
      averageRating: finalAverageRating !== null ? parseFloat(finalAverageRating.toFixed(1)) : null,
      ratedRecipeCount: publicRecipeCountWithRating, // Number of user's recipes that HAVE ratings
    };

    console.log(`${logPrefix} Calculation complete. Result:`, result);
    return result;
  } catch (error) {
    console.error(`${logPrefix} Error during calculation:`, error);
    throw new HttpsError("internal", "Failed to calc user's avg rating.", error.message);
  }
});

exports.syncRecipeToTypesense = onDocumentWritten(
  "public_recipes/{recipeId}",
  async (event) => {
    let localAdminClient; // Local client for this execution
    try {
      // --- Initialize ADMIN Client INSIDE the function ---
      console.log("syncRecipeToTypesense: Initializing ADMIN client...");
      const host = await getSecretValue("TYPESENSE_HOST");
      const port = await getSecretValue("TYPESENSE_PORT");
      const protocol = await getSecretValue("TYPESENSE_PROTOCOL");
      const adminApiKey = await getSecretValue("TYPESENSE_ADMIN_API_KEY"); // <-- ADMIN KEY

      localAdminClient = new Typesense.Client({
        nodes: [{ host, port: parseInt(port, 10), protocol }],
        apiKey: adminApiKey, // <-- Use Admin Key
        connectionTimeoutSeconds: 10,
      });
      console.log("syncRecipeToTypesense: ADMIN Client initialized.");
      // --- End Initialization ---

      // Pass the initialized admin client to the helper
      await ensureTypesenseCollectionExists(localAdminClient); 

      const recipeId = event.params.recipeId;
      // Use the localAdminClient for all operations below
      const docRef = localAdminClient.collections(RECIPES_COLLECTION).documents(recipeId); 

      // Deletion
      if (!event.data.after.exists) {
        console.log(`Deleting recipe ${recipeId} from Typesense.`);
        try {
          await docRef.delete(); // Use localAdminClient
          console.log(`Deleted ${recipeId} from Typesense.`);
        } catch (error) {
          console.warn(`Warn deleting ${recipeId}:`, error.message);
        }
        return null;
      }

      // Create or Update
      console.log(`Upserting recipe ${recipeId} to Typesense.`);
      const recipeData = event.data.after.data();
      // Format data carefully for Typesense schema
      const typesenseDoc = { 
          id: recipeId, // Ensure ID is set for upsert
          title: recipeData.title || "",
          recipeId: recipeId,
          // ... copy ALL other fields from your previous formatting logic ...
          createdByUsername: recipeData.createdByUsername,
          imageURL: recipeData.imageURL,
          cuisine: recipeData.cuisine,
          tags: Array.isArray(recipeData.tags) ? recipeData.tags : [],
          saveCount: recipeData.saveCount || 0,
          averageRating: recipeData.averageRating,
          reviewCount: recipeData.reviewCount || 0,
          createdAt: recipeData.createdAt ? recipeData.createdAt._seconds : undefined,
          isPublic: typeof recipeData.isPublic === 'boolean' ? recipeData.isPublic : false, 
          difficulty: recipeData.difficulty,
          category: recipeData.category,
          total_time: recipeData.total_time,
      };

      // Remove undefined fields
      Object.keys(typesenseDoc).forEach((key) => {
        if (typesenseDoc[key] === undefined) {
          delete typesenseDoc[key];
        }
      });

      await localAdminClient // Use localAdminClient
        .collections(RECIPES_COLLECTION)
        .documents()
        .upsert(typesenseDoc); 
      console.log(`Upserted ${recipeId} to Typesense.`);
    } catch (error) {
      console.error("syncRecipeToTypesense: Error during execution:", error);
      return null; 
    }
    return null;
  }
);

// --- ADD: Typesense Search Function ---
exports.searchPublicRecipesWithTypesense = onCall(async (request) => {
  // Check if the global search client is ready
  if (!typesenseSearchClient) { // <-- Use the search client variable
      console.error("searchPublicRecipesWithTypesense: Search client not ready.");
      throw new HttpsError("internal", "Search service is temporarily unavailable.");
  }

  // Explicit Auth Check
  if (!request.auth) {
    console.error("!!! searchPublicRecipesWithTypesense: Auth check failed INSIDE function.");
    throw new HttpsError(
      "unauthenticated",
      "The function must be called while authenticated " + 
      "(explicit check)." 
    );
  }
  console.log(`searchPublicRecipesWithTypesense: User auth with UID: ${request.auth.uid}`); 

  // Input validation
  const query = request.data.query;
  if (!query || typeof query !== "string" || query.trim().length === 0) {
      console.error("Search query is missing or invalid.");
      throw new HttpsError("invalid-argument", "A non-empty 'query' string must be provided.");
  }
  const logPrefix = `searchPublicRecipes[Query:"${query}"]:`;
  console.log(`${logPrefix} Processing search.`);

  // Define search parameters
  const searchParameters = {
    "q": query,
    "query_by": "title,tags,cuisine,createdByUsername", // Adjust searchable fields
    "sort_by": "_text_match:desc,saveCount:desc", // Rank by relevance, then saves
    "per_page": 30, // Max results to return
    "filter_by": "isPublic:true", // Ensure only public are returned
    // Add more params like 'facet_by', 'page' as needed
  };

  try {
    // Use the globally initialized search client
    const searchResults = await typesenseSearchClient 
      .collections(RECIPES_COLLECTION)
      .documents()
      .search(searchParameters);

    console.log(`${logPrefix} Found ${searchResults.found} hits.`);

    // Format results (logic remains the same)
    const formattedHits = searchResults.hits.map((hit) => {
      const doc = hit.document;
      return {
        recipe: {
          recipeId: doc.id,
          title: doc.title,
          createdAt: (
            doc.createdAt !== undefined &&
            doc.createdAt !== null
          ) ? doc.createdAt : null,
          createdByUsername: (
            doc.createdByUsername !== undefined &&
            doc.createdByUsername !== null
          ) ? doc.createdByUsername : null,
          imageURL: (
            doc.imageURL !== undefined &&
            doc.imageURL !== null
          ) ? doc.imageURL : null,
          cuisine: (
            doc.cuisine !== undefined &&
            doc.cuisine !== null
          ) ? doc.cuisine : null,
          tags: doc.tags || [], // || okay here
          saveCount: (
            doc.saveCount !== undefined &&
            doc.saveCount !== null
          ) ? doc.saveCount : 0,
          averageRating: (
            doc.averageRating !== undefined &&
            doc.averageRating !== null
          ) ? doc.averageRating : null,
          reviewCount: (
            doc.reviewCount !== undefined &&
            doc.reviewCount !== null
          ) ? doc.reviewCount : 0,
          isPublic: (typeof doc.isPublic === "boolean") ?
            doc.isPublic :
            false,
          difficulty: (
            doc.difficulty !== undefined &&
            doc.difficulty !== null
          ) ? doc.difficulty : null,
          category: (
            doc.category !== undefined &&
            doc.category !== null
          ) ? doc.category : null,
          total_time: (
            doc.total_time !== undefined &&
            doc.total_time !== null
          ) ? doc.total_time : null,

          // **Critical**: Include ALL fields expected by Swift Recipe Decoder
          // Send empty arrays or nulls for fields not indexed/present
          ingredients: [], // Example: send empty if not indexed
          instructions: [], // Example: send empty if not indexed
          servings: null, // Example default
          source: null, // Example default
          cookedCount: null, // Example default
          privateNoteEntries: null, // Example default
        },
        // Also format the separate creatorUsername field
        creatorUsername: (
          doc.createdByUsername !== undefined &&
          doc.createdByUsername !== null
        ) ? doc.createdByUsername : null,
      };
      // --- End formatting ---
    }); // End map function

    return { results: formattedHits }; // Return structured results
  } catch (error) {
    console.error(`${logPrefix} Error during Typesense search:`, error);
    // Provide a generic error message back to the client
    throw new HttpsError("internal", "Failed to perform search.");
  }
});

exports.getCreatorProfileData = onCall(async (request) => {
  const profileOwnerId = request.data.profileOwnerId;
  const callerUid = request.auth ? request.auth.uid : null;

  if (!profileOwnerId) {
    console.error("getCreatorProfileData: Missing 'profileOwnerId'.");
    throw new HttpsError("invalid-argument", "profileOwnerId is required.");
  }

  const logPrefix = `getCreatorProfileData[${profileOwnerId}]`;
  console.log(`${logPrefix}: Called by ${callerUid || "guest"}.`);

  try {
    const userDocRef = db.collection("users").doc(profileOwnerId);
    const userDocSnap = await userDocRef.get();

    if (!userDocSnap.exists) {
      console.log(`${logPrefix}: User profile not found.`);
      throw new HttpsError("not-found", "User profile not found.");
    }
    
    const profileInfo = userDocSnap.data();
    const recipeCategories = []; // Initialize

    // 1. Fetch "Featured Recipes" (if any)
    const featuredRecipeIds = profileInfo.featuredRecipeIds || [];
    if (featuredRecipeIds.length > 0) {
      const featuredRecipesSummaries = [];
      const BATCH_SIZE = 30; // Firestore 'in' query limit
      for (let i = 0; i < featuredRecipeIds.length; i += BATCH_SIZE) {
          const batchIds = featuredRecipeIds.slice(i, i + BATCH_SIZE);
          if (batchIds.length > 0) {
              const featuredQuerySnap = await db.collection("public_recipes")
                  .where(admin.firestore.FieldPath.documentId(), "in", batchIds)
                  .get();
              featuredQuerySnap.forEach(doc => {
                  // Ensure the recipe is still public and exists
                  if (doc.exists && doc.data().isPublic === true) { 
                      const summary = formatRecipeSummary(doc.data(), doc.id);
                      if (summary) featuredRecipesSummaries.push(summary);
                  }
              });
          }
      }
      // Sort them according to the user's specified order in featuredRecipeIds
      const sortedFeatured = featuredRecipeIds
        .map(id => featuredRecipesSummaries.find(recipe => recipe.recipeId === id))
        .filter(r => r != null); // Remove any not found (e.g., if a featured recipe was unpublished)

      if (sortedFeatured.length > 0) {
        recipeCategories.push({
          id: `creator_featured_${profileOwnerId}`,
          title: "Featured Recipes",
          recipes: sortedFeatured.slice(0, CREATOR_PROFILE_FEATURED_LIMIT), // Apply limit
          canLoadMore: sortedFeatured.length > CREATOR_PROFILE_FEATURED_LIMIT,
        });
      }
    }

    // --- NEW: Add other dynamic carousels ---

    // 2. "Recently Added by [Username]" Carousel
    const recentRecipes = [];
    const recentQuerySnap = await db.collection("public_recipes")
      .where("isPublic", "==", true)
      .where("createdByUserId", "==", profileOwnerId)
      .orderBy("createdAt", "desc")
      .limit(DEFAULT_ITEMS_PER_CATEGORY) // Define this constant (e.g., 7-10)
      .get();
    recentQuerySnap.forEach(doc => {
      if (doc.exists) {
        const summary = formatRecipeSummary(doc.data(), doc.id);
        if (summary) recentRecipes.push(summary);
      }
    });
    if (recentRecipes.length > 0) {
      recipeCategories.push({
        id: `creator_recent_${profileOwnerId}`,
        title: `Recently Added`, // Frontend can add "by Username" if needed, or do it here
        recipes: recentRecipes,
        canLoadMore: recentRecipes.length === DEFAULT_ITEMS_PER_CATEGORY,
      });
    }

    // 3. "Most Popular by [Username]" (based on saveCount) Carousel
    const popularRecipes = [];
    const popularQuerySnap = await db.collection("public_recipes")
      .where("isPublic", "==", true)
      .where("createdByUserId", "==", profileOwnerId)
      .orderBy("saveCount", "desc")
      .orderBy("createdAt", "desc") // Secondary sort for tie-breaking
      .limit(DEFAULT_ITEMS_PER_CATEGORY)
      .get();
    popularQuerySnap.forEach(doc => {
      if (doc.exists) {
        const summary = formatRecipeSummary(doc.data(), doc.id);
        if (summary) popularRecipes.push(summary);
      }
    });
    if (popularRecipes.length > 0) {
      recipeCategories.push({
        id: `creator_popular_${profileOwnerId}`,
        title: `Most Popular`, // Frontend can add "by Username"
        recipes: popularRecipes,
        canLoadMore: popularRecipes.length === DEFAULT_ITEMS_PER_CATEGORY,
      });
    }

    // --- END NEW CAROUSELS ---

    // 4. Fetch "All Public Recipes" (This will now be added after the dynamic ones)
    const allPublicRecipes = [];
    const allPublicQuerySnap = await db.collection("public_recipes")
      .where("isPublic", "==", true)
      .where("createdByUserId", "==", profileOwnerId)
      .orderBy("title", "asc") // Example: sort alphabetically for the "All" list
      .limit(CREATOR_PROFILE_ALL_PUBLIC_LIMIT) // Define this constant
      .get();

    allPublicQuerySnap.forEach(doc => {
      if (doc.exists) {
        const summary = formatRecipeSummary(doc.data(), doc.id);
        if (summary) allPublicRecipes.push(summary);
      }
    });

    // Add "All Public Recipes" category even if it's empty,
    // so the "Edit List" button can appear on the user's own profile.
    // The frontend will handle the "no recipes yet" message if recipes array is empty.
    recipeCategories.push({
      id: `creator_all_public_${profileOwnerId}`,
      title: "All Public Recipes", // This title is now primarily for identification
      recipes: allPublicRecipes,
      canLoadMore: allPublicRecipes.length === CREATOR_PROFILE_ALL_PUBLIC_LIMIT,
    });
    
    console.log(`${logPrefix}: Returning ${recipeCategories.length} categories.`);
    return {
      profileInfo: profileInfo,
      recipeCategories: recipeCategories,
    };
  } catch (error) {
    console.error(`${logPrefix}: Error:`, error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", "Failed to get creator profile data.", error.message);
  }
});


exports.getDiscoveryFeed = onCall(async (request) => {
  const callerUid = request.auth ? request.auth.uid : null;
  const pageContext = request.data.pageContext || "mainLeaderboard";

  if (pageContext === "creatorProfileView") {
    console.warn(
      "getDiscoveryFeed: Received 'creatorProfileView' context. " +
      "This should be handled by 'getCreatorProfileData'. Returning empty."
    );
    return { feedTitle: "Discovery", categories: [] };
  }

  const logPrefix = `getDiscoveryFeed[${pageContext}]`;
  console.log(`${logPrefix}: Called by ${callerUid || "guest"}.`);

  const feedResponse = {
    feedTitle: "Saucey Discovery",
    categories: [],
  };
  let categoryDefinitionSource = [];

  try {
    const definitionsSnapshot = await db
      .collection("leaderboard_definitions")
      .orderBy("displayOrder")
      .get();

    definitionsSnapshot.forEach((doc) => {
      categoryDefinitionSource.push({
        id: doc.id,
        ...doc.data(),
        limit: doc.data().itemCount || DEFAULT_ITEMS_PER_CATEGORY,
      });
    });

    if (categoryDefinitionSource.length === 0) {
      console.log(`${logPrefix}: No category definitions found.`);
      return feedResponse;
    }

    for (const def of categoryDefinitionSource) {
      let recipes = [];
      let query;
      const fetchLimit = def.limit || DEFAULT_ITEMS_PER_CATEGORY;
      const defTypeLog = `Def: "${def.title}" (type: ${def.type}, lim: ${fetchLimit})`;
      console.log(`${logPrefix}: Processing ${defTypeLog}`);

      switch (def.type) {
        case "overall":
        case "trending":
          query = db.collection("public_recipes")
            .where("isPublic", "==", true)
            .orderBy(def.sortField || "saveCount", "desc")
            .orderBy("createdAt", "desc")
            .limit(fetchLimit);
          break;
        case "tagBased":
          if (def.filterTags && def.filterTags.length > 0) {
            const tagsToQuery = def.filterTags.slice(0, 10);
            query = db.collection("public_recipes")
              .where("isPublic", "==", true)
              .where("tags", "array-contains-any", tagsToQuery)
              .orderBy(def.sortField || "saveCount", "desc")
              .orderBy("createdAt", "desc")
              .limit(fetchLimit);
          } else {
            console.warn(`${logPrefix}: tagBased category "${def.title}" no filterTags.`);
          }
          break;
        case "timeBased": {
          const now = admin.firestore.Timestamp.now();
          const days = def.daysAgo || 7;
          const XDaysAgo = admin.firestore.Timestamp.fromMillis(
            now.toMillis() - days * 24 * 60 * 60 * 1000
          );
          query = db.collection("public_recipes")
            .where("isPublic", "==", true)
            .where("createdAt", ">=", XDaysAgo)
            .orderBy("createdAt", "desc")
            .orderBy(def.sortField || "saveCount", "desc")
            .limit(fetchLimit);
          break;
        }
        default:
          console.warn(`${logPrefix}: Unknown type: "${def.type}" for "${def.title}"`);
          break;
      }

      if (query) {
        const snapshot = await query.get();
        snapshot.forEach((doc) => {
          const summary = formatRecipeSummary(doc.data(), doc.id);
          if (summary) recipes.push(summary);
        });
      }

      if (recipes.length > 0) {
        feedResponse.categories.push({
          id: def.id,
          title: def.title,
          recipes: recipes,
          canLoadMore: recipes.length === fetchLimit,
        });
      } else {
        console.log(`${logPrefix}: No recipes for category "${def.title}".`);
      }
    }
    const catCount = feedResponse.categories.length;
    console.log(`${logPrefix}: Prepared feed with ${catCount} categories.`);
    return feedResponse;
  } catch (error) {
    console.error(`${logPrefix}: Error processing feed:`, error);
    throw new HttpsError("internal", "Failed to get discovery feed.", error.message);
  }
});


exports.getUserTotalSaves = onCall(async (request) => {
  // if (!request.auth) {
  //   console.error("getUserTotalSaves: Authentication required by caller (optional check).");
  //   throw new HttpsError("unauthenticated", "The function must be called while authenticated.");
  // }

  const profileOwnerId = request.data.userId; // Expecting 'userId' from the client

  if (!profileOwnerId || typeof profileOwnerId !== "string" || profileOwnerId.length === 0) {
    console.error("getUserTotalSaves: Missing or invalid 'userId' in request data.");
    throw new HttpsError(
      "invalid-argument",
      "The function must be called with a valid 'userId' string in the data payload."
    );
  }

  const logPrefix = `getUserTotalSaves[ProfileOwner:${profileOwnerId}]:`;
  console.log(`${logPrefix} Function started.`);

  let totalSaves = 0;

  try {
    const publicRecipesRef = db.collection("public_recipes");
    const userPublicRecipesQuery = publicRecipesRef
      .where("createdByUserId", "==", profileOwnerId)
      .where("isPublic", "==", true); // Ensure we only count public recipes

    const publicRecipesSnapshot = await userPublicRecipesQuery.get();

    if (publicRecipesSnapshot.empty) {
      console.log(`${logPrefix} User has no public recipes. Total saves is 0.`);
      return { totalSaves: 0 };
    }

    publicRecipesSnapshot.forEach((recipeDoc) => {
      const recipeData = recipeDoc.data();
      if (typeof recipeData.saveCount === "number" && recipeData.saveCount > 0) {
        totalSaves += recipeData.saveCount;
      }
    });

    console.log(`${logPrefix} Calculation complete. Total saves: ${totalSaves}`);
    return { totalSaves: totalSaves };
  } catch (error) {
    console.error(`${logPrefix} Error during calculation:`, error);
    throw new HttpsError(
      "internal",
      "Failed to calculate user's total recipe saves.",
      error.message // Include original error message for server logs
    );
  }
});

function formatRecipeSummary(recipeData, recipeId) {
  if (!recipeData) return null;
  return {
    recipeId: recipeId || recipeData.recipeId, // Ensure recipeId is present
    title: recipeData.title || null,
    imageURL: recipeData.imageURL || null,
    createdByUsername: recipeData.createdByUsername || null,
    createdByUserId: recipeData.createdByUserId || null,
    saveCount: recipeData.saveCount || 0,
    total_time: recipeData.total_time || null,
    calories: recipeData.calories || null,
    averageRating: recipeData.averageRating || null,
    reviewCount: recipeData.reviewCount || 0,
  };
}