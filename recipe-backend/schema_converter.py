# functions/schema_converter.py

import uuid
import re
from config import (
    DEFAULT_RECIPE_TITLE,
    DEFAULT_SERVINGS,
    DEFAULT_CATEGORY,
    DEFAULT_DIFFICULTY,
    DEFAULT_INGREDIENT_NAME,
    DEFAULT_INGREDIENT_CATEGORY,
)

def parse_schema_duration(duration_str: str | None) -> str | None:
    if not duration_str or not duration_str.startswith("PT"):
        return None
    hours_match = re.search(r"(\d+)H", duration_str)
    mins_match  = re.search(r"(\d+)M", duration_str)
    parts = []
    if hours_match:
        parts.append(f"{int(hours_match.group(1))} hr")
    if mins_match:
        parts.append(f"{int(mins_match.group(1))} min")
    return " ".join(parts) if parts else None

def convert_schema_org_to_internal_recipe(data: dict, source_url: str) -> dict:
    title       = data.get("name") or DEFAULT_RECIPE_TITLE
    servings    = data.get("recipeYield") or DEFAULT_SERVINGS
    category    = data.get("recipeCategory") or DEFAULT_CATEGORY
    difficulty  = data.get("difficulty") or DEFAULT_DIFFICULTY
    prep_time   = parse_schema_duration(data.get("prepTime"))
    cook_time   = parse_schema_duration(data.get("cookTime"))
    total_time  = parse_schema_duration(data.get("totalTime"))

    ingredients = []
    for ing in data.get("recipeIngredient", []):
        ingredients.append({
            "quantity": None,
            "unit":     None,
            "item_name": str(ing),
        })

    instructions = []
    raw_instr = data.get("recipeInstructions")
    if isinstance(raw_instr, list):
        for step in raw_instr:
            instructions.append(step.get("text") if isinstance(step, dict) else str(step))
    elif isinstance(raw_instr, str):
        for sentence in raw_instr.split("."):
            s = sentence.strip()
            if s:
                instructions.append(s)

    image = data.get("image")
    image_url = (
        image[0] if isinstance(image, list) and image
        else image if isinstance(image, str)
        else None
    )

    nutrition = data.get("nutrition") or {}
    calories  = nutrition.get("calories") if isinstance(nutrition, dict) else None

    return {
        "recipeId":           uuid.uuid4().hex,
        "title":              title,
        "servings":           servings,
        "category":           category,
        "difficulty":         difficulty,
        "ingredients":        ingredients,
        "instructions":       instructions,
        "prepTime":           prep_time,
        "cookTime":           cook_time,
        "totalTime":          total_time,
        "imageURL":           image_url.strip() if image_url else None,
        "calories":           calories.strip() if isinstance(calories, str) else None,
        "source":             "url_import_schema.org",
        "originalImportUrl":  source_url,
        "isPublic":           False,
        "isSecretRecipe":     False,
        "tipsAndVariations":  None,
    }
