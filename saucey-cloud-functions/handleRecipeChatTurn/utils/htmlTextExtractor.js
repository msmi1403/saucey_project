const cheerio = require('cheerio');

/**
 * Extracts and cleans text content from HTML, focusing on potential recipe sections.
 * @param {string} htmlContent - The HTML content as a string.
 * @returns {string} - The cleaned text content.
 */
function extractRelevantTextFromHtmlNode(htmlContent) {
    if (!htmlContent) {
        return "";
    }

    const $ = cheerio.load(htmlContent);

    // Remove unwanted tags
    $('script, style, nav, footer, header, aside, form, button, iframe, noscript, link, meta, head, figure, figcaption, #comments, .comments-area, .sidebar, #sidebar, .related-posts, .related-articles, .social-share, .share-buttons, .advertisement, .ad, [class*="ad-"], .site-header, .site-footer, .main-navigation').remove();

    // Attempt to find main content areas (prioritized list)
    const mainContentSelectors = [
        '[itemtype$="/Recipe"]', // Schema.org recipe item
        'article[class*="recipe"]', 
        'div[class*="recipe-content"]', 
        'div[id*="recipe"]',
        'article.post', 
        'div.entry-content', 
        'div.post-content', 
        'main[role="main"]', 
        'main', 
        'div.main-content', 
        'div#main', 
        'div.content',
    ];

    let contentText = '';
    for (const selector of mainContentSelectors) {
        const elements = $(selector);
        if (elements.length > 0) {
            console.log(`htmlTextExtractor: Found elements with selector: ${selector}`);
            elements.each((i, el) => {
                contentText += $(el).text() + '\n\n'; // Add double newline for separation
            });
            if (contentText.trim()) break; // If we got text, use it
        }
    }

    if (!contentText.trim()) {
        console.warn("htmlTextExtractor: No specific recipe/main content selectors matched. Using full body text.");
        contentText = $('body').text();
    }

    // Clean up whitespace
    // Replace multiple newlines (3 or more) with exactly two
    let cleanedText = contentText.replace(/(\s*\n\s*){3,}/g, '\n\n');
    // Replace multiple spaces with a single space
    cleanedText = cleanedText.replace(/\s{2,}/g, ' ').trim();

    // Limit length for LLM (e.g., ~75k chars, roughly <30k tokens for safety with some models)
    // This is a very rough estimate, actual token limits are model-specific.
    const maxLengthForLlm = 75000; 
    if (cleanedText.length > maxLengthForLlm) {
        console.warn(`htmlTextExtractor: Extracted text for LLM was truncated to ${maxLengthForLlm} characters.`);
        cleanedText = cleanedText.substring(0, maxLengthForLlm);
    }
    
    console.log(`DEBUG (htmlTextExtractor): Prepared text for LLM (first 300 chars): ${cleanedText.substring(0, 300)}...`);
    return cleanedText;
}

module.exports = { extractRelevantTextFromHtmlNode }; 