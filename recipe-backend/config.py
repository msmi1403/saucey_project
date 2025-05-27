# functions/config.py

import uuid

PROJECT_ID                  = "saucey-3fb0f"
LOCATION                    = "us-central1"
SECRET_ID_GEMINI_API_KEY    = "saucey-gemini-key"
SECRET_VERSION_ID           = "latest"
GEMINI_MODEL_NAME           = "gemini-2.0-flash"
USERS_COLLECTION            = "users"
GCS_BUCKET_NAME             = f"saucey-images-{PROJECT_ID}"
DEFAULT_SERVINGS            = 2
DEFAULT_DIFFICULTY          = "Medium"
DEFAULT_CATEGORY            = "Uncategorised"
DEFAULT_RECIPE_TITLE        = "Untitled Recipe"
DEFAULT_INGREDIENT_NAME     = "Unnamed ingredient"
DEFAULT_INGREDIENT_CATEGORY = "Miscellaneous"
DEFAULT_UNKNOWN_INGREDIENT  = "Unknown Ingredient"
UNKNOWN_STEP_TEXT           = "Unknown step"

CORS_HEADERS = {
    "Access-Control-Allow-Origin":      "*",
    "Access-Control-Allow-Methods":     "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":     "Content-Type, Authorization",
    "Access-Control-Max-Age":            "3600"
}

MAX_IMAGE_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024
URL_FETCH_TIMEOUT           = 15  # seconds

def generate_unique_id() -> str:
    return uuid.uuid4().hex
