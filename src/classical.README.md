# classical.js

Classical CV version for TallyHo: HSV color pass + contour/shape pass + Tesseract legacy OCR. Cans-specific, rule-based, pre-deep-learning.

## API

```js
import { analyzeFrame, preload } from './classical.js';

await preload(); // optional; lazy-loads on first call otherwise
const decision = await analyzeFrame(canvas, { withOCR: true });
```

`analyzeFrame(source, opts) -> Promise<ClassicalDecision>`

- `source`: `HTMLCanvasElement | OffscreenCanvas | ImageBitmap | ImageData`
- `opts.withOCR` (default `true`): skip Tesseract to halve latency
- `opts.category` (default `TARGET_CATEGORY` from `tools.js`): anything other than `'cans'` is flagged in `reasons` since the rules are tuned only for cans

Returns:

```
ClassicalDecision = {
  detected: boolean,
  label: string|null,
  confidence: number,           // 0..1
  reasons: string[],            // per-signal trace
  signals: {
    hsv:   { dominant_hue, saturation, score },
    shape: { contour_count, aspect_ratio, circularity, score },
    ocr:   { text, confidence } | null
  },
  latency_ms: number
}
```

Also exported: `preload()`, `isLoaded()`, `getThresholds()`.

## Dependencies

Loaded lazily from CDN at first `analyzeFrame` call. No npm install.

- OpenCV.js 4.10.0 (`docs.opencv.org/4.10.0/opencv.js`)
- Tesseract.js 5 (`cdn.jsdelivr.net/npm/tesseract.js@5`)

Tesseract runs in **legacy mode** (`OEM.TESSERACT_ONLY`, value `0`). Not LSTM. The project's framing as "classical vs. DL" depends on this. Call `preload()` once at startup to avoid a cold-start penalty.

## Usage example

```js
import { analyzeFrame } from './classical.js';

const video = document.querySelector('video');
const canvas = document.createElement('canvas');
canvas.width = video.videoWidth;
canvas.height = video.videoHeight;
canvas.getContext('2d').drawImage(video, 0, 0);

const decision = await analyzeFrame(canvas);
console.log(decision.detected, decision.label, decision.reasons);
```

## Known failure modes

- **Will false-positive on can-shaped non-cans with can-like labels.** The Trader Joe's Corn Scented Candle (yellow cylinder, label prints "CAN OF CORN") is the canonical example. HSV says yellow, contours say cylinder, Tesseract reads the word "CAN". Three signals align on the wrong answer. **This is by design;** the DL version exists to catch exactly this class of error through semantic refusal. Do not add semantic checks here.
- Silver/metallic cans are weak for HSV and rely on the shape signal alone. Expect lower recall on tuna and sardine cans under neutral lighting.
- Heavy occlusion breaks the contour pass before the other signals get a chance.
- Bottle-shaped containers with can-like labels will usually be rejected by the aspect-ratio gate (`ASPECT_MAX = 2.6`), though tall cans push that ceiling.
- Thresholds are static. Real-frame tuning belongs in the smoke-test loop; see `scripts/classical-smoke.js`.

## Smoke test

```sh
node scripts/classical-smoke.js <image-path>
```

Runs the full pipeline headless against a single image and prints the decision. Useful for sanity-checking threshold changes before re-running the eval.

## Integration status

Wired in two places: the live UI's pipeline toggle (`app.js`, snap-and-analyze) and the eval harness (`src/eval.js` reads a stored `classical_decision` per sample).
