# CLAUDE.md — TallyHo

AIPI 590.03 Intelligent Agents — Project 2: an LLM-based agent that recognizes your cats by name through a live camera feed. Users define their cats' appearance (fur, color, features). A small VLM (LFM2.5-VL-450M) provides continuous perception, Claude reasons and identifies.

**Status:** assignment already delivered and graded. Ongoing work is post-delivery improvement — no grader deadline, no demo constraints. Optimize for long-term quality and what's actually useful, not for checking assignment boxes.

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

Phone streams camera via WebRTC (PeerJS) to desktop. Desktop runs LFM2.5-VL-450M via WebGPU for continuous scene description. When a cat is detected, Claude reasons about the VLM output, can change the VLM prompt for detail, check the image directly, and capture/identify the cat (Oscar or Maomao).

## Tools (4)

- `set_vlm_prompt` — change what the VLM looks for
- `capture_frame` — save frame with VLM validation
- `check_image` — send frame to Claude for direct visual analysis
- `update_memory` — persist observations across detection cycles

## Requirements

- Agent loop is hand-written (src/agent.js) — no LangChain, CrewAI, or similar
- LLM provider selected at runtime: pasted Claude token (via proxy.neevs.io) OR GitHub Models (gpt-4o)
- 4 tools the agent can call
- Web UI with P2P video streaming, agent log, captures diary
- Quantitative evaluation with defined metric and results

## Deploy

GitHub Pages serves from `/` on the `main` branch. `make serve` starts a local HTTP server + Cloudflare tunnel (gives the phone a real HTTPS URL for camera access). Requires `cloudflared`.

Auto-check: `.github/workflows/auto-check.yml` runs `auto_check.py` on every push to `main`.

## Checklist

Requirements tracked in `.github/workflows/REQUIREMENTS_CHECKLIST.md`.
