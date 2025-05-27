# main.py

import base64
import logging
import io
import flask
import functions_framework
import asyncio
from flask import request
from gemini_processors import (
    process_text_prompt,
    process_image_async,
    process_url_async,
    generate_recipe_title_async,
)
from firestore_helpers import (
    save_recipe,
    get_recipe,
    get_all_recipes_for_user,
    delete_recipe,
)
import config

logging.basicConfig(level=logging.INFO, force=True)

@functions_framework.http
def handle_recipe_chat_turn(request):
    headers = config.CORS_HEADERS
    if request.method == "OPTIONS":
        return "", 204, headers
    try:
        req = request.get_json(silent=True) or {}
        action      = req.get("action")
        user_id     = req.get("userId")
        prompt_text = req.get("prompt")
        img_b64     = req.get("imageData")
        img_type    = req.get("imageMimeType", "image/jpeg")
        url         = req.get("url")
        loop        = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        if action == "text" and prompt_text:
            result = loop.run_until_complete(process_text_prompt(prompt_text, user_id))
            return flask.jsonify(result), 200, headers

        if action == "image" and img_b64:
            image_bytes = base64.b64decode(img_b64)
            result = loop.run_until_complete(
                process_image_async(image_bytes, img_type, prompt_text, user_id)
            )
            return flask.jsonify(result), 200, headers

        if action == "url" and url:
            result = loop.run_until_complete(
                process_url_async(url, prompt_text, user_id)
            )
            return flask.jsonify(result), 200, headers

        if action == "generateTitle" and prompt_text:
            result = loop.run_until_complete(generate_recipe_title_async(prompt_text))
            return flask.jsonify(result), 200, headers

        if action == "saveRecipe" and user_id and req.get("recipe"):
            recipe = req["recipe"]
            loop.run_until_complete(
                save_recipe(user_id, recipe.get("recipeId"), recipe)
            )
            return flask.jsonify({"message": "Recipe saved"}), 200, headers

        if action == "getRecipe" and user_id and req.get("recipeId"):
            result = loop.run_until_complete(
                get_recipe(user_id, req.get("recipeId"))
            )
            return flask.jsonify(result), 200, headers

        if action == "getAllRecipes" and user_id:
            result = loop.run_until_complete(get_all_recipes_for_user(user_id))
            return flask.jsonify(result), 200, headers

        if action == "deleteRecipe" and user_id and req.get("recipeId"):
            success = loop.run_until_complete(
                delete_recipe(user_id, req.get("recipeId"))
            )
            status  = 200 if success else 500
            return flask.jsonify({"success": success}), status, headers

        return flask.jsonify({"error": "Invalid action or missing parameters"}), 400, headers

    except Exception as e:
        logging.error(e, exc_info=True)
        return flask.jsonify({"error": str(e)}), 500, headers
