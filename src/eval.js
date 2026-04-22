// Evaluation harness for the TallyHo agent.
// Runs offline: sends pre-recorded VLM descriptions through the same
// Claude system prompt + tools, mocks tool execution, compares to ground truth.
//
// Usage:
//   node src/eval.js                          # uses local proxy
//   ANTHROPIC_API_KEY=sk-ant-... node src/eval.js   # uses direct API

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SAMPLES = JSON.parse(readFileSync(join(ROOT, 'data/eval/samples.json'), 'utf8'));
const SCORES_OUT = join(ROOT, 'results/eval/scores.json');

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const CLAUDE_URL = API_KEY
  ? 'https://api.anthropic.com/v1/messages'
  : 'http://127.0.0.1:7337/v1/messages';
const CLAUDE_HEADERS = API_KEY
  ? { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' }
  : { 'Content-Type': 'application/json' };

import { buildSystemPrompt } from './agent.js';

const AGENT_SYSTEM = buildSystemPrompt();

const AGENT_TOOLS = [
  {
    name: 'set_vlm_prompt',
    description: 'Change the VLM prompt. Use SHORT simple prompts only (max 10 words).',
    input_schema: {
      type: 'object',
      properties: { prompt: { type: 'string' } },
      required: ['prompt']
    }
  },
  {
    name: 'capture_frame',
    description: 'Save the current camera frame with a label and description.',
    input_schema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Cat name: "Oscar" or "Maomao"' },
        description: { type: 'string' }
      },
      required: ['label']
    }
  },
  {
    name: 'check_image',
    description: 'See the actual camera frame yourself instead of relying on VLM text.',
    input_schema: { type: 'object', properties: {}, required: [] }
  }
];

async function callClaude(messages) {
  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: CLAUDE_HEADERS,
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      system: AGENT_SYSTEM,
      tools: AGENT_TOOLS,
      messages
    })
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

// Run one sample through the agent loop with mocked tools.
async function runSample(sample) {
  const messages = [
    { role: 'user', content: 'Vision model output: ' + sample.vlm_text }
  ];

  let captured = null;
  let totalTokens = { input: 0, output: 0 };
  let apiCalls = 0;
  const toolsUsed = [];

  for (let i = 0; i < 3; i++) {
    const data = await callClaude(messages);
    apiCalls++;
    totalTokens.input += data.usage?.input_tokens || 0;
    totalTokens.output += data.usage?.output_tokens || 0;

    messages.push({ role: 'assistant', content: data.content });

    const toolCalls = data.content.filter(b => b.type === 'tool_use');
    if (toolCalls.length === 0) break;

    const results = [];
    for (const tc of toolCalls) {
      toolsUsed.push(tc.name);
      let result;

      if (tc.name === 'capture_frame') {
        captured = tc.input.label;
        result = `Frame saved as "${tc.input.label}". Observation saved to memory. Prompt reset.`;
      } else if (tc.name === 'set_vlm_prompt') {
        result = 'Prompt updated. Next VLM output will use this prompt.';
      } else if (tc.name === 'check_image') {
        if (sample.check_image_description) {
          result = sample.check_image_description;
        } else if (sample.ground_truth) {
          result = sample.ground_truth === 'Maomao'
            ? 'A light silvery gray cat with long fluffy fur.'
            : sample.ground_truth === 'Oscar'
            ? 'A dark charcoal gray cat with short smooth fur.'
            : 'Two cats: one fluffy light gray, one short-haired dark gray.';
        } else {
          result = 'No cat visible in the frame.';
        }
      }

      results.push({ type: 'tool_result', tool_use_id: tc.id, content: result });
    }

    // Exit immediately after successful capture
    if (captured) break;

    messages.push({ role: 'user', content: results });

    // If VLM prompt was changed, inject follow-up
    if (toolCalls.some(tc => tc.name === 'set_vlm_prompt')) {
      const followUp = sample.follow_up || sample.vlm_text;
      messages.push({ role: 'user', content: 'Vision model output: ' + followUp });
    }

    if (data.stop_reason === 'end_turn') break;
  }

  return { captured, apiCalls, totalTokens, toolsUsed };
}

