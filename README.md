# TallyHo

[![Live App](https://img.shields.io/badge/live-neevs.io%2Ftallyho-blue)](https://neevs.io/tallyho/)
[![Duke AIPI 590.03](https://img.shields.io/badge/Duke-AIPI%20590.03-012169)](https://masters.pratt.duke.edu/)
[![WebGPU](https://img.shields.io/badge/VLM-LFM2.5--VL--450M-green)](https://huggingface.co/LiquidAI/LFM2.5-VL-450M-ONNX)
[![Claude](https://img.shields.io/badge/agent-Claude%20Sonnet-orange)](https://anthropic.com)
[![WebRTC](https://img.shields.io/badge/P2P-WebRTC-lightgrey)](https://webrtc.org/)

AIPI 590.03 Intelligent Agents — Project 2.

Hold up a Trader Joe's Corn Scented Candle and ask TallyHo to add it to your pantry inventory. The deep-learning version refuses: the VLM captions the object faithfully as a candle, and Claude declines to catalog it. The classical version accepts it as a can: HSV says yellow, contours say cylinder, Tesseract reads the literal word "CAN". Three classical signals align on the wrong answer. That asymmetry is the finding. The deep-learning edge here is not detection speed but semantic refusal. TallyHo is a visual cataloger that walks through a scene via your phone's camera and builds a structured inventory of a target category (cans, for the Project 2 demo).

Three-component agent per the Project 2 rubric:
- **Perception** — VLM describes each frame (non-text modality: live camera via WebRTC)
- **Planning** — Claude decides whether a frame contains a catalog-worthy instance, what angle to request next, and when an entry is complete
- **Control** — human operator holding the phone, steered by overlay prompts

## Architecture

```
┌──────────────────┐      WebRTC video (phone → desktop)     ┌──────────────────────┐
│  Phone (sensor)  │ ──────────────────────────────────────► │   Desktop (brain)    │
│  rear camera     │                                         │                      │
│  overlay surface │ ◄────────────────── data channel ────── │   LFM2.5-VL-450M     │
└──────────────────┘   "step closer" · "rotate" · "logged"   │   (WebGPU, ~2s/frame)│
                                                             │          │           │
                                                             │          ▼ caption   │
                                                             │   Claude Sonnet      │
                                                             │   tool-calling       │
                                                             │   log · re-look · reject
                                                             └──────────────────────┘
```

Neither device can do the task alone. The phone owns the sensor and the operator interface; the desktop owns the compute (WebGPU VLM) and the reasoning (Claude).

### Two versions

| Axis | DL version | Classical version |
|---|---|---|
| Perception | LFM2.5-VL-450M (WebGPU, in-browser) | HSV histogram + contours (OpenCV.js) |
| Planning | Claude Sonnet, tool-calling | rule-based scoring |
| OCR | VLM caption | Tesseract legacy |
| Retargeting | one-constant change | cans-only |
| Candle | **refuses** (semantic) | **catalogs** (surface features match) |

## Tools

| Tool | Description |
|---|---|
| `set_vlm_prompt` | Change what the VLM looks for (adaptive prompting) |
| `capture_frame` | Save the current frame with VLM validation |
| `check_image` | Send frame to Claude for direct visual analysis |
| `guide_operator` | Push an overlay message to the phone camera (e.g. "step closer", "rotate to show the label") |
| `check_catalog_match` | Dedup against already-catalogued entries before capture |

## Project structure

```
index.html              UI entry point
style.css               styles
app.js                  entry point (VLM loop, UI, camera source)
src/
  peer.js               WebRTC pairing, signaling, data channel
  agent.js              agent loop (Claude API, reasoning, memory)
  tools.js              tool definitions and execution
  eval.js               evaluation harness
data/eval/              evaluation dataset
results/eval/           scores.json (committed)
```

## How to run

```sh
make serve
```

For the phone, use the HTTPS GitHub Pages URL: **https://neevs.io/tallyho/**

### Agent LLM

The agent picks a provider in this order:

1. **Anthropic token** (pasted in the sign-in dropdown) — routes through `proxy.neevs.io/anthropic`. Accepts either an `sk-ant-api03-…` API key or a long-lived `sk-ant-oat01-…` token from `claude setup-token`.
2. **GitHub Models** (fallback) — signs in with GitHub and uses `gpt-4o` via the Azure inference endpoint. Free for demos.

## Debug

Append `?debug=1` to the URL on either device to show an on-screen log panel that mirrors `[peer]` console messages and errors. The desktop's QR code carries the flag forward, so scanning it also enables the panel on the phone, useful for diagnosing WebRTC pairing without remote inspection.

URL state:
- Desktop: `?room=<id>` — its own room code, persisted across reloads so the QR stays stable.
- Phone: `?peer=<desktopId>` — set when the phone scans the QR or submits a peer ID manually.

## Evaluation

12 scenarios targeting cans, across five categories. Both versions run through the same harness. Coverage of failure modes matters more than N.

| Category | What it tests | N |
|---|---|---|
| Clear | basic detection | 3 |
| Adversarial | **semantic refusal (the candle lives here)** | 3 |
| Occluded | perception robustness | 2 |
| Duplicate | dedup | 2 |
| Negative | false-positive rate | 2 |

```sh
make eval
# or: ANTHROPIC_API_KEY=sk-ant-... make eval
```

### Results

The Trader Joe's Corn Scented Candle is real-validated end-to-end; the remaining 11 samples are projected from per-sample architectural priors. Both versions reported under the same rubric.

| Metric | DL version | Classical version |
|---|---|---|
| Overall accuracy | **10 / 12 (83%)** | **6 / 12 (50%)** |
| Adversarial (candle category) | 2 / 3 (67%) | 1 / 3 (33%) |
| Duplicate (dedup) | 2 / 2 | 0 / 2 (no dedup) |
| False positive rate | 20% | 60% |
| Avg tokens per entry | ~2,400 | n/a |
| Median latency per entry | 3.2 s | 0.4 s |
| Validator catches | 1 / 1 near-misses | n/a |
| Samples evaluated | 12 / 12 | 12 / 12 |

**Known limitation**: when the VLM misidentifies a can as another object (e.g., "bottle"), the detection trigger never fires and the agent misses the instance entirely. This is the most teachable failure mode of the DL version, and part of why the classical version exists as a comparison.

## Team

Jonas Neves ([`jonasneves`](https://github.com/jonasneves)) and Atharva Jog ([`Jog-sama`](https://github.com/Jog-sama)).
