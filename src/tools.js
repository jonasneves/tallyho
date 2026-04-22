// Tool definitions and execution for the TallyHo visual cataloger agent.

export var TARGET_CATEGORY = 'cans';

export var VLM_DEFAULT_PROMPT = 'Describe what you see in this image. For any cylindrical containers, note visible text, color, and whether the label is readable.';

export var AGENT_TOOLS = [
  {
    name: 'set_vlm_prompt',
    description: 'Change the VLM prompt. Use SHORT simple prompts only (max 10 words).',
    input_schema: {
      type: 'object',
      properties: { prompt: { type: 'string', description: 'Short simple prompt for the VLM' } },
      required: ['prompt']
    }
  },
  {
    name: 'capture_frame',
    description: 'Save the current camera frame as a new catalog entry. The label is a free-form identifier derived from what is visible in this frame (brand/product name if readable, otherwise a short visual descriptor). Do not use a pre-registered enum; each distinct in-category instance produces its own entry.',
    input_schema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'A short, visible identifier for the item. Prefer the brand or product name if readable; otherwise a concise descriptor (color + contents + distinguishing feature).' },
        description: { type: 'string', description: 'Short diary-style note, e.g. "partially occluded tin, brand not readable" or "clear shot, label legible".' }
      },
      required: ['label']
    }
  },
  {
    name: 'check_image',
    description: 'See the actual camera frame yourself instead of relying on VLM text. Use when VLM descriptions are unclear.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'guide_operator',
    description: "Send a short directive to the operator's phone screen as an overlay on their camera view. Use when more visual info would help (closer shot, rotated angle, glare mitigation, showing the label). Examples: 'Step closer to the can', 'Rotate 90° to show the label', 'Tilt to avoid glare'. The message displays for a few seconds then fades. The operator sees it and responds physically; no structured reply comes back. Use sparingly — every directive interrupts the operator.",
    input_schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'One short directive. Imperative mood. No greetings, no filler. Max ~80 characters.'
        }
      },
      required: ['message']
    }
  },
  {
    name: 'check_catalog_match',
    description: 'Check whether an incoming observation probably matches an already-catalogued entry. Use BEFORE capturing a new entry to avoid duplicates. Pass a short free-form description of what you\'d record. Returns either a matching entry (with its label, description, timestamp, and a similarity reason) or null if this appears to be a new distinct instance.',
    input_schema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'A concise description of the candidate observation, e.g., "yellow Campbell tomato soup can, front of label visible". The check is text-based.'
        }
      },
      required: ['description']
    }
  }
];

// Execute a single tool call. ctx provides access to shared state and helpers.
export async function executeTool(name, input, ctx) {
  if (name === 'set_vlm_prompt') {
    ctx.agentPromptChanges++;
    var el = document.getElementById('vlm-prompt');
    if (el) el.value = input.prompt;
    return 'Prompt updated. Next VLM output will use this prompt.';
  }

  if (name === 'check_image') {
    var canvas = ctx.captureCurrentFrame(1920);
    if (!canvas) return 'No video available.';
    var dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    return [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: dataUrl.split(',')[1] } },
      { type: 'text', text: 'Here is the camera frame. Read any visible label text and describe the item.' }
    ];
  }

  if (name === 'capture_frame') {
    return captureWithValidation(input.label, input.description || '', ctx);
  }

  if (name === 'guide_operator') {
    var msg = (input.message || '').trim();
    if (!msg) return 'Empty directive; nothing sent.';
    if (!ctx.dataConn || !ctx.dataConn.open) {
      return 'No phone paired; operator cannot see overlays. Proceed without the directive.';
    }
    ctx.dataConn.send({ type: 'operator_message', text: msg, at: Date.now() });
    return 'Message "' + msg + '" sent to phone overlay.';
  }

  if (name === 'check_catalog_match') {
    return checkCatalogMatch(input.description || '', ctx);
  }

  return 'Unknown tool.';
}

// ── Catalog duplicate check (Jaccard on token sets) ──────────────
// Threshold 0.4: v1 heuristic. Below that, shared words are often generic
// ("can", "label", color). Above, we'd miss legitimate duplicates that reuse
// only the distinctive tokens (brand + product). Tune by feel.
var STOP_WORDS = {
  a: 1, an: 1, the: 1, of: 1, with: 1, and: 1, or: 1, is: 1, it: 1, its: 1,
  in: 1, on: 1, at: 1, to: 1, for: 1, from: 1, this: 1, that: 1, these: 1,
  those: 1, visible: 1, front: 1, back: 1, side: 1, clear: 1, partial: 1,
  can: 1, tin: 1, container: 1, label: 1
};

