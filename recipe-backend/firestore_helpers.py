# recipe-backend/firestore_helpers.py
import asyncio
from google.cloud import firestore
import uuid
import logging
from datetime import datetime, timezone # For timestamps

# --- Firestore Client Initialization ---
# It's generally recommended to initialize clients globally in Cloud Functions.
# This allows the client to be reused across multiple invocations on the same
# function instance, reducing latency and connection overhead.
# The google-cloud-firestore client is thread-safe.
try:
    db = firestore.Client()
    logging.info("Firestore client initialized successfully globally.")
except Exception as e:
    # If the client fails to initialize, functions relying on it will likely fail.
    # Log critical error. Depending on the app, you might want to raise an
    # exception here to make it clear during deployment or first invocation.
    logging.critical(f"FATAL: Failed to initialize Firestore client: {e}", exc_info=True)
    db = None # Functions should check if db is None before proceeding.

# --- Custom Exceptions (Optional but good for clarity) ---
class FirestoreHelperError(Exception):
    """Base exception for errors in this module."""
    pass

class RecipeNotFoundError(FirestoreHelperError):
    """Custom exception for when a recipe is not found."""
    pass

class OperationFailedError(FirestoreHelperError):
    """Custom exception for when a Firestore operation fails."""
    pass


# --- Helper Functions ---
def generate_unique_id() -> str:
    """Generates a unique UUID string for recipe IDs."""
    return str(uuid.uuid4())

# --- Synchronous Core Logic (to be run in executor) ---
# These functions contain the actual blocking Firestore calls.
# They are prefixed with '_' to indicate they are internal and synchronous.

def _save_recipe_sync(user_id: str, recipe_id: str, data: dict) -> None:
    """
    Saves (creates or overwrites) recipe data to Firestore. Synchronous.
    Raises ValueError for invalid inputs or OperationFailedError for Firestore issues.
    """
    if not db:
        raise ConnectionRefusedError("Firestore client is not initialized.")
    if not user_id:
        raise ValueError("User ID cannot be empty for saving a recipe.")
    if not recipe_id:
        raise ValueError("Recipe ID cannot be empty for saving a recipe.")
    if not isinstance(data, dict):
        raise ValueError("Recipe data must be a dictionary.")

    try:
        doc_ref = db.collection('users').document(user_id).collection('recipes').document(recipe_id)
        
        data_to_save = data.copy()
        data_to_save['id'] = recipe_id # Ensure ID is in the document
        # Add/update timestamps
        current_time = datetime.now(timezone.utc)
        data_to_save['updated_at'] = current_time
        # If creating, set created_at. This requires a read-before-write or transaction
        # For simplicity here, we just set updated_at.
        # To set created_at only once:
        # doc_snapshot = doc_ref.get()
        # if not doc_snapshot.exists:
        #    data_to_save['created_at'] = current_time
        
        doc_ref.set(data_to_save)
        logging.info(f"Recipe {recipe_id} for user {user_id} saved/updated in Firestore.")
    except Exception as e:
        logging.error(f"Firestore error saving recipe {recipe_id} for user {user_id}: {e}", exc_info=True)
        raise OperationFailedError(f"Failed to save recipe to Firestore: {e}")


def _get_recipe_sync(user_id: str, recipe_id: str) -> dict | None:
    """
    Retrieves a specific recipe from Firestore. Synchronous.
    Returns recipe data as dict if found, None otherwise.
    Raises ValueError for invalid inputs or OperationFailedError for Firestore issues.
    """
    if not db:
        raise ConnectionRefusedError("Firestore client is not initialized.")
    if not user_id:
        raise ValueError("User ID cannot be empty for retrieving a recipe.")
    if not recipe_id:
        raise ValueError("Recipe ID cannot be empty for retrieving a recipe.")

    try:
        doc_ref = db.collection('users').document(user_id).collection('recipes').document(recipe_id)
        doc = doc_ref.get()
        
        if doc.exists:
            logging.info(f"Recipe {recipe_id} for user {user_id} retrieved from Firestore.")
            return doc.to_dict()
        else:
            logging.info(f"Recipe {recipe_id} for user {user_id} not found in Firestore.")
            return None # Or raise RecipeNotFoundError if you prefer explicit error for not found
    except Exception as e:
        logging.error(f"Firestore error retrieving recipe {recipe_id} for user {user_id}: {e}", exc_info=True)
        raise OperationFailedError(f"Failed to retrieve recipe from Firestore: {e}")


