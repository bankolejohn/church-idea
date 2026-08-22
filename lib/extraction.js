/**
 * Monthly Returns Image Extraction Service
 *
 * Uses OpenAI GPT-4o Vision to extract structured data from
 * handwritten church monthly return sheets.
 *
 * Flow:
 * 1. Pastor uploads image (photo of handwritten sheet)
 * 2. Image is sent to OpenAI Vision API
 * 3. AI extracts attendance + income data into structured JSON
 * 4. Returns data for pastor to review/edit before submitting
 */

const OpenAI = require('openai');
const logger = require('./logger');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const EXTRACTION_PROMPT = `You are analyzing a church Monthly Returns Data Sheet. This is a handwritten form with two main sections: ATTENDANCE and INCOME.

Extract ALL data into this exact JSON structure:

{
  "church_name": "string or null",
  "assembly": "string or null",
  "month": "string (e.g., 'May 2026') or null",
  "attendance": [
    {
      "date": "string (e.g., '4/5' or '4/5/26')",
      "men": number or null,
      "women": number or null,
      "youth": number or null,
      "children": number or null,
      "total": number or null
    }
  ],
  "income": [
    {
      "date": "string",
      "tithe_account": number or null,
      "tithe_offering": number or null,
      "main_account": number or null,
      "sunday_school": number or null,
      "evangelism": number or null,
      "pure_water": number or null,
      "other": number or null
    }
  ],
  "totals": {
    "attendance_grand_total": number or null,
    "tithe_account_subtotal": number or null,
    "main_account_subtotal": number or null,
    "overall_grand_total": number or null
  }
}

IMPORTANT RULES:
- If a number is unclear or unreadable, set it to null (the user will correct it)
- Amounts are in Nigerian Naira (₦) — just use the number, no currency symbol
- Include ALL rows visible (typically 4-5 Sundays per month)
- Do NOT guess numbers — if unsure, use null
- The "total" column in attendance should be the sum of men + women + youth + children for that row
- Return ONLY valid JSON — no explanation text, no markdown`;

/**
 * Extract structured data from a monthly returns image.
 *
 * @param {string} imageBase64 - Base64-encoded image data
 * @param {string} mimeType - Image MIME type (e.g., 'image/jpeg')
 * @returns {object} Extracted data structure
 */
async function extractFromImage(imageBase64, mimeType = 'image/jpeg') {
    try {
        logger.info('Starting image extraction via OpenAI Vision');

        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: EXTRACTION_PROMPT },
                        {
                            type: 'image_url',
                            image_url: {
                                url: `data:${mimeType};base64,${imageBase64}`,
                                detail: 'high',  // High detail for handwritten text
                            },
                        },
                    ],
                },
            ],
            max_tokens: 4096,
            temperature: 0,  // Deterministic — we want consistent extraction
        });

        const content = response.choices[0].message.content;

        // Parse the JSON response
        let extracted;
        try {
            // Remove any markdown code fences if present
            const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            extracted = JSON.parse(cleaned);
        } catch (parseError) {
            logger.error('Failed to parse extraction response as JSON', {
                error: parseError.message,
                response: content.substring(0, 500),
            });
            return {
                success: false,
                error: 'AI returned invalid format. Please try again with a clearer image.',
                raw_response: content,
            };
        }

        // Validate basic structure
        if (!extracted.attendance || !extracted.income) {
            return {
                success: false,
                error: 'AI could not identify attendance or income sections in the image.',
                raw_response: content,
            };
        }

        logger.info('Image extraction successful', {
            attendance_rows: extracted.attendance.length,
            income_rows: extracted.income.length,
        });

        return {
            success: true,
            data: extracted,
            tokens_used: response.usage?.total_tokens || 0,
        };

    } catch (error) {
        logger.error('OpenAI Vision extraction failed', { error: error.message });

        if (error.code === 'insufficient_quota') {
            return { success: false, error: 'API quota exceeded. Please try again later.' };
        }
        if (error.code === 'invalid_api_key') {
            return { success: false, error: 'Invalid API key. Please contact administrator.' };
        }

        return { success: false, error: 'Image processing failed. Please try again.' };
    }
}

module.exports = { extractFromImage };
