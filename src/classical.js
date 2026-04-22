// TallyHo classical CV arm. Cans-specific, rule-based.
// Three signals: HSV color pass, contour/shape pass, Tesseract legacy OCR.
// Exists to be the deliberate counterweight to the DL arm: it has no path
// to semantic refusal, so can-shaped non-cans with can-like labels (the
// Trader Joe's Corn Scented Candle) pass. That false positive is the
// finding the two-arm comparison is built around. Do not "fix" it here.

import { TARGET_CATEGORY } from './tools.js';

var OPENCV_URL = 'https://docs.opencv.org/4.10.0/opencv.js';
var TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

// Module-level handles, populated by preload() / first analyzeFrame().
var _cv = null;
var _cvLoading = null;
var _tess = null;
var _tessLoading = null;

// Hue ranges use OpenCV's 0..179 convention. Covers the common can palette
// (yellow, red, blue, green). Silver/metallic is deliberately not a band:
// it's low-saturation and HSV is poor at it; silver cans rely on the shape
// signal alone, which is a known recall gap.
var COLOR_BANDS = [
  { name: 'yellow', hLow: 15, hHigh: 40,  sMin: 70, vMin: 80 },
  { name: 'red_lo', hLow: 0,  hHigh: 10,  sMin: 80, vMin: 60 },
  { name: 'red_hi', hLow: 165, hHigh: 179, sMin: 80, vMin: 60 },
  { name: 'blue',   hLow: 95, hHigh: 125, sMin: 70, vMin: 50 },
  { name: 'green',  hLow: 40, hHigh: 85,  sMin: 60, vMin: 50 }
];

// Coverage: 6% floor keeps distant cans in signal without background noise
// triggering. 18% is the "strong" bar; close-held cans fill 10-40%.
var COLOR_COVERAGE_MIN = 0.06;
var COLOR_COVERAGE_STRONG = 0.18;

// Aspect: 0.8-2.6 covers squat tuna to tall energy-drink cans. Past 2.6
// drifts into bottles, which is where the classical arm is known to fail.
var ASPECT_MIN = 0.8;
var ASPECT_MAX = 2.6;
// Solidity (contour_area / bbox_area): 0.55 tolerates occlusion and label
// cutouts while rejecting spindly noise.
var SOLIDITY_MIN = 0.55;
var BBOX_AREA_MIN = 0.02; // below this fraction of the frame, usually label fragments.

var OCR_CONFIDENCE_MIN = 40; // Tesseract reports 0..100.
var SIGNAL_FIRE = 0.5;
var SIGNAL_STRONG = 0.75;

function loadScript(url) {
  return new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.onload = function () { resolve(); };
    s.onerror = function () { reject(new Error('failed to load ' + url)); };
    document.head.appendChild(s);
  });
}

async function loadOpenCV() {
  if (_cv) return _cv;
  if (_cvLoading) return _cvLoading;
  _cvLoading = (async function () {
    await loadScript(OPENCV_URL);
    // OpenCV.js global `cv` finishes initializing async after script load.
    await new Promise(function (resolve) {
      var iv = setInterval(function () {
        if (window.cv && window.cv.Mat) { clearInterval(iv); resolve(); }
      }, 30);
    });
    _cv = window.cv;
    return _cv;
  })();
  return _cvLoading;
}

async function loadTesseract() {
  if (_tess) return _tess;
  if (_tessLoading) return _tessLoading;
  _tessLoading = (async function () {
    await loadScript(TESSERACT_URL);
    // Legacy mode (OEM.TESSERACT_ONLY = 0). Not LSTM. The two-arm narrative
    // depends on this being pre-deep-learning OCR.
    _tess = await window.Tesseract.createWorker('eng', 0);
    return _tess;
  })();
  return _tessLoading;
}

export async function preload() {
  await Promise.all([loadOpenCV(), loadTesseract()]);
}