def _get_all_recipes_for_user_sync(user_id: str) -> list[dict]:
    """
    Retrieves all recipes for a given user. Synchronous.
    Returns a list of recipe dicts. Can be empty if no recipes found.
    Raises ValueError for invalid inputs or OperationFailedError for Firestore issues.
    """
    if not db:
        raise ConnectionRefusedError("Firestore client is not initialized.")
    if not user_id:
        raise ValueError("User ID cannot be empty for retrieving all recipes.")

    try:
        recipes_ref = db.collection('users').document(user_id).collection('recipes')
        # You might want to add ordering, e.g., .order_by("updated_at", direction=firestore.Query.DESCENDING)
        docs_stream = recipes_ref.stream() 
        
        recipes_list = [doc.to_dict() for doc in docs_stream]
        logging.info(f"Retrieved {len(recipes_list)} recipes for user {user_id} from Firestore.")
        return recipes_list
    except Exception as e:
        logging.error(f"Firestore error retrieving all recipes for user {user_id}: {e}", exc_info=True)
        raise OperationFailedError(f"Failed to retrieve all recipes for user {user_id} from Firestore: {e}")


def _delete_recipe_sync(user_id: str, recipe_id: str) -> bool:
    """
    Deletes a specific recipe from Firestore. Synchronous.
    Returns True if deletion was attempted (Firestore delete is idempotent).
    Raises ValueError for invalid inputs or OperationFailedError for Firestore issues.
    """
    if not db:
        raise ConnectionRefusedError("Firestore client is not initialized.")
    if not user_id:
        raise ValueError("User ID cannot be empty for deleting a recipe.")
    if not recipe_id:
        raise ValueError("Recipe ID cannot be empty for deleting a recipe.")

    try:
        doc_ref = db.collection('users').document(user_id).collection('recipes').document(recipe_id)
        # Firestore's delete operation doesn't error if the document doesn't exist.
        # If you need to confirm existence first, you'd do a get(), but it's an extra read.
        doc_ref.delete()
        logging.info(f"Recipe {recipe_id} for user {user_id} deleted (or attempt thereof) from Firestore.")
        return True # Indicates the operation was issued
    except Exception as e:
        logging.error(f"Firestore error deleting recipe {recipe_id} for user {user_id}: {e}", exc_info=True)
        raise OperationFailedError(f"Failed to delete recipe from Firestore: {e}")


# --- Asynchronous Wrapper Functions ---
# These are the public functions your async application code (e.g., main.py) should call.

async def save_recipe(user_id: str, recipe_id: str, data: dict) -> None:
    """Asynchronously saves recipe data to Firestore."""
    if not db:
        logging.error("Firestore client not available for save_recipe.")
        raise ConnectionRefusedError("Firestore client not initialized.")
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, _save_recipe_sync, user_id, recipe_id, data)
    # run_in_executor will propagate exceptions from _save_recipe_sync

async def get_recipe(user_id: str, recipe_id: str) -> dict | None:
    """
    Asynchronously retrieves a specific recipe from Firestore.
    Returns recipe data as dict if found, None otherwise.
    """
    if not db:
        logging.error("Firestore client not available for get_recipe.")
        raise ConnectionRefusedError("Firestore client not initialized.")
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _get_recipe_sync, user_id, recipe_id)

async def get_all_recipes_for_user(user_id: str) -> list[dict]:
    """Asynchronously retrieves all recipes for a given user."""
    if not db:
        logging.error("Firestore client not available for get_all_recipes_for_user.")
        raise ConnectionRefusedError("Firestore client not initialized.")
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _get_all_recipes_for_user_sync, user_id)

async def delete_recipe(user_id: str, recipe_id: str) -> bool:
    """Asynchronously deletes a specific recipe from Firestore."""
    if not db:
        logging.error("Firestore client not available for delete_recipe.")
        raise ConnectionRefusedError("Firestore client not initialized.")
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _delete_recipe_sync, user_id, recipe_id)