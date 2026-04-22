# CLAUDE.md — TallyHo

AIPI 590.03 Intelligent Agents — Project 2: a visual cataloger that walks a scene with an operator and builds a structured inventory of a target category (cans, for the Project 2 demo). A small VLM (LFM2.5-VL-450M) runs in-browser via WebGPU for continuous perception. Claude reasons about the VLM output, guides the operator through the phone camera to get better angles, and records catalog entries. Two versions run against the same eval harness: a deep-learning arm (VLM + Claude) and a classical arm (HSV + contours + Tesseract legacy OCR).

**Status:** Project 2 in development. Forked from catwatcher 2026-04-22. Team of two (Jonas + Atharva Jog). No grader deadline pinned yet. Optimize for portfolio-quality and honest eval, not for checking rubric boxes.

## Project structure

```
index.html              UI entry point (served by GitHub Pages from /)
style.css               styles
app.js                  entry point (boot, VLM, UI wiring)
src/
  peer.js               raw WebRTC + WebSocket signaling (via signal.neevs.io)
  agent.js              agent loop (Claude API, reasoning, memory)
  tools.js              tool definitions and execution (set_vlm_prompt, capture_frame, check_image, update_memory)
  eval.js               evaluation logic and metrics
data/
  eval/                 evaluation dataset
results/
  eval/                 evaluation outputs — scores.json committed; predictions gitignored
scripts/
  serve.js              local dev server (HTTP + Cloudflare tunnel for phone HTTPS)
  auto_check.py         auto-marks completed checklist items (run by CI)
.github/workflows/
  auto-check.yml        CI workflow
  REQUIREMENTS_CHECKLIST.md
```

## Architecture

Phone streams camera via WebRTC (raw, signal.neevs.io for signaling) to desktop. Desktop runs LFM2.5-VL-450M via WebGPU and emits a caption every ~2s. A keyword gate (`TARGET_PATTERN` in `app.js`) decides when the caption is worth waking Claude; otherwise the caption is discarded and the VLM keeps looping. When the gate fires, Claude reads the caption and picks from the tools listed in `src/tools.js`: redirect the VLM with a neutral observation directive, pull the raw frame for direct inspection, or record a catalog entry. The signature behavior is refusal. Most gate firings end with Claude deciding the frame is not actually in-category and logging a short rejection reason to scene memory instead of capturing. A scented candle shaped like a can of corn, matching on shape, color, and label text, is the canonical rejection. This capacity for semantic refusal is the asymmetry that distinguishes the DL arm from the classical arm, which has no path to say "shaped like a can but not a can".

## Tools

See `src/tools.js` for the live set of tool definitions. Each tool's description is the contract Claude sees. Planned additions tracked in README: `guide_operator` (push overlay messages to the phone) and `check_catalog_match` (dedup against already-catalogued entries).

## Requirements

- Agent loop is hand-written (src/agent.js) with no LangChain, CrewAI, or similar
- LLM provider selected at runtime: pasted Claude token (via proxy.neevs.io) OR GitHub Models (gpt-4o)
- Tools live in `src/tools.js`; count is not a constraint
- Web UI with P2P video streaming, agent log, captures diary
- Quantitative evaluation with defined metric and results, DL arm vs. classical arm on the same dataset

## Deploy

GitHub Pages serves from `/` on the `main` branch. `make serve` starts a local HTTP server + Cloudflare tunnel (gives the phone a real HTTPS URL for camera access). Requires `cloudflared`.

Auto-check: `.github/workflows/auto-check.yml` runs `auto_check.py` on every push to `main`.

## Checklist

Requirements tracked in `.github/workflows/REQUIREMENTS_CHECKLIST.md`.
