# functions/recipe_scraper.py

import requests
import extruct # For parsing structured data (JSON-LD, Microdata)
from bs4 import BeautifulSoup # To help clean HTML for Gemini if needed
import uuid
import re

# --- Add this import ---
from vertexai.generative_models import GenerativeModel
# --- End add import ---

from config import (
    URL_FETCH_TIMEOUT, DEFAULT_RECIPE_TITLE
)
from schema_converter import convert_schema_org_to_internal_recipe
# The actual Gemini call for unstructured scrape will be imported from gemini_processors
# from gemini_processors import extract_recipe_from_text_content_for_url_scrape 

def fetch_url_content(url: str) -> str | None:
    """
    Fetches the HTML content of a given URL.
    Returns the HTML content as a string, or raises ConnectionError on failure.
    """
    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36 RecipeApp/1.0 (SauceyRecipeApp/1.0; +http://example.com/botinfo)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Connection': 'keep-alive',
            'DNT': '1', # Do Not Track
            'Upgrade-Insecure-Requests': '1'
        }
        response = requests.get(url, headers=headers, timeout=URL_FETCH_TIMEOUT, allow_redirects=True)
        response.raise_for_status()
        
        try:
            content = response.content.decode('utf-8')
        except UnicodeDecodeError:
            print(f"WARN (fetch_url_content): UTF-8 decoding failed for {url}. Falling back to requests' detected encoding: {response.encoding}")
            content = response.text
        
        print(f"Successfully fetched content from URL: {url} (final URL: {response.url})")
        return content
    except requests.exceptions.Timeout:
        print(f"ERROR (fetch_url_content): Timeout fetching URL {url} after {URL_FETCH_TIMEOUT}s.")
        raise ConnectionError(f"The request to {url} timed out. Please check the URL or try again later.")
    except requests.exceptions.HTTPError as http_err:
        print(f"ERROR (fetch_url_content): HTTP error for URL {url}: {http_err.response.status_code} - {http_err}")
        raise ConnectionError(f"Could not access URL: {url}. The website responded with status {http_err.response.status_code}.")
    except requests.exceptions.RequestException as e:
        print(f"ERROR (fetch_url_content): Failed to fetch URL {url}: {type(e).__name__} - {e}")
        raise ConnectionError(f"Failed to retrieve content from the URL: {url}. Details: {e}")

def extract_relevant_text_from_html(html_content: str) -> str:
    """
    Extracts and cleans text content from HTML, focusing on potential recipe sections.
    """
    if not html_content:
        return ""
        
    soup = BeautifulSoup(html_content, 'html.parser')
    
    for unwanted_tag in soup.find_all([
        'script', 'style', 'nav', 'footer', 'header', 'aside', 'form', 
        'button', 'iframe', 'noscript', 'link', 'meta', 'head',
        'figure', 'figcaption', '#comments', '.comments-area', 
        '.sidebar', '#sidebar', '.related-posts', '.related-articles',
        '.social-share', '.share-buttons', '.advertisement', '.ad', 
        '[class*="ad-"]', '.site-header', '.site-footer', '.main-navigation'
    ]):
        unwanted_tag.decompose()

    main_content_selectors = [
        '[itemtype$="/Recipe"]', 'article[class*="recipe"]', 
        'div[class*="recipe-content"]', 'div[id*="recipe"]',
        'article.post', 'div.entry-content', 'div.post-content', 
        'main[role="main"]', 'main', 'div.main-content', 'div#main', 'div.content',
    ]
    
    content_texts = []
    for selector in main_content_selectors:
        elements = soup.select(selector)
        if elements:
            print(f"Found elements with selector: {selector}")
            for el in elements:
                text = el.get_text(separator='\\n', strip=True)
                content_texts.append(text)
            if content_texts: break 
                
    if not content_texts:
        print("WARN (extract_relevant_text_from_html): No specific recipe/main content selectors matched. Using full body text.")
        body = soup.find('body')
        if body: content_texts.append(body.get_text(separator='\\n', strip=True))

    full_text = "\\n\\n".join(content_texts)
    cleaned_text = re.sub(r'(\s*\\n\s*){3,}', '\\n\\n', full_text).strip()
    cleaned_text = re.sub(r'\s{2,}', ' ', cleaned_text)

    max_length_for_llm = 75000 
    if len(cleaned_text) > max_length_for_llm:
        print(f"WARN (extract_relevant_text_from_html): Extracted text for LLM was truncated to {max_length_for_llm} characters.")
        cleaned_text = cleaned_text[:max_length_for_llm]
        
    print(f"DEBUG (extract_relevant_text_from_html): Prepared text for LLM (first 300 chars): {cleaned_text[:300]}...")
    return cleaned_text

