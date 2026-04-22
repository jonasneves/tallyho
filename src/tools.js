// Tool definitions and execution for the cat identification agent.

export var VLM_DEFAULT_PROMPT = 'Describe what you see in this image. For any animal, note fur length and texture.';

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
    description: 'Save the current camera frame with a label and description. Use when you have identified the cat.',
    input_schema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Cat name: "Oscar" or "Maomao"' },
        description: { type: 'string', description: 'Short diary entry, e.g. "Napping in the cardboard box near the window"' }
      },
      required: ['label']
    }
  },
  {
    name: 'check_image',
    description: 'See the actual camera frame yourself instead of relying on VLM text. Use when VLM descriptions are unclear.',
    input_schema: { type: 'object', properties: {}, required: [] }
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
      { type: 'text', text: 'Here is the camera frame. Identify the cat.' }
    ];
  }

  if (name === 'capture_frame') {
    return captureWithValidation(input.label, input.description || '', ctx);
  }

  return 'Unknown tool.';
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
        { role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'Is there a cat in this image? Answer YES or NO only.' }] }
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
        return 'Capture rejected: VLM says no cat visible in the frame. The camera may have moved. Try again.';
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

  var memEntry = label + (description ? ': ' + description : ' spotted');
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