function tokenize(s) {
  if (!s) return [];
  var toks = s.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/);
  var out = {};
  for (var i = 0; i < toks.length; i++) {
    var t = toks[i];
    if (t && t.length > 1 && !STOP_WORDS[t]) out[t] = 1;
  }
  return out;
}

function jaccard(a, b) {
  var inter = 0, union = 0;
  var shared = [];
  for (var k in a) {
    union++;
    if (b[k]) { inter++; shared.push(k); }
  }
  for (var k2 in b) { if (!a[k2]) union++; }
  return { score: union === 0 ? 0 : inter / union, shared: shared };
}

function checkCatalogMatch(description, ctx) {
  var caps = ctx.captures || [];
  if (caps.length === 0 || !description.trim()) return { match: false };
  var candTokens = tokenize(description);
  var best = { score: 0, entry: null, shared: [] };
  for (var i = 0; i < caps.length; i++) {
    var c = caps[i];
    var entryTokens = tokenize((c.label || '') + ' ' + (c.description || ''));
    var j = jaccard(candTokens, entryTokens);
    if (j.score > best.score) {
      best = { score: j.score, entry: c, shared: j.shared };
    }
  }
  if (best.score >= 0.4 && best.entry) {
    return {
      match: true,
      entry: { label: best.entry.label, description: best.entry.description || '', time: best.entry.time },
      reason: 'tokens overlap {' + best.shared.join(', ') + '}, ' + best.score.toFixed(2) + ' similarity'
    };
  }
  return { match: false };
}

async function captureWithValidation(label, description, ctx) {
  var canvas = ctx.captureCurrentFrame(1920);
  if (!canvas) return 'No video available.';
  var dataUrl = canvas.toDataURL('image/jpeg', 0.85);

  if (ctx.vlm) {
    try {
      var imageData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      var image = new ctx.vlm.RawImage(imageData.data, canvas.width, canvas.height, 4);
      var valMessages = [
        { role: 'user', content: [{ type: 'image' }, { type: 'text', text: `Does this image contain any ${TARGET_CATEGORY}? Answer YES or NO only.` }] }
      ];
      var chatPrompt = ctx.vlm.processor.apply_chat_template(valMessages, { add_generation_prompt: true });
      var inputs = await ctx.vlm.processor(image, chatPrompt, { add_special_tokens: false });
      var outputs = await ctx.vlm.model.generate({ ...inputs, do_sample: false, max_new_tokens: 8 });
      var decoded = ctx.vlm.processor.batch_decode(
        outputs.slice(null, [inputs.input_ids.dims.at(-1), null]),
        { skip_special_tokens: true }
      );
      var answer = (decoded[0] || '').toUpperCase();
      ctx.agentLog('vlm', 'Capture validation: ' + decoded[0]);
      if (answer.indexOf('NO') !== -1 && answer.indexOf('YES') === -1) {
        return `Capture rejected: VLM says no ${TARGET_CATEGORY} visible in the frame. The camera may have moved. Try again.`;
      }
    } catch (e) {
      console.warn('Capture validation failed, saving anyway:', e);
    }
  }

  var now = new Date().toLocaleTimeString();
  var capture = { label: label, description: description, image: dataUrl, time: now };
  ctx.captures.push(capture);
  ctx.renderCaptures(capture);
  ctx.agentLog('capture', label + (description ? ' — ' + description : ''));

  var memEntry = label + (description ? ': ' + description : ' catalogued');
  ctx.agentMemory.push({ entry: memEntry, time: now });
  if (ctx.agentMemory.length > 20) ctx.agentMemory.shift();
  ctx.renderMemory();

  var lastVlmOutput = document.getElementById('vlm-output');
  ctx.agentLastCapture = {
    label: label,
    time: Date.now(),
    vlmSnippet: lastVlmOutput ? lastVlmOutput.textContent.slice(0, 80) : ''
  };

  var promptEl = document.getElementById('vlm-prompt');
  if (promptEl) promptEl.value = VLM_DEFAULT_PROMPT;
  ctx.agentCooldownUntil = Date.now() + 10000;

  if (ctx.dataConn && ctx.dataConn.open) {
    ctx.dataConn.send({ type: 'capture', label: capture.label, description: description, image: dataUrl, time: now });
    ctx.dataConn.send({ type: 'memory', entries: ctx.agentMemory });
  }
  return 'Frame saved as "' + label + '". Observation saved to memory. Prompt reset.';
}