async def parse_recipe_from_url(
    url: str,
    gemini_model_instance: GenerativeModel, # Type hint is now valid due to import
    user_instructions: str | None,
    user_preferences: dict | None
) -> dict | None:
    """
    Fetches a URL, attempts to parse schema.org/Recipe data.
    If successful, converts it to internal format.
    If not, falls back to using Gemini to scrape the page content.
    """
    if not url or not url.startswith(('http://', 'https://')):
        raise ValueError("Invalid URL provided. It must start with http:// or https://.")

    try:
        html_content = fetch_url_content(url)
    except ConnectionError as ce:
        print(f"ERROR (parse_recipe_from_url): Fetching URL failed: {ce}")
        raise 
        
    recipe_schema_data = None
    try:
        structured_data_all_types = extruct.extract(
            html_content.encode('utf-8'),
            base_url=url,
            syntaxes=['json-ld', 'microdata'],
            errors='ignore'
        )
        
        if 'json-ld' in structured_data_all_types:
            for item in structured_data_all_types['json-ld']:
                item_type = item.get('@type', [])
                if isinstance(item_type, str) and item_type == 'Recipe': recipe_schema_data = item; break
                elif isinstance(item_type, list) and 'Recipe' in item_type: recipe_schema_data = item; break
                elif isinstance(item, dict) and '@graph' in item and isinstance(item['@graph'], list):
                    for graph_item in item['@graph']:
                        graph_item_type = graph_item.get('@type', [])
                        if isinstance(graph_item_type, str) and graph_item_type == 'Recipe': recipe_schema_data = graph_item; break
                        elif isinstance(graph_item_type, list) and 'Recipe' in graph_item_type: recipe_schema_data = graph_item; break
                    if recipe_schema_data: break
            if recipe_schema_data: print(f"Found schema.org/Recipe (JSON-LD) at {url}")

        if not recipe_schema_data and 'microdata' in structured_data_all_types:
            for item in structured_data_all_types['microdata']:
                item_type = item.get('type', "")
                if isinstance(item_type, str) and item_type.endswith('/Recipe'):
                    recipe_schema_data = item.get('properties', {})
                    print(f"Found schema.org/Recipe (Microdata) at {url}")
                    break
    except Exception as extruct_err:
        print(f"WARN (parse_recipe_from_url): Extruct processing failed for URL {url}. Error: {extruct_err}. Proceeding to Gemini scrape.")
        recipe_schema_data = None

    if recipe_schema_data:
        try:
            internal_recipe_dict = convert_schema_org_to_internal_recipe(recipe_schema_data, source_url=url)
            if user_instructions and internal_recipe_dict:
                internal_recipe_dict["userModificationInstructions"] = user_instructions.strip()
            return internal_recipe_dict
        except Exception as e_convert:
            print(f"ERROR (parse_recipe_from_url): Failed to convert schema.org data from {url}. Error: {e_convert}. Falling back to Gemini scrape.")
    
    print(f"No valid schema.org/Recipe data found/converted for {url}. Attempting Gemini scrape.")
    
    from gemini_processors import extract_recipe_from_text_content_for_url_scrape # Deferred import
    
    page_text_content = extract_relevant_text_from_html(html_content)
    if not page_text_content.strip():
        print(f"ERROR (parse_recipe_from_url): No text content extracted from {url} for Gemini scrape.")
        raise ValueError("Could not extract meaningful text from the URL to attempt a scrape.")

    try:
        recipe_from_gemini = await extract_recipe_from_text_content_for_url_scrape(
            gemini_model=gemini_model_instance,
            page_text_content=page_text_content,
            user_instructions=user_instructions,
            user_preferences=user_preferences,
            source_url=url
        )

        if recipe_from_gemini and isinstance(recipe_from_gemini, dict):
            if "recipeId" not in recipe_from_gemini or not recipe_from_gemini.get("recipeId"):
                recipe_from_gemini["recipeId"] = str(uuid.uuid4())
            recipe_from_gemini["source"] = "url_scrape_gemini_fallback"
            recipe_from_gemini["originalImportUrl"] = url
            if user_instructions and "userModificationInstructions" not in recipe_from_gemini:
                recipe_from_gemini["userModificationInstructions"] = user_instructions.strip()
            print(f"Successfully scraped recipe from {url} using Gemini. Title: {recipe_from_gemini.get('title', 'N/A')}")
            return recipe_from_gemini
        else:
            print(f"WARN (parse_recipe_from_url): Gemini scrape for {url} returned invalid data.")
            raise ValueError("AI recipe extraction from URL content failed to produce a valid recipe.")
            
    except (ConnectionError, ValueError) as e_gemini_scrape:
        print(f"ERROR (parse_recipe_from_url): Gemini scrape for {url} failed: {e_gemini_scrape}")
        raise 
    except Exception as e_unhandled_gemini:
        print(f"ERROR (parse_recipe_from_url): Unhandled exception during Gemini scrape for {url}: {type(e_unhandled_gemini).__name__} - {e_unhandled_gemini}")
        raise ConnectionAbortedError(f"Unexpected AI error during URL scrape: {url}. Details: {e_unhandled_gemini}")

