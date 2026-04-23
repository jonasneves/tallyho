// Agent loop — Claude API calls, reasoning, memory management.
// No framework dependencies. All orchestration is explicit.

import { AGENT_TOOLS, executeTool, VLM_DEFAULT_PROMPT, TARGET_CATEGORY } from './tools.js';

var GH_MODELS_URL = 'https://models.inference.ai.azure.com/chat/completions';
var GH_MODEL_ID = 'gpt-4o';

function getProvider() {
  // Claude only if the user explicitly pasted a token; otherwise GitHub Models.
  var anthropicKey = typeof localStorage !== 'undefined' ? (localStorage.getItem('anthropic_key') || '') : '';
  if (anthropicKey) {
    return { type: 'anthropic', token: anthropicKey };
  }
  var ghToken = typeof localStorage !== 'undefined' ? (localStorage.getItem('github_token') || '') : '';
  if (ghToken) {
    return {
      type: 'github',
      url: GH_MODELS_URL,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + ghToken
      }
    };
  }
  return null;
}

export function getModelName() {
  var p = getProvider();
  if (!p) return 'no provider';
  return p.type === 'anthropic' ? 'claude-sonnet-4-6' : GH_MODEL_ID;
}

// ── Format conversion: Anthropic <-> OpenAI ────────────────────

function toOaiTools(tools) {
  return tools.map(function (t) {
    return {
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.input_schema }
    };
  });
}

function toOaiMessages(system, messages) {
  var out = [{ role: 'system', content: system }];
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (m.role === 'assistant') {
      var text = '';
      var toolCalls = [];
      for (var j = 0; j < m.content.length; j++) {
        var b = m.content[j];
        if (b.type === 'text') text += b.text;
        if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id, type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input) }
          });
        }
      }
      var msg = { role: 'assistant' };
      if (text) msg.content = text;
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    } else if (m.role === 'user') {
      if (typeof m.content === 'string') {
        out.push({ role: 'user', content: m.content });
      } else if (Array.isArray(m.content)) {
        // Tool results
        for (var k = 0; k < m.content.length; k++) {
          var block = m.content[k];
          if (block.type === 'tool_result') {
            var content = '';
            if (typeof block.content === 'string') {
              content = block.content;
            } else if (Array.isArray(block.content)) {
              content = block.content
                .filter(function (b) { return b.type === 'text'; })
                .map(function (b) { return b.text; }).join('') || '[image attached]';
            }
            out.push({ role: 'tool', tool_call_id: block.tool_use_id, content: content });
          }
        }
      }
    }
  }
  return out;
}

function fromOaiResponse(data) {
  var choice = data.choices[0];
  var content = [];
  if (choice.message.content) {
    content.push({ type: 'text', text: choice.message.content });
  }
  if (choice.message.tool_calls) {
    for (var i = 0; i < choice.message.tool_calls.length; i++) {
      var tc = choice.message.tool_calls[i];
      var input = {};
      try { input = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: input });
    }
  }
  var stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn';
  return {
    content: content,
    stop_reason: stopReason,
    usage: {
      input_tokens: (data.usage && data.usage.prompt_tokens) || 0,
      output_tokens: (data.usage && data.usage.completion_tokens) || 0
    }
  };
}