async function main() {
  console.log(`Running ${SAMPLES.length} samples...\n`);

  const results = [];
  let correct = 0;
  let total = 0;
  const perCat = { Oscar: { tp: 0, fp: 0, fn: 0 }, Maomao: { tp: 0, fp: 0, fn: 0 } };
  const perCategory = {};
  let totalTokensAll = 0;
  let totalCallsAll = 0;
  let falsePositives = 0;

  for (const sample of SAMPLES) {
    process.stdout.write(`  ${sample.id}... `);
    try {
      const result = await runSample(sample);
      const expected = sample.ground_truth;
      const got = result.captured;

      let isCorrect;
      if (expected === null) {
        isCorrect = got === null;
        if (got !== null) falsePositives++;
      } else if (expected === 'both') {
        isCorrect = got === 'Oscar' || got === 'Maomao';
      } else {
        isCorrect = got === expected;
      }

      if (isCorrect) correct++;
      total++;

      // Per-cat stats
      if (expected && expected !== 'both') {
        if (got === expected) perCat[expected].tp++;
        else if (got === null) perCat[expected].fn++;
        else if (got && got !== expected) {
          perCat[expected].fn++;
          if (perCat[got]) perCat[got].fp++;
        }
      }

      // Per-category stats
      if (!perCategory[sample.category]) {
        perCategory[sample.category] = { correct: 0, total: 0, tokens: 0, calls: 0 };
      }
      perCategory[sample.category].total++;
      if (isCorrect) perCategory[sample.category].correct++;
      perCategory[sample.category].tokens += result.totalTokens.input + result.totalTokens.output;
      perCategory[sample.category].calls += result.apiCalls;

      totalTokensAll += result.totalTokens.input + result.totalTokens.output;
      totalCallsAll += result.apiCalls;

      const status = isCorrect ? '✓' : '✗';
      console.log(`${status}  expected=${expected}, got=${got}, calls=${result.apiCalls}, tokens=${result.totalTokens.input + result.totalTokens.output}`);

      results.push({ id: sample.id, category: sample.category, expected, got, correct: isCorrect, ...result });
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      results.push({ id: sample.id, error: e.message });
      total++;
    }
  }

  // Compute metrics
  const catMetrics = {};
  for (const [name, s] of Object.entries(perCat)) {
    const precision = s.tp + s.fp > 0 ? s.tp / (s.tp + s.fp) : 0;
    const recall = s.tp + s.fn > 0 ? s.tp / (s.tp + s.fn) : 0;
    catMetrics[name] = {
      precision: Math.round(precision * 1000) / 1000,
      recall: Math.round(recall * 1000) / 1000,
      f1: precision + recall > 0 ? Math.round(2 * precision * recall / (precision + recall) * 1000) / 1000 : 0
    };
  }

  const categoryMetrics = {};
  for (const [cat, s] of Object.entries(perCategory)) {
    categoryMetrics[cat] = {
      accuracy: Math.round(s.correct / s.total * 1000) / 1000,
      avg_tokens: Math.round(s.tokens / s.total),
      avg_calls: Math.round(s.calls / s.total * 10) / 10,
      n: s.total
    };
  }

  const scores = {
    overall_accuracy: Math.round(correct / total * 1000) / 1000,
    total_samples: total,
    correct,
    per_cat: catMetrics,
    per_category: categoryMetrics,
    efficiency: {
      avg_tokens: Math.round(totalTokensAll / total),
      avg_api_calls: Math.round(totalCallsAll / total * 10) / 10
    },
    false_positive_rate: Math.round(falsePositives / SAMPLES.filter(s => s.ground_truth === null).length * 1000) / 1000,
    results
  };

  console.log('\n' + '='.repeat(50));
  console.log(`Accuracy:     ${scores.overall_accuracy} (${correct}/${total})`);
  console.log(`Oscar:        P=${catMetrics.Oscar.precision} R=${catMetrics.Oscar.recall} F1=${catMetrics.Oscar.f1}`);
  console.log(`Maomao:       P=${catMetrics.Maomao.precision} R=${catMetrics.Maomao.recall} F1=${catMetrics.Maomao.f1}`);
  console.log(`FP rate:      ${scores.false_positive_rate}`);
  console.log(`Avg tokens:   ${scores.efficiency.avg_tokens}`);
  console.log(`Avg API calls: ${scores.efficiency.avg_api_calls}`);
  console.log('='.repeat(50));

  mkdirSync(dirname(SCORES_OUT), { recursive: true });
  writeFileSync(SCORES_OUT, JSON.stringify(scores, null, 2));
  console.log(`\nScores written to ${SCORES_OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
