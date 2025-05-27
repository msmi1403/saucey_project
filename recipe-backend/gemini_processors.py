# gemini_processors.py
import google.generativeai as genai
from google.generativeai import types # For HarmCategory/HarmBlockThreshold
import PIL.Image
import io
import logging
import asyncio
import base64
import json

import config
# Corrected import from utils:
from utils import scrub_and_parse_json_string, extract_json_from_text, is_valid_image_mime_type
from image_processor import upload_image_to_gcs, delete_image_from_gcs

logger = logging.getLogger(__name__)

_gemini_configured = False

def ensure_gemini_configured():
    """Ensures the Gemini API is configured with the API key."""
    global _gemini_configured
    if not _gemini_configured:
        if config.GEMINI_API_KEY:
            genai.configure(api_key=config.GEMINI_API_KEY)
            _gemini_configured = True
            logger.info("Gemini API key configured successfully.")
        else:
            logger.error("CRITICAL: Gemini API key is not available in config.GEMINI_API_KEY. Cannot configure Gemini.")

safety_settings_gemini = [
    {"category": types.HarmCategory.HARM_CATEGORY_HARASSMENT, "threshold": types.HarmBlockThreshold.BLOCK_NONE},
    {"category": types.HarmCategory.HARM_CATEGORY_HATE_SPEECH, "threshold": types.HarmBlockThreshold.BLOCK_NONE},
    {"category": types.HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, "threshold": types.HarmBlockThreshold.BLOCK_NONE},
    {"category": types.HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, "threshold": types.HarmBlockThreshold.BLOCK_NONE},
]

def get_default_generation_config():
    """Returns the default generation config, requesting JSON output."""
    return {
        "temperature": config.GEMINI_TEMPERATURE,
        "top_p": config.GEMINI_TOP_P,
        "top_k": config.GEMINI_TOP_K,
        "max_output_tokens": config.GEMINI_MAX_OUTPUT_TOKENS,
        "response_mime_type": "application/json",
    }

async def process_text_prompt(prompt_text: str, user_id: str = None) -> dict:
    ensure_gemini_configured()
    if not _gemini_configured:
        return {"error": "Gemini API not configured (API key missing)."}

    try:
        logger.info(f"Processing text prompt for user {user_id if user_id else 'N/A'}. Prompt length: {len(prompt_text)}")
        model = genai.GenerativeModel(
            config.GEMINI_MODEL_TEXT,
            safety_settings=safety_settings_gemini,
            generation_config=get_default_generation_config()
        )
        
        full_prompt = [config.RECIPE_SYSTEM_PROMPT_JSON, f"User query: {prompt_text}"]
        response = await model.generate_content_async(full_prompt)
        
        logger.debug(f"Raw Gemini text response: {response.text[:500]}...")
        # Use the corrected function name if extract_json_from_text internally needs scrubbing
        # Assuming extract_json_from_text handles potentially problematic text,
        # or you'd call scrub_and_parse_json_string on response.text before passing to extract_json_from_text
        # For now, let's assume extract_json_from_text is the primary parser.
        # If extract_json_from_text itself fails due to bad JSON, then:
        # cleaned_text = scrub_and_parse_json_string(response.text) # This returns a dict/list OR raises ValueError
        # recipe_data = cleaned_text if isinstance(cleaned_text (dict, list)) else extract_json_from_text(response.text)
        # For simplicity, if extract_json_from_text is robust:
        recipe_data = extract_json_from_text(response.text)


        if not recipe_data or "error" in recipe_data:
            logger.error(f"Failed to extract valid JSON from Gemini response for text prompt. Response text: {response.text[:200]}")
            # If parsing failed, attempt scrubbing then parsing again
            try:
                logger.info("Attempting to scrub and re-parse JSON from text prompt response.")
                # scrub_and_parse_json_string should return a dict/list if successful, or raise ValueError
                recipe_data = scrub_and_parse_json_string(response.text)
            except ValueError as ve: # Catch error from scrub_and_parse_json_string
                logger.error(f"Scrubbing and re-parsing also failed for text prompt: {ve}")
                return {"error": f"Failed to parse recipe from AI response even after scrubbing: {ve}"}


        if not recipe_data or "error" in recipe_data: # Re-check after scrubbing attempt
            logger.error(f"Still no valid recipe data after scrubbing attempt for text prompt.")
            return recipe_data if isinstance(recipe_data, dict) and "error" in recipe_data else {"error": "Failed to parse recipe from AI response."}


        if "recipeId" not in recipe_data or not recipe_data.get("recipeId"):
            recipe_data["recipeId"] = config.generate_unique_id()
        recipe_data["source"] = "text_prompt_gemini"
        
        logger.info(f"Successfully processed text prompt. Recipe title: {recipe_data.get('title', 'N/A')}")
        return recipe_data

    except Exception as e:
        logger.error(f"ERROR (process_text_prompt): An exception occurred: {type(e).__name__} - {e}", exc_info=True)
        return {"error": f"AI service call failed: {str(e)}"}


