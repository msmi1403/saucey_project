# functions/image_processor.py

import uuid
import mimetypes
import logging
from google.cloud import storage
from config import GCS_BUCKET_NAME, MAX_IMAGE_UPLOAD_SIZE_BYTES, PROJECT_ID

logger = logging.getLogger(__name__)

def upload_image_to_gcs(image_bytes: bytes, user_id: str, original_filename: str = "uploaded_image") -> str | None:
    mime_type = mimetypes.guess_type(original_filename)[0] or "application/octet-stream"
    if mime_type.lower() not in {
        "image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"
    }:
        return None
    if len(image_bytes) > MAX_IMAGE_UPLOAD_SIZE_BYTES:
        return None
    client = storage.Client(project=PROJECT_ID)
    bucket = client.bucket(GCS_BUCKET_NAME)
    object_name = f"{user_id}/{uuid.uuid4().hex}_{original_filename}"
    blob = bucket.blob(object_name)
    try:
        blob.upload_from_string(image_bytes, content_type=mime_type)
        return f"gs://{GCS_BUCKET_NAME}/{object_name}"
    except Exception as e:
        logger.error(f"upload_image_to_gcs error: {e}", exc_info=True)
        return None

def delete_image_from_gcs(gcs_uri: str) -> bool:
    prefix = f"gs://{GCS_BUCKET_NAME}/"
    if not gcs_uri.startswith(prefix):
        return False
    path = gcs_uri[len(prefix):]
    client = storage.Client(project=PROJECT_ID)
    bucket = client.bucket(GCS_BUCKET_NAME)
    blob = bucket.blob(path)
    try:
        if blob.exists():
            blob.delete()
        return True
    except Exception as e:
        logger.error(f"delete_image_from_gcs error: {e}", exc_info=True)
        return False
