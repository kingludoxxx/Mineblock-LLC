# Gemini Video Transcription Rate Limit Issue — Root Cause & Solutions

## THE PROBLEM

When users provide a video URL (Facebook Ad Library, YouTube, etc.), the system transcribes it using Gemini 2.0 Flash. This is failing with 429 rate limit errors, which **blocks the entire request for 60 seconds**.

### Current Behavior
```javascript
// /server/src/routes/briefPipeline.js:570
async function transcribeWithGemini(mediaUrl) {
  // ... download & prepare media ...
  
  let result = await callGeminiWithRetry(models, requestBody);
  if (result) return result;
  
  // PROBLEM: This blocks the entire request
  console.log('[BriefPipeline] All Gemini models rate-limited, waiting 60s...');
  await new Promise(r => setTimeout(r, 60000));  // ⚠️ BLOCKS HERE
  
  result = await callGeminiWithRetry(models, requestBody);
  if (result) return result;
  
  throw new Error('Video transcription failed — Gemini rate limit. Please wait 1-2 minutes and try again.');
}
```

### Rate Limit Handling (L716)
```javascript
async function callGeminiWithRetry(models, requestBody) {
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      // ... fetch request ...
      
      if (geminiRes.status === 429) {
        console.warn(`[BriefPipeline] ${model} rate limited (429), trying next model...`);
        lastError = `${model}: Rate limited`;
        break; // Tries next model, but...
      }
      
      // If BOTH models return 429 → function returns null
      // Then caller waits 60s and retries (BLOCKING)
    }
  }
  return null; // Both models exhausted
}
```

---

## ROOT CAUSE

1. **Single Gemini API Key**: One key is shared across all transcription requests
2. **15K requests/minute quota**: Global quota per key, not per user
3. **No Queue System**: Requests arrive synchronously and hit quota immediately
4. **Blocking Retry**: When quota exhausted, code sleeps for 60s (blocks the entire request/response cycle)
5. **No Backoff Between Models**: Tries both models in quick succession, but they share same quota

---

## SOLUTION ARCHITECTURE

### Option 1: Queue System (Recommended)
**Pros**: Handles concurrent transcription fairly, prevents thundering herd
**Cons**: Adds complexity, requires background job

```javascript
class GeminiTranscriptionQueue {
  constructor(maxConcurrent = 2) {
    this.maxConcurrent = maxConcurrent;
    this.activeCount = 0;
    this.queue = [];
  }
  
  async transcribe(url) {
    return new Promise((resolve, reject) => {
      this.queue.push({ url, resolve, reject });
      this.processNext();
    });
  }
  
  async processNext() {
    if (this.activeCount >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }
    
    this.activeCount++;
    const { url, resolve, reject } = this.queue.shift();
    
    try {
      const transcript = await this._transcribeWithExponentialBackoff(url);
      resolve(transcript);
    } catch (err) {
      reject(err);
    } finally {
      this.activeCount--;
      // Stagger requests: wait 1s between submissions
      await new Promise(r => setTimeout(r, 1000));
      this.processNext();
    }
  }
  
  async _transcribeWithExponentialBackoff(url) {
    const maxRetries = 3;
    let lastError;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this._doTranscribe(url);
      } catch (err) {
        lastError = err;
        if (err.message.includes('429')) {
          // Exponential backoff: 5s, 10s, 20s
          const backoffMs = (Math.pow(2, attempt) + 1) * 5000;
          console.log(`[Gemini] Rate limited, waiting ${backoffMs}ms before retry...`);
          await new Promise(r => setTimeout(r, backoffMs));
        } else {
          throw err; // Non-429 errors fail immediately
        }
      }
    }
    
    throw lastError;
  }
  
  async _doTranscribe(url) {
    // ... actual transcription logic ...
  }
}

// Export singleton
const geminiQueue = new GeminiTranscriptionQueue(2);
export default geminiQueue;
```

### Option 2: Multiple API Keys (Easy, Recommended)
**Pros**: Simple, immediate relief, no code changes
**Cons**: Requires managing multiple keys

Create 2-3 Gemini API keys and rotate them:
```javascript
const GEMINI_API_KEYS = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
];

let currentKeyIndex = 0;

async function callGeminiWithRetry(models, requestBody) {
  for (let keyIndex = 0; keyIndex < GEMINI_API_KEYS.length; keyIndex++) {
    const key = GEMINI_API_KEYS[(currentKeyIndex + keyIndex) % GEMINI_API_KEYS.length];
    
    for (const model of models) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
        const res = await fetch(url, {...});
        
        if (res.status === 200) {
          currentKeyIndex = (currentKeyIndex + 1) % GEMINI_API_KEYS.length;
          return result; // Success, rotate to next key for next request
        }
        
        if (res.status === 429) {
          console.log(`[Gemini] Key ${keyIndex} rate limited, trying next key...`);
          continue; // Try next key
        }
      } catch (err) {
        // ...
      }
    }
  }
  
  throw new Error('All Gemini API keys rate limited');
}
```

### Option 3: Webhook + Async Processing
**Pros**: Request returns immediately, processing happens in background
**Cons**: User doesn't see result in same request, needs polling

```javascript
router.post('/generate-from-script', authenticate, async (req, res) => {
  // ... basic validation ...
  
  // Create brief record immediately
  const brief = await pgQuery(`INSERT INTO brief_pipeline_generated (...) 
    VALUES (...) RETURNING *`, [...]);
  
  // Return immediately
  res.json({ success: true, brief_id: brief.id, status: 'transcription_pending' });
  
  // Start transcription in background (fire and forget with error logging)
  (async () => {
    try {
      const transcript = await geminiQueue.transcribe(url);
      await pgQuery(`UPDATE brief_pipeline_generated SET transcript = $1 WHERE id = $2`,
        [transcript, brief.id]);
    } catch (err) {
      console.error('[BriefPipeline] Background transcription failed:', err);
      await pgQuery(`UPDATE brief_pipeline_generated SET status = 'transcription_failed' WHERE id = $1`,
        [brief.id]);
    }
  })();
});
```