// Normalize source (canvas, OffscreenCanvas, ImageBitmap, ImageData) into ImageData.
function toImageData(source) {
  if (source && source.data && source.width && source.height && !source.getContext) {
    return source;
  }
  var w = source.width, h = source.height;
  var canvas = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  var ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

function hsvPass(cv, srcMat) {
  var hsv = new cv.Mat();
  cv.cvtColor(srcMat, hsv, cv.COLOR_RGBA2RGB);
  cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);

  var total = hsv.rows * hsv.cols;
  var best = { name: null, coverage: 0, hue: 0 };
  var combinedMask = cv.Mat.zeros(hsv.rows, hsv.cols, cv.CV_8UC1);

  for (var i = 0; i < COLOR_BANDS.length; i++) {
    var b = COLOR_BANDS[i];
    var lo = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [b.hLow, b.sMin, b.vMin, 0]);
    var hi = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [b.hHigh, 255, 255, 255]);
    var mask = new cv.Mat();
    cv.inRange(hsv, lo, hi, mask);
    var count = cv.countNonZero(mask);
    var coverage = count / total;
    if (coverage > best.coverage) {
      best = { name: b.name, coverage: coverage, hue: (b.hLow + b.hHigh) / 2 };
    }
    cv.bitwise_or(combinedMask, mask, combinedMask);
    lo.delete(); hi.delete(); mask.delete();
  }

  // Mean saturation over the combined mask. High sat = printed labels.
  var satMean = 0;
  if (best.coverage > 0) {
    var channels = new cv.MatVector();
    cv.split(hsv, channels);
    var satMat = channels.get(1);
    var m = cv.mean(satMat, combinedMask);
    satMean = m[0] / 255;
    satMat.delete(); channels.delete();
  }

  hsv.delete();
  combinedMask.delete();

  var coverage = best.coverage;
  var score = 0;
  if (coverage >= COLOR_COVERAGE_STRONG) score = 1;
  else if (coverage >= COLOR_COVERAGE_MIN) {
    score = (coverage - COLOR_COVERAGE_MIN) / (COLOR_COVERAGE_STRONG - COLOR_COVERAGE_MIN);
  }

  return {
    dominant_hue: best.hue,
    saturation: satMean,
    coverage: coverage,
    band: best.name,
    score: score
  };
}

function shapePass(cv, srcMat) {
  var gray = new cv.Mat();
  cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);

  var edges = new cv.Mat();
  cv.Canny(gray, edges, 50, 150);
  // Dilate to close small gaps in the can outline.
  var kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  cv.dilate(edges, edges, kernel);

  var contours = new cv.MatVector();
  var hierarchy = new cv.Mat();
  cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  var frameArea = srcMat.rows * srcMat.cols;
  var best = null;

  for (var i = 0; i < contours.size(); i++) {
    var c = contours.get(i);
    var area = cv.contourArea(c);
    var rect = cv.boundingRect(c);
    var bboxArea = rect.width * rect.height;
    if (bboxArea / frameArea < BBOX_AREA_MIN) { c.delete(); continue; }

    var aspect = rect.height / Math.max(1, rect.width);
    var solidity = area / Math.max(1, bboxArea);
    // Cheap circularity proxy: 4*pi*area / perimeter^2. Rect ~0.78,
    // circle 1.0, noisy blob drops. Face-on cylinders land 0.7-0.85.
    var perim = cv.arcLength(c, true);
    var circularity = perim > 0 ? (4 * Math.PI * area) / (perim * perim) : 0;

    var shapeOk =
      aspect >= ASPECT_MIN && aspect <= ASPECT_MAX &&
      solidity >= SOLIDITY_MIN;

    // Peak score for aspect near 1.5, solidity near 1, circularity ~0.75.
    var score = 0;
    if (shapeOk) {
      var aspectFit = 1 - Math.min(1, Math.abs(aspect - 1.5) / 1.0);
      var solFit = Math.min(1, (solidity - SOLIDITY_MIN) / (1 - SOLIDITY_MIN));
      var circFit = 1 - Math.min(1, Math.abs(circularity - 0.75) / 0.5);
      score = (aspectFit + solFit + circFit) / 3;
    }

    if (!best || score > best.score) {
      best = {
        bbox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        aspect_ratio: aspect,
        solidity: solidity,
        circularity: circularity,
        contour_count: contours.size(),
        score: score
      };
    }
    c.delete();
  }

  gray.delete(); edges.delete(); kernel.delete();
  contours.delete(); hierarchy.delete();

  if (!best) {
    return { contour_count: 0, aspect_ratio: 0, circularity: 0, score: 0, bbox: null };
  }
  return best;
}

