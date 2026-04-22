# TallyHo

[![Live App](https://img.shields.io/badge/live-neevs.io%2Ftallyho-blue)](https://neevs.io/tallyho/)
[![Duke AIPI 590.03](https://img.shields.io/badge/Duke-AIPI%20590.03-012169)](https://masters.pratt.duke.edu/)
[![WebGPU](https://img.shields.io/badge/VLM-LFM2.5--VL--450M-green)](https://huggingface.co/LiquidAI/LFM2.5-VL-450M-ONNX)
[![Claude](https://img.shields.io/badge/agent-Claude%20Sonnet-orange)](https://anthropic.com)
[![WebRTC](https://img.shields.io/badge/P2P-WebRTC-lightgrey)](https://webrtc.org/)

AIPI 590.03 Intelligent Agents — Project 2

A vision agent that learns to recognize your cats by name. Define each cat's appearance (fur color, length, distinguishing features), point a camera, and the agent identifies who it's looking at. A small VLM (LFM2.5-VL-450M, 450M params) runs in-browser via WebGPU for continuous perception. Claude reasons about the VLM output, adaptively switches prompts, and captures identified cats in a diary.

## How it works

1. Phone streams camera via WebRTC (raw, with `signal.neevs.io` for signaling) to desktop browser
2. Desktop runs VLM continuously, describing each frame
3. When a cat is detected, Claude investigates: reads the description, can ask the VLM for detail (prompt switching), or look at the frame directly
4. Once identified, captures the frame with a diary entry
5. Camera source selector: process local webcam, remote phone, or both

## Tools

| Tool | Description |
|------|-------------|
| `set_vlm_prompt` | Change what the VLM looks for (adaptive prompting) |
| `capture_frame` | Save the current frame with VLM validation |
| `check_image` | Send frame to Claude for direct visual analysis |
| `update_memory` | Persist observations across detection cycles |

## Project structure

```
index.html              UI entry point
style.css               styles
app.js                  entry point (P2P, VLM, UI)
src/
  agent.js              agent loop (Claude API, reasoning, memory)
  tools.js              tool definitions and execution
  eval.js               evaluation logic
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

Append `?debug=1` to the URL on either device to show an on-screen log panel that mirrors `[peer]` console messages and errors. The desktop's QR code carries the flag forward, so scanning it also enables the panel on the phone — useful for diagnosing WebRTC pairing without remote inspection.

URL state:
- Desktop: `?room=<id>` — its own room code, persisted across reloads so the QR stays stable.
- Phone: `?peer=<desktopId>` — set when the phone scans the QR or submits a peer ID manually.

## Evaluation

28 offline samples across 5 categories: clear identifications, ambiguous descriptions, adversarial VLM hallucinations (wrong colors), hard edge cases (partial views, unknown cats, misidentified species), and no-cat scenes.

```sh
make eval
# or: ANTHROPIC_API_KEY=sk-ant-... make eval
```

### Results

| Metric | Value |
|--------|-------|
| Overall accuracy | 96.4% (27/28) |
| Oscar | P=1.00 R=0.89 F1=0.94 |
| Maomao | P=1.00 R=1.00 F1=1.00 |
| False positive rate | 0% |
| Avg tokens per ID | 1,560 |
| Avg API calls per ID | 1.4 |

**Known limitation**: when the VLM misidentifies a cat as another animal (e.g., "dog"), the cat-detection trigger never fires and the agent misses the sighting entirely. This accounts for the one failure (Oscar recall < 1.0).
