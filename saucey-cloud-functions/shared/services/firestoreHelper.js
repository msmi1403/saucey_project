// saucey-cloud-functions/shared/services/firestoreHelper.js
const { Firestore, FieldValue, Timestamp } = require('@google-cloud/firestore');

let db;

/**
 * Ensures Firestore client is initialized.
 */
function ensureFirestoreInitialized() {
    if (!db) {
        try {
            db = new Firestore();
            console.log('Firestore client initialized in firestoreHelper.');
        } catch (e) {
            console.error('CRITICAL: Firestore client (firestoreHelper) initialization error:', e);
            throw new Error('Firestore client (firestoreHelper) could not be initialized.');
        }
    }
}

/**
 * Saves a document to Firestore. Can create or update (merge).
 * @param {string} collectionPath - The path to the collection.
 * @param {string} docId - The ID of the document.
 * @param {object} data - The data to save.
 * @param {object} [options={}] - Options object.
 * @param {boolean} [options.merge=true] - Whether to merge data or overwrite.
 * @param {boolean} [options.addTimestamps=true] - Whether to add/update createdAt and updatedAt timestamps.
 * @returns {Promise<string>} The document ID.
 */
async function saveDocument(collectionPath, docId, data, { merge = true, addTimestamps = true } = {}) {
    ensureFirestoreInitialized();
    if (!collectionPath || !docId || !data) {
        throw new Error('Collection path, document ID, and data are required for saveDocument.');
    }
    const docRef = db.collection(collectionPath).doc(docId);
    let dataToSave = { ...data };

    if (addTimestamps) {
        dataToSave.updatedAt = FieldValue.serverTimestamp();
        // Check if document exists to set createdAt only for new documents when not merging everything
        // Or if merge is false (meaning it's a set that could be an overwrite)
        if (!merge) { // If it's a full overwrite, always set createdAt if it's truly new
             const docSnapshotForCreate = await docRef.get();
             if (!docSnapshotForCreate.exists) {
                dataToSave.createdAt = FieldValue.serverTimestamp();
             }
        } else { // For merge, only add createdAt if it doesn't exist
            const docSnapshot = await docRef.get();
            if (!docSnapshot.exists) {
                 dataToSave.createdAt = FieldValue.serverTimestamp();
            }
        }
    }

    try {
        await docRef.set(dataToSave, { merge });
        console.log(`Document ${docId} saved in ${collectionPath}. Merge: ${merge}`);
        return docId;
    } catch (error) {
        console.error(`Error saving document ${docId} in ${collectionPath}:`, error);
        throw new Error(`Firestore saveDocument failed: ${error.message}`);
    }
}

/**
 * Adds a new document to a Firestore collection with an auto-generated ID.
 * @param {string} collectionPath - The path to the collection.
 * @param {object} data - The data to add.
 * @param {object} [options={}] - Options object.
 * @param {boolean} [options.addTimestamps=true] - Whether to add createdAt and updatedAt timestamps.
 * @returns {Promise<string>} The new document ID.
 */
async function addDocument(collectionPath, data, { addTimestamps = true } = {}) {
    ensureFirestoreInitialized();
    if (!collectionPath || !data) {
        throw new Error('Collection path and data are required for addDocument.');
    }
    let dataToSave = { ...data };

    if (addTimestamps) {
        const now = FieldValue.serverTimestamp();
        dataToSave.createdAt = now;
        dataToSave.updatedAt = now;
    }

    try {
        const docRef = await db.collection(collectionPath).add(dataToSave);
        console.log(`Document added with ID ${docRef.id} in ${collectionPath}.`);
        return docRef.id;
    } catch (error) {
        console.error(`Error adding document to ${collectionPath}:`, error);
        throw new Error(`Firestore addDocument failed: ${error.message}`);
    }
}

/**
 * Fetches a document from Firestore.
 * @param {string} collectionPath - The path to the collection.
 * @param {string} docId - The ID of the document.
 * @returns {Promise<object|null>} The document data (including its id) if found, otherwise null.
 */