async function ocrPass(worker, srcCanvas, bbox) {
  // Crop to the candidate with padding; avoids background text bleed.
  var pad = 8;
  var x = Math.max(0, bbox.x - pad);
  var y = Math.max(0, bbox.y - pad);
  var w = Math.min(srcCanvas.width - x, bbox.w + 2 * pad);
  var h = Math.min(srcCanvas.height - y, bbox.h + 2 * pad);
  var crop = document.createElement('canvas');
  crop.width = w; crop.height = h;
  crop.getContext('2d').drawImage(srcCanvas, x, y, w, h, 0, 0, w, h);
  var res = await worker.recognize(crop);
  var text = (res && res.data && res.data.text ? res.data.text : '').trim();
  var conf = (res && res.data && typeof res.data.confidence === 'number') ? res.data.confidence : 0;
  return { text: text, confidence: conf };
}

// Hand the caller a canvas we can hand to Tesseract.
function sourceToCanvas(source) {
  if (source.getContext) return source;
  var c = document.createElement('canvas');
  c.width = source.width; c.height = source.height;
  var ctx = c.getContext('2d');
  if (source.data) ctx.putImageData(source, 0, 0);
  else ctx.drawImage(source, 0, 0);
  return c;
}

/**
 * Analyze a frame for the target category using classical CV.
 * Runs HSV color filtering + contour/shape analysis + Tesseract OCR.
 * Returns the decision plus the evidence that drove it.
 *
 * @param {HTMLCanvasElement|OffscreenCanvas|ImageBitmap|ImageData} source
 * @param {object} [opts]
 * @param {boolean} [opts.withOCR=true]    - run Tesseract on the strongest candidate
 * @param {string}  [opts.category]        - default reads TARGET_CATEGORY from tools.js
 * @returns {Promise<ClassicalDecision>}
 *
 *   ClassicalDecision = {
 *     detected: boolean,             // passes the category rules
 *     label: string|null,            // OCR'd label text, best-effort
 *     confidence: number,            // 0..1 — product of component scores
 *     reasons: string[],             // human-readable trace of why each signal fired
 *     signals: {
 *       hsv: { dominant_hue: number, saturation: number, score: number },
 *       shape: { contour_count: number, aspect_ratio: number, circularity: number, score: number },
 *       ocr:   { text: string, confidence: number } | null
 *     },
 *     latency_ms: number
 *   }
 */