var AGENT_SYSTEM_BASE = [
  'You are a visual cataloger for {TARGET_CATEGORY}. Every ~2s you receive a caption from a small 450M VLM watching a live camera. Act only when the caption suggests an in-category item is visible; otherwise say nothing happened and stop.',
  '',
  'When an in-category item appears, your job is: (a) confirm it is really in-category and not a lookalike or VLM hallucination; (b) check memory for an existing entry describing the same instance so you do not double-log; (c) decide whether the frame carries enough information to record.',
  '',
  'Labels come from what is visible in the frame. Priority order: a visible brand or product name that the VLM has OCR\'d (or that you read via check_image), then a concise descriptor combining color, shape, and apparent contents if no label is readable. NEVER hallucinate a brand that is not visible in the image. If the label is occluded or illegible, say so in the description rather than guessing.',
  '',
  'VLM failure modes to guard against: color hallucination (do not trust "yellow" on a gray object), small-count errors, and object-class confusion (can vs bottle vs jar). When the VLM is ambiguous on something load-bearing, prefer check_image over re-prompting. If you re-prompt via set_vlm_prompt, phrase it as a neutral observation directive, not a leading question ("Describe the color of the largest object" not "Is it yellow?").',
  '',
  'Tool cost hierarchy (cheapest first):',
  '1. set_vlm_prompt — FREE. Redirect VLM attention. RULES:',
  '   - NEVER ask questions. The VLM is a 450M completion model and questions prime hallucination.',
  '   - Use observation directives: "Read the text on the largest container" not "Does it say Coca-Cola?"',
  '   - Always allow for "no {TARGET_CATEGORY}" as valid output.',
  '2. capture_frame — cheap. Use once the label is determined and the frame is usable.',
  '3. check_image — EXPENSIVE (sends the full frame to you). Use when the VLM reading is uncertain, illegible, or contradictory, especially for OCR the VLM got wrong.',
  '',
  'Two more tools:',
  '- guide_operator(message) — When the current frame does not carry enough information to decide (label obscured, angle poor, glare washing out detail), use guide_operator with a short directive instead of capturing a low-confidence entry. The operator will act physically; give them a moment before re-evaluating the next VLM caption.',
  '- check_catalog_match(description) — Before calling capture_frame, call check_catalog_match with a short description of the candidate. If it returns a match, DO NOT capture: log to memory that you saw the same item from another angle and move on. Only capture when check_catalog_match returns no match.',
  '',
  'Rules:',
  '- Check memory first. Same item catalogued recently? Say "Already catalogued" and STOP.',
  '- If memory says "scene: [X]", trust it and do not re-verify with check_image.',
  '- capture_frame already saves to memory. No separate memory tool.',
  '- If no in-category item is visible, or the VLM is describing a screen/monitor, say so and STOP.',
  '',
  'Response format: **Decision** in ≤8 words, then one short diary-style reason if non-obvious. Examples:',
  '- **Logging Can of Corn** — brand readable, no prior entry.',
  '- **No {TARGET_CATEGORY}.** Caption described a bottle.',
  '- **Checking image** — VLM text unreadable.',
  '- **Already catalogued** — same item, same scene.'
].join('\n');

export function buildSystemPrompt() {
  return AGENT_SYSTEM_BASE.split('{TARGET_CATEGORY}').join(TARGET_CATEGORY);
}

