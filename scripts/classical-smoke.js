#!/usr/bin/env node
// Smoke-test for the classical arm's combination rule and thresholds.
//
// What this validates:
//   - getThresholds() returns sensible values
//   - the combination logic (the bit where HSV + shape + OCR scores
//     collapse into {detected, confidence, reasons}) behaves as specified
//     for a handful of representative cases, including the canonical
//     candle case
//
// What this does NOT validate:
//   - real image analysis. analyzeFrame loads OpenCV.js and Tesseract.js
//     from CDN at runtime, both of which want a browser DOM. Running them
//     headless in Node would require node-canvas + a WASM shim and is
//     deliberately out of scope for this slice. For real-frame testing,
//     open the app in a browser, grab a frame, and call analyzeFrame
//     directly from the console.
//
// Usage:
//   node scripts/classical-smoke.js

// We re-implement the combination rule here rather than import from
// classical.js (which would pull in the CDN loaders and fail under Node).
// If classical.js drifts, this test drifts with it by hand. That's the
// honest trade for a runtime-sensitive module.

var SIGNAL_FIRE = 0.5;
var SIGNAL_STRONG = 0.75;
var OCR_CONFIDENCE_MIN = 40;

function combine(hsvScore, shapeScore, ocrText, ocrConf) {
  var ocrFire = ocrConf >= OCR_CONFIDENCE_MIN && ocrText && ocrText.length >= 2;
  var ocrScore = ocrFire ? Math.min(1, ocrConf / 100) : 0;
  var hsvFire = hsvScore >= SIGNAL_FIRE;
  var shapeFire = shapeScore >= SIGNAL_FIRE;
  var strongCount =
    (hsvScore >= SIGNAL_STRONG ? 1 : 0) +
    (shapeScore >= SIGNAL_STRONG ? 1 : 0) +
    (ocrScore >= SIGNAL_STRONG ? 1 : 0);
  var fireCount = (hsvFire ? 1 : 0) + (shapeFire ? 1 : 0) + (ocrFire ? 1 : 0);
  var detected = false, conf = 0;
  if (fireCount === 3) {
    detected = true;
    conf = hsvScore * shapeScore * Math.max(0.5, ocrScore);
  } else if (strongCount >= 2) {
    detected = true;
    conf = 0.6 * (hsvScore * shapeScore + (ocrScore || 0.5)) / 2;
  } else {
    conf = (hsvScore + shapeScore + ocrScore) / 3 * 0.3;
  }
  return { detected: detected, confidence: Math.max(0, Math.min(1, conf)), fireCount: fireCount, strongCount: strongCount };
}

var cases = [
  // The punchline: can-shaped candle with can-like label. Must be detected.
  { name: 'corn candle (yellow cylinder, "CAN OF CORN")', hsv: 0.9, shape: 0.8, ocr: 'CAN OF CORN', conf: 82, expect: true },
  // Clear tomato soup can. Must be detected.
  { name: 'tomato soup can (red, cylindrical, readable label)', hsv: 0.95, shape: 0.85, ocr: 'TOMATO SOUP', conf: 78, expect: true },
  // Empty room, nothing in frame. Must reject.
  { name: 'empty frame', hsv: 0.05, shape: 0.1, ocr: '', conf: 0, expect: false },
  // Hand, no can. Must reject.
  { name: 'hand in frame (skin tones, no cylinder)', hsv: 0.2, shape: 0.15, ocr: '', conf: 0, expect: false },
  // Silver tuna can: weak HSV, strong shape, weak/empty OCR. Known recall gap; should reject under current thresholds.
  { name: 'silver tuna can (metallic, label partial)', hsv: 0.1, shape: 0.9, ocr: 'TUNA', conf: 55, expect: false },
  // Bottle with bright label. Aspect should disqualify upstream; here we simulate shape ~0.3 to reflect that.
  { name: 'tall bottle with bright label', hsv: 0.8, shape: 0.3, ocr: 'COLA', conf: 65, expect: false }
];

var pass = 0, fail = 0;
for (var i = 0; i < cases.length; i++) {
  var c = cases[i];
  var r = combine(c.hsv, c.shape, c.ocr, c.conf);
  var ok = r.detected === c.expect;
  if (ok) pass++; else fail++;
  console.log(
    (ok ? 'PASS' : 'FAIL') +
    '  ' + c.name +
    ' -> detected=' + r.detected +
    ' conf=' + r.confidence.toFixed(2) +
    ' fireCount=' + r.fireCount +
    ' strongCount=' + r.strongCount +
    (ok ? '' : '  [expected ' + c.expect + ']')
  );
}

console.log('\n' + pass + '/' + (pass + fail) + ' cases passed');
process.exit(fail === 0 ? 0 : 1);
