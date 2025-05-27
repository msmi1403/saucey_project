# functions/utils.py

import re
import json
from config import DEFAULT_INGREDIENT_NAME, DEFAULT_UNKNOWN_INGREDIENT

def coerce_to_ingredient(item) -> dict:
    """
    Normalizes a single ingredient item into a dictionary with consistent keys.
    Expected keys: "quantity" (float|None), "unit" (str|None), "item_name" (str).
    """
    if isinstance(item, dict):
        quantity_raw = item.get("quantity")
        try:
            quantity = float(quantity_raw) if quantity_raw is not None else None
        except (TypeError, ValueError):
            quantity = None

        unit = item.get("unit")
        if isinstance(unit, str):
            unit = unit.strip() or None
        else:
            unit = None

        item_name = item.get("item_name") or item.get("name") or ""
        item_name = item_name.strip() or DEFAULT_INGREDIENT_NAME

        return {"quantity": quantity, "unit": unit, "item_name": item_name}

    if isinstance(item, str):
        return {"quantity": None, "unit": None, "item_name": item.strip() or DEFAULT_INGREDIENT_NAME}

    return {"quantity": None, "unit": None, "item_name": DEFAULT_UNKNOWN_INGREDIENT}


def scrub_and_parse_json_string(raw_json_string: str) -> dict | list:
    """
    Attempts to clean common issues from a JSON string (often from LLM outputs)
    and then parses it.
    """
    if not isinstance(raw_json_string, str):
        print(f"Warning: scrub_and_parse_json_string expected a string, got {type(raw_json_string)}")
        raw_json_string = str(raw_json_string)

    # Remove markdown ```json ... ``` and ``` fences, trim whitespace
    processed_string = re.sub(
        r"^```(?:json)?\s*|\s*```$",
        "",
        raw_json_string,
        flags=re.IGNORECASE | re.MULTILINE
    ).strip()

    try:
        return json.loads(processed_string)
    except json.JSONDecodeError as e:
        # Log the initial failure point for better debugging
        print(f"Initial JSON parse failed (first 500 chars): {processed_string[:500]}... Error: {e}")

        # Attempt common fixes
        # 1. Remove single-line // comments
        fixed_string = re.sub(r"//.*", "", processed_string)
        # 2. Remove multi-line /* ... */ comments
        fixed_string = re.sub(r"/\*.*?\*/", "", fixed_string, flags=re.DOTALL)
        # 3. Remove trailing commas before closing brackets/braces
        fixed_string = re.sub(r",\s*([\]}])", r"\1", fixed_string)
        # 4. Normalize Python/JS literals to JSON
        fixed_string = (
            fixed_string
            .replace("None", "null")
            .replace("True", "true")
            .replace("False", "false")
            .replace("undefined", "null")
            .replace("…", "...")
        )

        try:
            return json.loads(fixed_string)
        except json.JSONDecodeError as final_e:
            # Log the state after fixes and raise a clear error
            print(f"JSON parsing still failed after fixes (first 500 chars): {fixed_string[:500]}... Error: {final_e}")
            # Fallback: raise with the original message
            raise ValueError(f"Invalid JSON format after cleaning: {final_e}") from final_e


# —————————————————————————————————————————————————————————————
# New helpers for image MIME validation and JSON extraction

VALID_IMAGE_MIME_TYPES = {
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/heic",
    "image/heif",
}

def extract_json_from_text(text: str) -> dict | list:
    """
    Extracts the first JSON object or array from a blob of text
    and parses it. Falls back to scrub_and_parse_json_string() if
    json.loads() fails.
    """
    match = re.search(r"(\{.*\}|\[.*\])", text, re.DOTALL)
    if not match:
        raise ValueError("No JSON object or array found in text.")
    json_str = match.group(1)
    try:
        return json.loads(json_str)
    except json.JSONDecodeError:
        return scrub_and_parse_json_string(json_str)

def is_valid_image_mime_type(mime_type: str) -> bool:
    """
    Returns True if the MIME type is one of the allowed image types
    (png, jpeg, webp, heic, heif).
    """
    return mime_type.lower() in VALID_IMAGE_MIME_TYPES
