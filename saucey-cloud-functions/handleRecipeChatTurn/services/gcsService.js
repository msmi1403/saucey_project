// /handleRecipeChatTurn/services/gcsService.js

const { Storage } = require('@google-cloud/storage');
const path = require('path'); // For getting file extension
const { v4: uuidv4 } = require('uuid');
const config =require('../config');

let storage;

function ensureGcsInitialized() {
    if (!storage) {
        try {
            storage = new Storage();
            console.log('Google Cloud Storage client initialized in gcsService.');
        } catch (e) {
            console.error('CRITICAL: GCS client initialization error:', e);
            throw new Error('GCS client could not be initialized.');
        }
    }
}

/**
 * Generates a v4 signed URL for reading a GCS object.
 * @param {string} bucketName - The name of the GCS bucket.
 * @param {string} filePathInBucket - The path to the file within the bucket.
 * @returns {Promise<string>} The generated signed URL.
 */
async function generateV4ReadSignedUrl(bucketName, filePathInBucket) {
    ensureGcsInitialized();
    const options = {
        version: 'v4',
        action: 'read',
        expires: Date.now() + 15 * 60 * 1000, // URL expires in 15 minutes
    };

    try {
        const [url] = await storage
            .bucket(bucketName)
            .file(filePathInBucket)
            .getSignedUrl(options);
        console.log(`Generated v4 signed URL for gs://${bucketName}/${filePathInBucket}`);
        return url;
    } catch (error) {
        console.error(`Error generating v4 signed URL for gs://${bucketName}/${filePathInBucket}:`, error);
        throw new Error(`Could not generate signed URL: ${error.message}`);
    }
}


/**
 * Uploads image bytes to Google Cloud Storage and returns both GCS URI and a signed URL.
 * @param {Buffer} imageBuffer - The image data as a Buffer.
 * @param {string} userId - The ID of the user uploading the image.
 * @param {string} originalMimeType - The original MIME type of the image (e.g., 'image/jpeg').
 * @returns {Promise<{gcsUri: string, signedUrl: string}>} An object containing the GCS URI and the Signed URL.
 * @throws {Error} If upload or URL generation fails.
 */
async function uploadImageToGCSAndGetSignedUrl(imageBuffer, userId, originalMimeType) {
    ensureGcsInitialized();
    if (!userId) throw new Error('User ID is required for GCS path.');
    if (!imageBuffer || imageBuffer.length === 0) throw new Error('Image buffer is empty.');
    if (imageBuffer.length > config.MAX_IMAGE_UPLOAD_SIZE_BYTES) {
        throw new Error(`Image size ${imageBuffer.length} bytes exceeds limit of ${config.MAX_IMAGE_UPLOAD_SIZE_BYTES} bytes.`);
    }

    let extension = '.jpg'; // Default
    if (originalMimeType === 'image/png') extension = '.png';
    else if (originalMimeType === 'image/webp') extension = '.webp';
    else if (originalMimeType === 'image/heic') extension = '.heic';
    else if (originalMimeType === 'image/heif') extension = '.heif';

    const uniqueFilename = `${uuidv4()}${extension}`;
    const filePathInBucket = `${config.GCS_USER_IMAGE_FOLDER}/${userId}/${uniqueFilename}`;
    const bucketName = config.GCS_BUCKET_NAME;
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(filePathInBucket);

    console.log(`Attempting to upload image to GCS: gs://${bucketName}/${filePathInBucket}`);

    try {
        await file.save(imageBuffer, {
            metadata: {
                contentType: originalMimeType,
            },
            public: false, 
        });

        const gcsUri = `gs://${bucketName}/${filePathInBucket}`;
        console.log(`Image uploaded successfully to ${gcsUri}`);

        const signedUrl = await generateV4ReadSignedUrl(bucketName, filePathInBucket);
        
        return { gcsUri, signedUrl };

    } catch (error) {
        console.error('Error uploading image to GCS or generating signed URL:', error);
        // It's possible the upload succeeded but signed URL failed.
        // For simplicity, we throw a general error. Consider more granular error handling if needed.
        throw new Error(`GCS processing failed: ${error.message}`);
    }
}

/**
 * Deletes an image from GCS given its full gs:// URI.
 * @param {string} gcsUri - The GCS URI of the file to delete.
 * @returns {Promise<boolean>} True if deletion was successful or file didn't exist.
 * @throws {Error} If deletion fails for other reasons.
 */
async function deleteImageFromGCS(gcsUri) {
    ensureGcsInitialized();
    if (!gcsUri || !gcsUri.startsWith('gs://')) {
        console.error(`Invalid GCS URI for deletion: '${gcsUri}'. Must start with 'gs://'.`);
        throw new Error('Invalid GCS URI for deletion.');
    }

    try {
        const pathParts = gcsUri.substring('gs://'.length).split('/');
        if (pathParts.length < 2) {
            throw new Error(`Malformed GCS URI: ${gcsUri}. Could not extract bucket and object path.`);
        }
        const bucketName = pathParts.shift(); 
        const objectPath = pathParts.join('/');   

        if (bucketName !== config.GCS_BUCKET_NAME) {
            console.warn(`Attempting to delete from an unexpected bucket: ${bucketName}. Expected: ${config.GCS_BUCKET_NAME}`);
        }

        const bucket = storage.bucket(bucketName);
        const file = bucket.file(objectPath);

        const [exists] = await file.exists();
        if (exists) {
            await file.delete();
            console.log(`Deleted image from GCS: ${gcsUri}`);
            return true;
        } else {
            console.warn(`Image not found for deletion at GCS URI: ${gcsUri}`);
            return true; 
        }
    } catch (error) {
        console.error(`Error deleting image ${gcsUri} from GCS:`, error);
        throw new Error(`GCS deletion failed: ${error.message}`);
    }
}

module.exports = {
    uploadImageToGCSAndGetSignedUrl,
    deleteImageFromGCS,
};