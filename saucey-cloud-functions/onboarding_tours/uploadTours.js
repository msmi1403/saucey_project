/**
 * uploadTours.js
 *
 * Reads every *_tour.json file in your working directory,
 * and writes it as a document under the collection
 * 'onboarding_tours' using the filename (minus .json) as the doc ID.
 */

const admin = require('firebase-admin');
const fs    = require('fs');
const path  = require('path');

// --- CONFIGURATION ---
const COLLECTION_NAME = 'onboarding_tours';
const JSON_DIR        = './';               // where your .json files live
const SERVICE_KEY     = './serviceAccountKey.json';
// ----------------------

// initialize
admin.initializeApp({
  credential: admin.credential.cert(require(SERVICE_KEY)),
});
const db = admin.firestore();

// only grab files ending in _tour.json
const tourFiles = fs
  .readdirSync(JSON_DIR)
  .filter(f => f.endsWith('_tour.json'));

if (tourFiles.length === 0) {
  console.warn('No *_tour.json files found in', JSON_DIR);
  process.exit(0);
}

tourFiles.forEach(file => {
  const docId = path.basename(file, '.json');
  const data  = JSON.parse(fs.readFileSync(path.join(JSON_DIR, file), 'utf8'));

  db.collection(COLLECTION_NAME).doc(docId).set(data)
    .then(() => console.log(`✅  ${file} → ${COLLECTION_NAME}/${docId}`))
    .catch(err => console.error(`❌  ${file} FAILED:`, err));
});