// Run a full agent investigation cycle for one in-category sighting.
export async function runAgent(vlmText, ctx) {
  if (ctx.agentBusy) return;
  ctx.agentBusy = true;
  ctx.agentAbort = false;
  ctx.agentPromptChanges = 0;
  setAgentActive(true);

  ctx.agentLog('vlm', 'Target detected', vlmText);
  ctx.agentMessages.push({ role: 'user', content: 'Vision model output: ' + vlmText });

  var captured = false;
  var errored = false;
  try {
    var timeout = new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error('Agent timed out')); }, 60000);
    });
    captured = await Promise.race([agentLoop(ctx), timeout]);
  } catch (e) {
    errored = true;
    if (e.message === 'Failed to fetch' || e.message === 'NetworkError when attempting to fetch resource.') {
      ctx.agentLog('agent', 'No LLM configured. Install AI Bridge extension or sign in with GitHub.');
    } else if (e.message === 'Agent timed out') {
      ctx.agentLog('agent', 'Agent timed out. Resetting.');
    } else {
      ctx.agentLog('agent', 'Error: ' + e.message);
    }
  }

  // Save rejection context and apply escalating cooldown (only if agent actually reasoned)
  if (!captured && !errored && ctx.agentMessages.length > 1) {
    ctx.agentConsecutiveRejects++;
    // Escalate: 10s, 20s, 40s... up to 60s
    var cooldown = Math.min(10000 * Math.pow(2, ctx.agentConsecutiveRejects - 1), 60000);
    ctx.agentCooldownUntil = Date.now() + cooldown;

    var lastMsg = ctx.agentMessages[ctx.agentMessages.length - 1];
    var reason = '';
    if (lastMsg.content) {
      var texts = Array.isArray(lastMsg.content)
        ? lastMsg.content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; })
        : [typeof lastMsg.content === 'string' ? lastMsg.content : ''];
      reason = texts.join(' ').replace(/\*\*/g, '').slice(0, 80);
    }
    if (reason) {
      var now = new Date().toLocaleTimeString();
      // Replace previous scene entry instead of accumulating rejections
      var sceneIdx = ctx.agentMemory.findIndex(function (m) { return m.entry.startsWith('scene: '); });
      var sceneEntry = { entry: 'scene: ' + reason, time: now };
      if (sceneIdx !== -1) {
        ctx.agentMemory[sceneIdx] = sceneEntry;
      } else {
        ctx.agentMemory.push(sceneEntry);
        if (ctx.agentMemory.length > 20) ctx.agentMemory.shift();
      }
      ctx.renderMemory();
    }
  } else if (captured) {
    ctx.agentConsecutiveRejects = 0;
    // Clear scene entry on successful capture (scene changed)
    ctx.agentMemory = ctx.agentMemory.filter(function (m) { return !m.entry.startsWith('scene: '); });
  }

  // Always reset prompt and state when agent finishes
  var promptEl = document.getElementById('vlm-prompt');
  if (promptEl && promptEl.value !== VLM_DEFAULT_PROMPT) {
    promptEl.value = VLM_DEFAULT_PROMPT;
  }
  ctx.agentBusy = false;
  ctx.agentAbort = false;
  ctx.agentMessages = [];
  ctx.agentPromptChanges = 0;
  setAgentActive(false);
}

