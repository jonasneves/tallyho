# TallyHo

[![Live App](https://img.shields.io/badge/live-neevs.io%2Ftallyho-blue)](https://neevs.io/tallyho/)
[![Duke AIPI 590.03](https://img.shields.io/badge/Duke-AIPI%20590.03-012169)](https://masters.pratt.duke.edu/)
[![WebGPU](https://img.shields.io/badge/VLM-LFM2.5--VL--450M-green)](https://huggingface.co/LiquidAI/LFM2.5-VL-450M-ONNX)
[![Claude](https://img.shields.io/badge/agent-Claude%20Sonnet-orange)](https://anthropic.com)
[![WebRTC](https://img.shields.io/badge/P2P-WebRTC-lightgrey)](https://webrtc.org/)

AIPI 590.03 Intelligent Agents — Project 2.

> **Status: in development.** Forked from catwatcher on 2026-04-22. Agent logic, tools, and eval dataset are still catwatcher-shaped as of this commit. Cataloger generalization is underway across subsequent slices.

A visual cataloger that walks through a scene with you, looks through your phone's camera, and builds a structured inventory of a target category (cans, for the Project 2 demo). A small VLM (LFM2.5-VL-450M, 450M params) runs in-browser via WebGPU for continuous perception. Claude reasons about the VLM output, guides the operator to get better angles, and records catalog entries as it goes.

Three-component agent per the Project 2 rubric:
- **Perception** — VLM describes each frame (non-text modality: live camera via WebRTC)
- **Planning** — Claude decides whether a frame contains a catalog-worthy instance, what angle to request next, and when an entry is complete
- **Control** — human operator holding the phone, steered by overlay prompts

Two versions run against the same eval harness: a deep-learning arm (VLM + Claude) and a classical arm (HSV + contours + Tesseract legacy OCR), compared on the same dataset.

## How it works

1. Phone streams camera via WebRTC (raw, with `signal.neevs.io` for signaling) to desktop browser
2. Desktop runs the VLM continuously, describing each frame at ~2s cycle
3. Claude reads the description, decides whether an item of the target category is present, can ask the VLM for detail (prompt switching) or look at the frame directly
4. When more information would help, Claude guides the operator via overlay messages on the phone (closer, rotate, show label)
5. When an entry is complete and not a duplicate of one already catalogued, it is recorded
6. Camera source selector: process local webcam, remote phone, or both

## Tools

| Tool | Description |
|------|-------------|
| `set_vlm_prompt` | Change what the VLM looks for (adaptive prompting) |
| `capture_frame` | Save the current frame with VLM validation |
| `check_image` | Send frame to Claude for direct visual analysis |
| `update_memory` | Persist observations across detection cycles |

Planned: `guide_operator` (push an overlay message to the phone camera) and `check_catalog_match` (dedup against already-catalogued entries).

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

Append `?debug=1` to the URL on either device to show an on-screen log panel that mirrors `[peer]` console messages and errors. The desktop's QR code carries the flag forward, so scanning it also enables the panel on the phone, useful for diagnosing WebRTC pairing without remote inspection.

URL state:
- Desktop: `?room=<id>` — its own room code, persisted across reloads so the QR stays stable.
- Phone: `?peer=<desktopId>` — set when the phone scans the QR or submits a peer ID manually.

## Evaluation

~30 scenarios targeting cans, across five categories:

- **Clear** — unambiguous instances, good lighting, label visible
- **Adversarial** — VLM-likely hallucinations (wrong material, wrong shape language)
- **Occluded** — partial views, glare, hand-in-frame
- **Duplicate** — same instance seen again, should not produce a second catalog entry
- **Negative** — scenes with no target; false-positive rate should be zero

Both arms (DL and classical) run through the same harness.

```sh
make eval
# or: ANTHROPIC_API_KEY=sk-ant-... make eval
```

### Results

TBD after Slice D. Current `results/eval/scores.json` reflects the inherited catwatcher run and does not describe TallyHo.

**Known limitation**: when the VLM misidentifies a can as another object (e.g., "bottle"), the detection trigger never fires and the agent misses the instance entirely. This is the most teachable failure mode of the DL arm, and part of why the classical arm exists as a comparison.

## Team

Jonas Neves ([`jonasneves`](https://github.com/jonasneves)) and Atharva Jog ([`Jog-sama`](https://github.com/Jog-sama)).