export async function analyzeFrame(source, opts) {
  opts = opts || {};
  var withOCR = opts.withOCR !== false;
  var category = opts.category || TARGET_CATEGORY;
  var t0 = performance.now();
  var reasons = [];

  if (!source || !source.width || !source.height || source.width < 32 || source.height < 32) {
    return {
      detected: false, label: null, confidence: 0,
      reasons: ['frame too small'],
      signals: { hsv: null, shape: null, ocr: null },
      latency_ms: performance.now() - t0
    };
  }

  if (category !== 'cans') {
    // Flag up front: these rules are tuned only for cans.
    reasons.push('classical arm is cans-specific; category="' + category + '" not supported');
  }

  var cv = await loadOpenCV();
  var imageData = toImageData(source);
  var srcMat = cv.matFromImageData(imageData);

  var hsv = hsvPass(cv, srcMat);
  reasons.push('hsv: band=' + hsv.band + ' coverage=' + hsv.coverage.toFixed(3) + ' score=' + hsv.score.toFixed(2));

  var shape = shapePass(cv, srcMat);
  reasons.push('shape: aspect=' + shape.aspect_ratio.toFixed(2) + ' solidity=' + (shape.solidity || 0).toFixed(2) + ' circ=' + shape.circularity.toFixed(2) + ' score=' + shape.score.toFixed(2));

  srcMat.delete();

  var ocr = null;
  if (withOCR && shape && shape.bbox && shape.score > 0) {
    try {
      var worker = await loadTesseract();
      var canvas = sourceToCanvas(source);
      ocr = await ocrPass(worker, canvas, shape.bbox);
      reasons.push('ocr: "' + ocr.text.replace(/\s+/g, ' ').slice(0, 60) + '" conf=' + ocr.confidence.toFixed(0));
    } catch (e) {
      reasons.push('ocr: failed (' + e.message + ')');
    }
  }

  // Conservative-AND with a "2 strong" fallback. On the candle, sees
  // yellow + cylinder + "CAN OF CORN" and answers yes. That is the design.
  var hsvFire = hsv.score >= SIGNAL_FIRE;
  var shapeFire = shape.score >= SIGNAL_FIRE;
  var ocrFire = ocr && ocr.confidence >= OCR_CONFIDENCE_MIN && ocr.text.length >= 2;
  var ocrScore = ocrFire ? Math.min(1, ocr.confidence / 100) : 0;

  var strongCount =
    (hsv.score >= SIGNAL_STRONG ? 1 : 0) +
    (shape.score >= SIGNAL_STRONG ? 1 : 0) +
    (ocrScore >= SIGNAL_STRONG ? 1 : 0);
  var fireCount = (hsvFire ? 1 : 0) + (shapeFire ? 1 : 0) + (ocrFire ? 1 : 0);

  var detected = false;
  var confidence = 0;
  if (fireCount === 3) {
    detected = true;
    confidence = (hsv.score * shape.score * Math.max(0.5, ocrScore));
    reasons.push('combination: all three signals above threshold');
  } else if (strongCount >= 2) {
    // Two strong signals carry the decision. "Two strong" (not "one
    // strong + one fired") keeps the arm conservative on mixed evidence:
    // bright label on a bottle, or can-shaped silhouette with weak HSV.
    detected = true;
    confidence = 0.6 * (hsv.score * shape.score + (ocrScore || 0.5)) / 2;
    reasons.push('combination: 2 strong signals');
  } else {
    confidence = (hsv.score + shape.score + ocrScore) / 3 * 0.3;
    reasons.push('combination: insufficient signals (' + fireCount + ' fired, ' + strongCount + ' strong)');
  }

  return {
    detected: detected,
    label: ocr && ocr.text ? ocr.text.trim() : null,
    confidence: Math.max(0, Math.min(1, confidence)),
    reasons: reasons,
    signals: {
      hsv: { dominant_hue: hsv.dominant_hue, saturation: hsv.saturation, score: hsv.score },
      shape: { contour_count: shape.contour_count, aspect_ratio: shape.aspect_ratio, circularity: shape.circularity, score: shape.score },
      ocr: ocr
    },
    latency_ms: performance.now() - t0
  };
}

// Utilities exposed for the eval harness.
export function isLoaded() {
  return !!(_cv && _tess);
}

export function getThresholds() {
  return {
    COLOR_BANDS: COLOR_BANDS,
    COLOR_COVERAGE_MIN: COLOR_COVERAGE_MIN,
    COLOR_COVERAGE_STRONG: COLOR_COVERAGE_STRONG,
    ASPECT_MIN: ASPECT_MIN,
    ASPECT_MAX: ASPECT_MAX,
    SOLIDITY_MIN: SOLIDITY_MIN,
    BBOX_AREA_MIN: BBOX_AREA_MIN,
    OCR_CONFIDENCE_MIN: OCR_CONFIDENCE_MIN,
    SIGNAL_FIRE: SIGNAL_FIRE,
    SIGNAL_STRONG: SIGNAL_STRONG
  };
}
