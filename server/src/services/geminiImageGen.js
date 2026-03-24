const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.0-flash-preview-image-generation';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const MAX_CONCURRENT = 3;

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

function isGeminiConfigured() {
  return !!GEMINI_API_KEY;
}

export { generateImage, generateImages, isGeminiConfigured };
