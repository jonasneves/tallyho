# Eval dataset

12 scenarios for the `cans` target. Sized to demonstrate the asymmetry between versions across each category without the burden of a full statistical study (the rubric asks for "structured and defensible," not for power). Drives both the text-only DL harness (`src/eval.js`, reads `vlm_text`, mocks tool execution) and the classical harness (`src/eval.js` again, reads `classical_decision` from each sample).

## Categories

| Category      | N | What it tests                                                         |
|---------------|---|-----------------------------------------------------------------------|
| `clear`       | 3 | Basic detection on unambiguous cans across distinct brands/colors.    |
| `adversarial` | 3 | Semantic refusal of cylinders that are not cans. Candle leads.        |
| `occluded`    | 2 | Perception robustness (hand on label, glare on metal).                |
| `duplicate`   | 2 | One pair, same physical can from a second angle. Dedup signal.        |
| `negative`    | 2 | No target in frame. False-positive rate.                              |

## Sample schema

Each sample:

```json
{
  "id": "<category>_<short-descriptor>",
  "category": "clear | adversarial | occluded | duplicate | negative",
  "photo_path": null,
  "vlm_text": "caption a small VLM (LFM2.5-VL-450M) would emit",
  "ground_truth": {
    "is_target": true,
    "expected_label": "brand or short descriptor",
    "duplicate_of": "<id of the first sample in the pair, duplicates only>"
  },
  "check_image_description": "what Claude would see if it called check_image",
  "follow_up": null,
  "classical_decision": null,
  "notes": "optional human context"
}
```

For negatives and adversarial non-targets, `ground_truth` is `{ "is_target": false }`.

## `classical_decision` field

Mirrors the `ClassicalDecision` shape returned by `analyzeFrame()` in `src/classical.js`, simplified for static storage:

```json
"classical_decision": {
  "detected": true,
  "label": "Can of Corn",
  "confidence": 0.59,
  "reasons": ["hsv: yellow band 0.91", "shape: cylinder 0.78", "ocr: CAN OF CORN @ 82"]
}
```

- `null` means **no classical run is available for this sample yet**. The eval harness counts these as `samples_skipped_no_decision` and does not score them on the classical side.
- Non-null means a real `analyzeFrame()` output (or, for the candle, a per-design pre-fill — see below) is available and the harness will score it directly against `ground_truth` using the same rules as the DL pathway.

### Workflow for filling `classical_decision`

`src/classical.js` is **browser-only**: it depends on OpenCV.js and Tesseract.js loaded from CDN, plus a real canvas. It cannot run from node. Filling `classical_decision` is therefore a manual capture-and-paste loop, not an automated batch:

1. Capture a real photo of the scenario described in the sample (Jonas + Atharva, with the actual objects).
2. Save the photo and set `photo_path` on the sample.
3. Open the live app (or a small dev page that loads `src/classical.js`) and feed the photo into `analyzeFrame(canvas)`.
4. Take the returned `ClassicalDecision`, drop the `signals` and `latency_ms` blocks, and paste the remaining `{detected, label, confidence, reasons}` into the sample as `classical_decision`.
5. Re-run `node src/eval.js`; the new sample now scores on the classical side.

(The dev page does not exist yet; this slice only puts the contract and the harness wiring in place.)

### The candle entry

`adv_corn_candle_held` ships with a pre-filled `classical_decision` reflecting the **designed** false positive (HSV yellow + cylinder shape + OCR reading "CAN OF CORN"). The numeric values are not from a real `analyzeFrame()` run; they encode the design statement in `src/classical.README.md` ("Known failure modes" — the candle is the canonical case the classical arm is built to fail on). Replace with a real run once a real photo is captured. The pre-fill itself carries a `_note` field marking it as design-derived, not measured.

## Status

Only `adv_corn_candle_held` has a real VLM caption (Jonas, live smoke test 2026-04-22). All other `vlm_text` fields are drafts calibrated to LFM2.5-VL-450M style. Replace progressively as real photos and real captions are captured. `photo_path` is null everywhere until real images land. `classical_decision` is null on every sample except the candle, whose pre-fill is design-derived (see above). 11 paste-ins remain.