---

## IMPLEMENTATION RECOMMENDATION

### Phase 1: Quick Fix (Today)
1. Add 2 more Gemini API keys to `.env`
2. Implement key rotation in `callGeminiWithRetry()`
3. Remove the blocking 60s wait

**Time**: 30 minutes
**Impact**: 3x quota increase, eliminates blocking waits

### Phase 2: Robust Fix (Next Sprint)
1. Implement queue system for transcriptions
2. Add exponential backoff
3. Set up monitoring/alerting for rate limit hits

**Time**: 2 hours
**Impact**: Fair queuing, no blocking, better error handling

### Phase 3: Long-term (Future)
1. Consider alternative transcription service (Assembly.ai, Rev.com)
2. Cache transcripts by URL (avoid re-transcription)
3. Pre-process common competitor URLs offline

---

## GEMINI API KEY SETUP

1. Go to Google Cloud Console
2. Select project
3. Enable "Generative Language API"
4. Create multiple API keys (can create in same project)
5. Add to `.env`:
```env
GEMINI_API_KEY=AIzaSy...key1...
GEMINI_API_KEY_2=AIzaSy...key2...
GEMINI_API_KEY_3=AIzaSy...key3...
```

Each key gets 15,000 req/minute quota, so 3 keys = 45,000 req/min

---

## TESTING THE FIX

### Test Case 1: Single video (no rate limit)
```bash
curl -X POST http://localhost:3000/api/v1/brief-pipeline/generate-from-script \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -d '{
    "url": "https://facebook.com/ads/library/...",
    "productCode": "MR",
    "mode": "variants",
    "numVariations": 3
  }'
```
Expected: Complete in 2-3 minutes

### Test Case 2: Concurrent videos (stress test)
- Open 5 browser tabs
- Submit 5 video URLs simultaneously
- Monitor logs for rate limit messages
- Verify all complete without blocking

### Test Case 3: Rate limit recovery
- Submit video that triggers 429
- Verify request completes (doesn't hang for 60s)
- Check logs show proper key rotation

---

## MONITORING & ALERTING

Add to monitoring:
```javascript
// Monitor Gemini rate limit hits
let rateLimitHits = 0;
const startTime = Date.now();

// In callGeminiWithRetry()
if (res.status === 429) {
  rateLimitHits++;
  if (rateLimitHits > 5 && Date.now() - startTime < 60000) {
    console.error('[ALERT] High rate limit hit rate — consider quota increase');
    // Send Slack notification
  }
}
```

---

## ENVIRONMENT CONFIGURATION

After implementing fix, `.env` should have:
```env
GEMINI_API_KEY=AIzaSyAOHJ5ofP7KvHZuoXvjxfSRAd60Q9onm-s
GEMINI_API_KEY_2=AIzaSy...
GEMINI_API_KEY_3=AIzaSy...

# Or use comma-separated list
GEMINI_API_KEYS=AIzaSy...key1...,AIzaSy...key2...,AIzaSy...key3...
```

---

## FILE CHANGES NEEDED

### `/server/src/routes/briefPipeline.js`

#### Change 1: Remove blocking wait (L630-631)
```javascript
// BEFORE:
console.log('[BriefPipeline] waiting 60s for rate limit reset...');
await new Promise(r => setTimeout(r, 60000));

// AFTER:
// (remove entirely, let error propagate)
```

#### Change 2: Add key rotation to callGeminiWithRetry (L716)
```javascript
// At the top, add key list
const GEMINI_API_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY).split(',');
let currentKeyIndex = 0;

// Modify callGeminiWithRetry to rotate keys
async function callGeminiWithRetry(models, requestBody) {
  for (let keyAttempt = 0; keyAttempt < GEMINI_API_KEYS.length; keyAttempt++) {
    const key = GEMINI_API_KEYS[(currentKeyIndex + keyAttempt) % GEMINI_API_KEYS.length];
    
    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
          // ... rest of logic ...
          
          if (geminiRes.status === 200) {
            currentKeyIndex = (currentKeyIndex + 1) % GEMINI_API_KEYS.length;
            return result; // Success, rotate key
          }
          
          if (geminiRes.status === 429) {
            console.warn(`[BriefPipeline] Key ${keyAttempt} rate limited, trying next key...`);
            break; // Try next key, not next attempt
          }
          // ...
        }
      }
    }
  }
  
  return null; // All keys exhausted
}
```

#### Change 3: Better error message (L635)
```javascript
// BEFORE:
throw new Error('Video transcription failed — Gemini rate limit. Please wait 1-2 minutes and try again.');

// AFTER:
throw new Error('Video transcription failed — all Gemini API keys exhausted. Please try again in a few minutes.');
```

---

## EXPECTED OUTCOME

After Phase 1 implementation:
- **3x quota increase** (45K req/min instead of 15K)
- **No blocking waits** (concurrent requests don't block each other)
- **Better UX** (transcriptions complete faster, less timeout errors)
- **Cost**: Free (same Google Cloud project)

After Phase 2 implementation:
- **Fair queueing** (first-in-first-out fairness)
- **Graceful degradation** (queue handles bursts)
- **Better monitoring** (know when quota is exhausted)
