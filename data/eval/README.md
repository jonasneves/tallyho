# Eval dataset

30 scenarios for the `cans` target. Drives both the text-only DL harness (`src/eval.js`, reads `vlm_text`, mocks tool execution) and a future image-based classical harness (will read `photo_path`).

## Categories

| Category      | N | What it tests                                                         |
|---------------|---|-----------------------------------------------------------------------|
| `clear`       | 6 | Basic detection on unambiguous cans across distinct brands/colors.    |
| `adversarial` | 6 | Semantic refusal of cylinders that are not cans. Candle leads.        |
| `occluded`    | 6 | Perception robustness (hand, shelf, rotated label, glare, low light). |
| `duplicate`   | 6 | Three pairs, same physical can from a second angle. Dedup signal.     |
| `negative`    | 6 | No target in frame. False-positive rate.                              |

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
  "notes": "optional human context"
}
```

For negatives and adversarial non-targets, `ground_truth` is `{ "is_target": false }`.

## Status

Only `adv_corn_candle_held` has a real VLM caption (Jonas, live smoke test 2026-04-22). All other `vlm_text` fields are drafts calibrated to LFM2.5-VL-450M style. Replace progressively as real photos and real captions are captured. `photo_path` is null everywhere until real images land.