async def process_image_async(image_bytes: bytes, mime_type: str, prompt: str, user_id: str) -> dict:
    ensure_gemini_configured()
    if not _gemini_configured:
        return {"error": "Gemini API not configured (API key missing)."}

    if not user_id:
        logger.error("User ID is required for image processing to manage GCS uploads.")
        return {"error": "User ID is required."}

    if not is_valid_image_mime_type(mime_type):
        logger.error(f"Unsupported image MIME type: {mime_type}")
        return {"error": f"Unsupported image MIME type: {mime_type}. Supported types: image/png, image/jpeg, image/webp, image/heic, image/heif"}

    gcs_uri = None
    temp_image_uploaded_to_gcs = False

    try:
        gcs_uri = upload_image_to_gcs(image_bytes, user_id, original_filename=f"upload.{mime_type.split('/')[-1]}")
        if not gcs_uri:
            return {"error": "Failed to upload image to Cloud Storage."}
        temp_image_uploaded_to_gcs = True

        logger.info(f"Image uploaded to {gcs_uri}. Processing with Gemini Vision. Prompt: {prompt}")
        image_part = genai.Part.from_uri(uri=gcs_uri, mime_type=mime_type)
        full_prompt_parts = [config.RECIPE_SYSTEM_PROMPT_JSON, prompt, image_part]

        model = genai.GenerativeModel(
            config.GEMINI_MODEL_VISION,
            safety_settings=safety_settings_gemini,
            generation_config=get_default_generation_config()
        )
        
        response = await model.generate_content_async(full_prompt_parts)
        logger.debug(f"Raw Gemini vision response: {response.text[:500]}...")
        
        # Attempt to parse JSON
        recipe_data = extract_json_from_text(response.text)

        if not recipe_data or "error" in recipe_data:
            logger.error(f"Failed to extract valid JSON from Gemini vision response. URI: {gcs_uri}. Response text: {response.text[:200]}")
            try:
                logger.info("Attempting to scrub and re-parse JSON from vision response.")
                recipe_data = scrub_and_parse_json_string(response.text)
            except ValueError as ve:
                logger.error(f"Scrubbing and re-parsing also failed for vision response: {ve}")
                return {"error": f"Failed to parse recipe from AI vision response even after scrubbing: {ve}"}
        
        if not recipe_data or "error" in recipe_data: # Re-check after scrubbing
            logger.error(f"Still no valid recipe data after scrubbing attempt for vision response.")
            return recipe_data if isinstance(recipe_data, dict) and "error" in recipe_data else {"error": "Failed to parse recipe from AI vision response."}
        
        if "recipeId" not in recipe_data or not recipe_data.get("recipeId"):
            recipe_data["recipeId"] = config.generate_unique_id()
        recipe_data["source"] = "image_upload_gemini_vision"
        recipe_data["originalImageGcsUri"] = gcs_uri

        logger.info(f"Successfully processed image. Recipe title: {recipe_data.get('title', 'N/A')}")
        return recipe_data

    except Exception as e:
        logger.error(f"ERROR (process_image_async): An exception occurred: {type(e).__name__} - {e}", exc_info=True)
        return {"error": f"AI service (Vision) call failed or processing error: {str(e)}"}
    finally:
        if temp_image_uploaded_to_gcs and gcs_uri:
            logger.info(f"Attempting to delete temporary image from GCS: {gcs_uri}")
            delete_success = delete_image_from_gcs(gcs_uri)
            if not delete_success:
                logger.warning(f"Failed to delete temporary image {gcs_uri} from GCS.")