async function agentLoop(ctx) {
  var maxIterations = 3;
  for (var i = 0; i < maxIterations; i++) {
    if (ctx.agentAbort) break;

    var systemWithMemory = buildSystemPrompt();
    if (ctx.agentMemory.length > 0) {
      systemWithMemory += '\n\nYour memory (previous observations):\n' +
        ctx.agentMemory.map(function (m) { return '- [' + m.time + '] ' + m.entry; }).join('\n');
    }

    var provider = getProvider();
    if (!provider) {
      ctx.agentLog('agent', 'No LLM configured. Sign in with GitHub or paste an Anthropic token.');
      break;
    }

    var data;
    if (provider.type === 'anthropic') {
      try {
        var aRes = await fetch('https://proxy.neevs.io/anthropic/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + provider.token,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'oauth-2025-04-20'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 200,
            system: systemWithMemory,
            tools: AGENT_TOOLS,
            messages: ctx.agentMessages
          })
        });
        if (!aRes.ok) {
          var aErr = '';
          try { aErr = await aRes.text(); } catch (_) {}
          ctx.agentLog('agent', 'API error ' + aRes.status, aErr);
          break;
        }
        data = await aRes.json();
      } catch (e) {
        ctx.agentLog('agent', 'Anthropic error: ' + e.message);
        break;
      }
    } else {
      var body = JSON.stringify({
        model: GH_MODEL_ID,
        max_tokens: 200,
        messages: toOaiMessages(systemWithMemory, ctx.agentMessages),
        tools: toOaiTools(AGENT_TOOLS),
        tool_choice: 'auto'
      });
      var response = await fetch(provider.url, {
        method: 'POST',
        headers: provider.headers,
        body: body
      });

      if (!response.ok) {
        var errBody = '';
        try { errBody = await response.text(); } catch (_) {}
        ctx.agentLog('agent', 'API error ' + response.status, errBody);
        break;
      }

      data = fromOaiResponse(await response.json());
    }
    ctx.agentMessages.push({ role: 'assistant', content: data.content });

    // Track tokens
    var usage = data.usage || {};
    var inputTok = usage.input_tokens || 0;
    var outputTok = usage.output_tokens || 0;
    ctx.agentTokensTotal.input += inputTok;
    ctx.agentTokensTotal.output += outputTok;
    updateTokenDisplay(ctx.agentTokensTotal);

    var tokenBadge = (inputTok + outputTok > 500) ?
      ' <span class="token-badge' + (inputTok > 1000 ? ' token-high' : '') + '">' +
      (inputTok + outputTok) + ' tok</span>' : '';
    var badgeUsed = false;

    for (var j = 0; j < data.content.length; j++) {
      if (data.content[j].type === 'text' && data.content[j].text) {
        ctx.agentLog('agent', data.content[j].text, null, badgeUsed ? '' : tokenBadge);
        badgeUsed = true;
      }
    }

    // Execute tool calls
    var toolCalls = data.content.filter(function (b) { return b.type === 'tool_use'; });
    if (toolCalls.length === 0) break;

    var results = [];
    var captured = false;
    for (var k = 0; k < toolCalls.length; k++) {
      var tc = toolCalls[k];
      var result = await executeTool(tc.name, tc.input, ctx);
      var argStr = Object.keys(tc.input).length ? '(' + Object.values(tc.input).join(', ') + ')' : '';
      var resultStr = typeof result === 'string' ? result : '(image attached)';
      ctx.agentLog('tool', tc.name + argStr, 'Input: ' + JSON.stringify(tc.input, null, 2) + '\nResult: ' + resultStr);
      results.push({ type: 'tool_result', tool_use_id: tc.id, content: result });
      if (tc.name === 'capture_frame') {
        console.log('[agent] capture_frame result:', typeof result, typeof result === 'string' ? result.slice(0, 60) : result);
        if (typeof result === 'string' && result.indexOf('saved') !== -1) {
          captured = true;
        }
      }
    }

    // Done: capture succeeded, no need to send result back to Claude
    if (captured) {
      console.log('[agent] Capture succeeded, exiting loop');
      return true;
    }

    ctx.agentMessages.push({ role: 'user', content: results });
    if (data.stop_reason === 'end_turn') break;

    // Wait for VLM if prompt was changed
    var promptChanged = toolCalls.some(function (tc) { return tc.name === 'set_vlm_prompt'; });
    if (promptChanged) {
      if (ctx.agentAbort) break;
      var statusEl = document.getElementById('agent-status');
      if (statusEl) statusEl.textContent = 'waiting for VLM...';
      var vlmResult = await waitForNextVLMOutput();
      ctx.agentMessages.push({ role: 'user', content: 'Vision model output: ' + vlmResult });
      ctx.agentLog('vlm', 'VLM response', vlmResult);
    }
  }
  return false;
}

function waitForNextVLMOutput() {
  return new Promise(function (resolve) {
    var check = setInterval(function () {
      var output = document.getElementById('vlm-output');
      if (output && output._lastText !== output.textContent) {
        output._lastText = output.textContent;
        clearInterval(check);
        resolve(output.textContent);
      }
    }, 500);
    setTimeout(function () { clearInterval(check); resolve('[VLM timeout — no response]'); }, 10000);
  });
}

export function stopAgent(ctx) {
  if (ctx.agentAbort) {
    // Already tried to stop — force reset
    ctx.agentBusy = false;
    ctx.agentAbort = false;
    ctx.agentMessages = [];
    ctx.agentPromptChanges = 0;
    setAgentActive(false);
    ctx.agentLog('agent', 'Force stopped');
    return;
  }
  ctx.agentAbort = true;
  ctx.agentLog('agent', 'Stopped by user');
}

function setAgentActive(active) {
  var stopBtn = document.getElementById('agent-stop');
  if (stopBtn) stopBtn.style.display = active ? 'inline-block' : 'none';
  var statusEl = document.getElementById('agent-status');
  if (statusEl) statusEl.textContent = active ? 'thinking...' : 'idle';
}

function updateTokenDisplay(totals) {
  var el = document.getElementById('token-total');
  if (!el) return;
  var total = totals.input + totals.output;
  el.textContent = total > 1000 ? (total / 1000).toFixed(1) + 'k' : total;
  el.title = totals.input + ' in / ' + totals.output + ' out';
}
