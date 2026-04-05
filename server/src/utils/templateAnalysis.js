import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function analyzeTemplate(template) {
  const imageUrl = template.image_url;
  if (!imageUrl) {
    throw new Error('Template has no image_url');
  }

  // Build the full URL if it's a relative path
  let fullImageUrl = imageUrl;
  if (imageUrl.startsWith('/')) {
    fullImageUrl = `${process.env.BASE_URL || 'https://mineblock-server.onrender.com'}${imageUrl}`;
  }

  // Fetch the image and convert to base64
  let imageBase64, mediaType;
  try {
    const response = await fetch(fullImageUrl);
    if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    imageBase64 = buffer.toString('base64');
    mediaType = response.headers.get('content-type') || 'image/png';
  } catch (err) {
    throw new Error(`Could not fetch template image: ${err.message}`);
  }

  const analysisPrompt = `You are a world-class advertising creative analyst. Analyze this ad template image in extreme detail. Return a JSON object with EXACTLY this structure (no markdown, no code fences, just raw JSON):

{
  "template_type": "product-hero|lifestyle|text-only|testimonial|offer-sale|feature-benefit|comparison|before-after|ugc-style|editorial|minimal|collage",
  "layout": {
    "orientation": "portrait|landscape|square",
    "grid_structure": "single-column|two-column|split-diagonal|centered|asymmetric|grid-2x2|freeform",
    "visual_hierarchy": ["element1 (most prominent)", "element2", "element3"],
    "safe_zones": {
      "product_zone": {"position": "center|left|right|top|bottom|top-left|top-right|bottom-left|bottom-right", "size_percent": 40},
      "text_zones": [{"position": "top", "purpose": "headline", "size_percent": 15}],
      "logo_zone": {"position": "top-left|top-right|bottom-left|bottom-right|center-bottom", "size_percent": 5},
      "cta_zone": {"position": "bottom-center|bottom-right", "size_percent": 10}
    }
  },
  "background": {
    "type": "solid|gradient|photo|pattern|blurred-photo",
    "primary_color": "#hex",
    "secondary_color": "#hex or null",
    "gradient_direction": "top-to-bottom|left-to-right|radial|null",
    "complexity": "simple|moderate|complex"
  },
  "typography": {
    "headline": {"font_style": "bold-sans|serif|script|display|condensed", "estimated_size": "large|xl|2xl", "color": "#hex", "effect": "none|shadow|outline|gradient", "alignment": "left|center|right", "text_content": "exact text"},
    "subheadline": {"font_style": "...", "estimated_size": "...", "color": "#hex", "text_content": "exact text or null"},
    "body_text": {"font_style": "...", "estimated_size": "...", "color": "#hex", "text_content": "exact text or null"},
    "cta_text": {"text_content": "exact text or null", "style": "button|link|badge|none"},
    "discount_code": {"text_content": "exact code or null", "display_format": "Use code X|CODE: X|null"},
    "total_text_elements": 5
  },
  "product_analysis": {
    "product_count": 0,
    "product_visible": true,
    "product_type": "physical-product|digital|service|none",
    "product_orientation": "front-facing|angled-left|angled-right|top-down|tilted|three-quarter|none",
    "product_has_packaging": true,
    "product_has_shadow": true,
    "product_is_cutout": true,
    "product_background_interaction": "floating|sitting-on-surface|integrated-into-scene|none",
    "reference_product_category": "category of product shown",
    "reference_product_keywords": ["keyword1", "keyword2"]
  },
  "color_palette": {
    "dominant": "#hex",
    "accent": "#hex",
    "text_primary": "#hex",
    "text_secondary": "#hex",
    "overall_mood": "warm|cool|neutral|vibrant|muted|dark|light"
  },
  "design_elements": {
    "has_border": false,
    "has_badge": false,
    "badge_text": "null or text",
    "has_icon": false,
    "has_pattern": false,
    "has_divider": false,
    "decorative_elements": ["star-burst", "ribbon"],
    "shadow_effects": "none|subtle|heavy",
    "rounded_corners": false
  },
  "emotional_tone": "urgency|trust|luxury|playful|professional|scientific|natural|bold|minimal|warm",
  "target_audience": "general|tech-savvy|health-conscious|budget-shoppers|premium-buyers|young-adults|professionals",
  "ad_effectiveness_notes": "Brief notes on what makes this ad effective or what could be improved",
  "adaptation_instructions": {
    "critical_elements_to_preserve": ["list of elements that MUST stay the same"],
    "elements_safe_to_modify": ["list of elements that can be changed"],
    "text_replacement_strategy": "direct-swap|resize-to-fit|reflow",
    "product_replacement_difficulty": "easy|medium|hard",
    "product_replacement_notes": "specific notes on how to replace the product",
    "common_failure_modes": ["list of things that typically go wrong when adapting this template"]
  }
}

Be extremely precise with colors (use actual hex values from the image), positions, and text content. Every text element visible in the image must be captured exactly. This analysis will be used to generate better ad adaptations.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: imageBase64,
            },
          },
          {
            type: 'text',
            text: analysisPrompt,
          },
        ],
      }],
    });

    const text = response.content[0]?.text || '';
    // Parse JSON - handle potential markdown fences
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Claude did not return valid JSON');
    }

    const analysis = JSON.parse(jsonMatch[0]);
    return analysis;
  } catch (err) {
    if (err.message.includes('JSON')) {
      throw new Error(`Template analysis failed - invalid JSON response: ${err.message}`);
    }
    throw new Error(`Template analysis failed: ${err.message}`);
  }
}