async def process_url_async(url: str, user_prompt: str = None, user_id: str = None) -> dict:
    ensure_gemini_configured()
    if not _gemini_configured and user_prompt:
        return {"error": "Gemini API not configured (API key missing)."}
        
    logger.info(f"Processing URL: {url} for user {user_id if user_id else 'N/A'}. Additional prompt: {user_prompt}")
    try:
        from recipe_scraper import parse_recipe_from_url
        recipe_data = await parse_recipe_from_url(url, user_instructions=user_prompt)

        if not recipe_data or "error" in recipe_data:
            logger.error(f"Failed to process URL {url}. Scraper error: {recipe_data.get('error', 'Unknown scraping error') if recipe_data else 'No data'}")
            return recipe_data if isinstance(recipe_data, dict) and "error" in recipe_data else {"error": "Failed to scrape or process recipe from URL."}

        if "recipeId" not in recipe_data or not recipe_data.get("recipeId"):
            recipe_data["recipeId"] = config.generate_unique_id()
        if "source" not in recipe_data:
             recipe_data["source"] = "url_processed"

        logger.info(f"Successfully processed URL {url}. Recipe title: {recipe_data.get('title', 'N/A')}")
        return recipe_data

    except Exception as e:
        logger.error(f"ERROR (process_url_async): An exception occurred for URL {url}: {type(e).__name__} - {e}", exc_info=True)
        return {"error": f"Failed to process URL {url}: {str(e)}"}

async def generate_recipe_title_async(description: str) -> dict:
    ensure_gemini_configured()
    if not _gemini_configured:
        return {"error": "Gemini API not configured (API key missing)."}

    try:
        logger.info(f"Generating recipe title for description: {description[:100]}...")
        model = genai.GenerativeModel(
            config.GEMINI_MODEL_TEXT,
            safety_settings=safety_settings_gemini,
            generation_config={"temperature": 0.7, "max_output_tokens": 60}
        )
        prompt = f"{config.RECIPE_TITLE_SYSTEM_PROMPT}\n\nRecipe Description/Ingredients:\n{description}\n\nSuggested Title:"
        response = await model.generate_content_async(prompt)
        suggested_title = response.text.strip().replace('"', '')
        
        if not suggested_title:
            logger.warning("Gemini did not return a suggested title.")
            return {"error": "Could not generate a title."}

        logger.info(f"Suggested title: {suggested_title}")
        return {"suggestedTitle": suggested_title}

    except Exception as e:
        logger.error(f"ERROR (generate_recipe_title_async): An exception occurred: {type(e).__name__} - {e}", exc_info=True)
        return {"error": f"AI service call for title generation failed: {str(e)}"}

async def stream_gemini_response(model, prompt_parts: list):
    ensure_gemini_configured()
    if not _gemini_configured and not model:
        logger.error("Stream Gemini: API not configured and model not provided/valid.")
        yield json.dumps({"error": "Streaming failed: Gemini API not configured."}) + "\n\n"
        return

    logger.info("stream_gemini_response: Starting stream generation.")
    try:
        response_stream = await model.generate_content_async(
            prompt_parts,
            stream=True,
            safety_settings=safety_settings_gemini,
            generation_config={ 
                "temperature": config.GEMINI_TEMPERATURE,
                "max_output_tokens": config.GEMINI_MAX_OUTPUT_TOKENS
            }
        )
        async for chunk in response_stream:
            data_to_send = ""
            if hasattr(chunk, 'text') and chunk.text:
                data_to_send = chunk.text
            elif chunk.parts: # Check for parts if text is not direct attribute
                for part in chunk.parts:
                    if hasattr(part, 'text') and part.text:
                        data_to_send += part.text
            
            if data_to_send:
                yield data_to_send
        logging.info("stream_gemini_response: Finished stream generation.")
    except Exception as e:
        logger.error(f"Error during streaming response from Gemini: {e}", exc_info=True)
        error_message = json.dumps({"error": f"Streaming failed: {str(e)}"})
        yield error_message