async function getDocument(collectionPath, docId) {
    ensureFirestoreInitialized();
    if (!collectionPath || !docId) {
        throw new Error('Collection path and document ID are required for getDocument.');
    }
    try {
        const docRef = db.collection(collectionPath).doc(docId);
        const doc = await docRef.get();
        if (!doc.exists) {
            console.log(`Document ${docId} not found in ${collectionPath}.`);
            return null;
        }
        console.log(`Document ${docId} fetched from ${collectionPath}.`);
        return { id: doc.id, ...doc.data() };
    } catch (error) {
        console.error(`Error fetching document ${docId} from ${collectionPath}:`, error);
        throw new Error(`Firestore getDocument failed: ${error.message}`);
    }
}

/**
 * Fetches documents from a Firestore collection based on query options.
 * @param {string} collectionPath - The path to the collection.
 * @param {object} [queryOptions={}] - Options for querying.
 * @param {Array<object>} [queryOptions.where] - Array of where clauses, e.g., [{ field, operator, value }].
 * @param {Array<object>} [queryOptions.orderBy] - Array of orderBy clauses, e.g., [{ field, direction ('asc'/'desc') }].
 * @param {number} [queryOptions.limit] - Maximum number of documents to return.
 * @param {*} [queryOptions.startAfter] - Document snapshot or field values to start after for pagination.
 * @param {*} [queryOptions.endBefore] - Document snapshot or field values to end before for pagination.
 * @returns {Promise<Array<object>>} An array of document data (each including its id).
 */
async function getCollection(collectionPath, queryOptions = {}) {
    ensureFirestoreInitialized();
    if (!collectionPath) {
        throw new Error('Collection path is required for getCollection.');
    }
    let query = db.collection(collectionPath);

    if (queryOptions.where && Array.isArray(queryOptions.where)) {
        for (const w of queryOptions.where) {
            if (w && w.field && w.operator && w.value !== undefined) {
                 query = query.where(w.field, w.operator, w.value);
            } else {
                console.warn('Skipping malformed where clause in getCollection:', w);
            }
        }
    }
    if (queryOptions.orderBy && Array.isArray(queryOptions.orderBy)) {
         for (const o of queryOptions.orderBy) {
            if (o && o.field) {
                query = query.orderBy(o.field, o.direction || 'asc');
            } else {
                console.warn('Skipping malformed orderBy clause in getCollection:', o);
            }
        }
    }
    if (typeof queryOptions.limit === 'number' && queryOptions.limit > 0) {
        query = query.limit(queryOptions.limit);
    }
    if (queryOptions.startAfter) {
        query = query.startAfter(queryOptions.startAfter);
    }
    if (queryOptions.endBefore) {
        query = query.endBefore(queryOptions.endBefore);
    }

    try {
        const snapshot = await query.get();
        if (snapshot.empty) {
            console.log(`No documents found in ${collectionPath} with given query.`);
            return [];
        }
        console.log(`Workspaceed ${snapshot.size} documents from ${collectionPath}.`);
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
        console.error(`Error fetching collection ${collectionPath}:`, error);
        throw new Error(`Firestore getCollection failed: ${error.message}`);
    }
}

/**
 * Deletes a document from Firestore.
 * @param {string} collectionPath - The path to the collection.
 * @param {string} docId - The ID of the document to delete.
 * @returns {Promise<boolean>} True if deletion was successful.
 */
async function deleteDocument(collectionPath, docId) {
    ensureFirestoreInitialized();
     if (!collectionPath || !docId) {
        throw new Error('Collection path and document ID are required for deleteDocument.');
     }
    try {
        await db.collection(collectionPath).doc(docId).delete();
        console.log(`Document ${docId} deleted from ${collectionPath}.`);
        return true;
    } catch (error) {
        console.error(`Error deleting document ${docId} from ${collectionPath}:`, error);
        throw new Error(`Firestore deleteDocument failed: ${error.message}`);
    }
}

module.exports = {
    ensureFirestoreInitialized,
    saveDocument,
    addDocument,
    getDocument,
    getCollection,
    deleteDocument,
    FieldValue, // Export FieldValue for server timestamps
    Timestamp   // Export Timestamp for date comparisons and query value
};