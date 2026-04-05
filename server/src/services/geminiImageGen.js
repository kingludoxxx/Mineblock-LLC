const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.0-flash-preview-image-generation';
const GEMINI_EDIT_MODEL = 'gemini-3.1-flash-image-preview';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_EDIT_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EDIT_MODEL}:generateContent`;
const MAX_CONCURRENT = 2;

let activeRequests = 0;
const queue = [];

// Rate-limited Gemini image generation
async function generateImage(prompt, systemInstruction, aspectRatio = '4:5') {
  // Queue if at max concurrent
  if (activeRequests >= MAX_CONCURRENT) {
    await new Promise(resolve => queue.push(resolve));
  }
  activeRequests++;

  try {
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        aspectRatio,
      },
    };

    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    const imagePart = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);

    if (!imagePart?.inlineData?.data) {
      throw new Error('Gemini returned no image data');
    }

    return {
      buffer: Buffer.from(imagePart.inlineData.data, 'base64'),
      mimeType: imagePart.inlineData.mimeType || 'image/png',
    };
  } finally {
    activeRequests--;
    if (queue.length > 0) {
      const next = queue.shift();
      next();
    }
  }
}

// Generate multiple images in parallel (respecting rate limit)
async function generateImages(prompts, systemInstruction, aspectRatio = '4:5') {
  const results = await Promise.allSettled(
    prompts.map(prompt => generateImage(prompt, systemInstruction, aspectRatio))
  );

  return results.map((r, i) => ({
    index: i,
    success: r.status === 'fulfilled',
    ...(r.status === 'fulfilled' ? r.value : { error: r.reason.message }),
  }));
}

/**
 * Edit an image using Gemini 3.1 Flash Image — multimodal input (images + text) → image output.
 * This is for the statics pipeline: send product image(s) + reference ad + prompt → get edited ad.
 *
 * @param {string} prompt        - The editing prompt (swap instructions, rules, etc.)
 * @param {Array} inputImages    - Array of { base64, mimeType } objects (product images, logos, reference ad)
 * @param {string} aspectRatio   - Output aspect ratio (default '4:5')
 * @returns {{ buffer: Buffer, mimeType: string }}
 */
async function editImage(prompt, inputImages, aspectRatio = '4:5') {
  if (activeRequests >= MAX_CONCURRENT) {
    await new Promise(resolve => queue.push(resolve));
  }
  activeRequests++;

  try {
    // Build parts: text prompt first, then all input images
    const parts = [{ text: prompt }];
    for (const img of inputImages) {
      parts.push({
        inline_data: {
          mime_type: img.mimeType,
          data: img.base64,
        },
      });
    }

    const body = {
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: {
          aspectRatio,
        },
      },
    };

    console.log(`[geminiImageGen] Sending edit request to ${GEMINI_EDIT_MODEL} with ${inputImages.length} images, prompt length ${prompt.length}`);

    // Retry with exponential backoff for 429 rate limit errors
    const MAX_RETRIES = 3;
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const res = await fetch(`${GEMINI_EDIT_URL}?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000), // 3 min timeout for image editing
      });

      if (res.status === 429 && attempt < MAX_RETRIES) {
        const wait = Math.pow(2, attempt + 1) * 5000; // 10s, 20s, 40s
        console.warn(`[geminiImageGen] Rate limited (429), retrying in ${wait / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (!res.ok) {
        const errText = await res.text();
        lastError = new Error(`Gemini Edit API error ${res.status}: ${errText.slice(0, 500)}`);
        if (res.status >= 500 && attempt < MAX_RETRIES) {
          const wait = Math.pow(2, attempt + 1) * 3000;
          console.warn(`[geminiImageGen] Server error (${res.status}), retrying in ${wait / 1000}s`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw lastError;
      }

      const data = await res.json();
      const candidate = data.candidates?.[0]?.content?.parts || [];
      const imagePart = candidate.find(p => p.inlineData || p.inline_data);

      if (!imagePart) {
        const textPart = candidate.find(p => p.text);
        if (textPart) {
          throw new Error(`Gemini returned text instead of image: ${textPart.text.slice(0, 200)}`);
        }
        throw new Error('Gemini returned no image data');
      }

      const inlineData = imagePart.inlineData || imagePart.inline_data;
      console.log(`[geminiImageGen] Edit successful, received image (${inlineData.mimeType})`);

      return {
        buffer: Buffer.from(inlineData.data, 'base64'),
        mimeType: inlineData.mimeType || 'image/png',
      };
    }

    throw lastError || new Error('Gemini edit failed after retries');
  } finally {
    activeRequests--;
    if (queue.length > 0) {
      const next = queue.shift();
      next();
    }
  }
}

function isGeminiConfigured() {
  return !!GEMINI_API_KEY;
}

export { generateImage, generateImages, editImage, isGeminiConfigured, GEMINI_EDIT_MODEL };
