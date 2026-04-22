// Evaluation harness for the TallyHo agent.
// Runs offline: sends pre-recorded VLM captions through the same Claude
// system prompt + tools as the live app, mocks tool execution, compares
// to ground truth, writes per-category metrics to results/eval/scores.json.
//
// Sample schema (see data/eval/README.md for full detail):
//   {
//     id, category: 'clear'|'adversarial'|'occluded'|'duplicate'|'negative',
//     vlm_text, photo_path, check_image_description, follow_up, notes,
//     ground_truth: { is_target: bool, expected_label?: string, duplicate_of?: string }
//   }
//
// Usage:
//   node src/eval.js                                  # uses local proxy
//   ANTHROPIC_API_KEY=sk-ant-... node src/eval.js     # uses direct API

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { buildSystemPrompt } from './agent.js';
import { AGENT_TOOLS, TARGET_CATEGORY } from './tools.js';

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

const AGENT_SYSTEM = buildSystemPrompt();
const CATEGORIES = ['clear', 'adversarial', 'occluded', 'duplicate', 'negative'];

async function callClaude(messages, systemWithMemory) {
  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: CLAUDE_HEADERS,
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: systemWithMemory,
      tools: AGENT_TOOLS,
      messages
    })
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

// Mocked catalog for the run. Fed to check_catalog_match so duplicate-pair
// samples can succeed when Claude actually calls the dedup tool.
function makeCatalog() {
  return [];
}

// Token-set Jaccard, mirroring src/tools.js checkCatalogMatch behavior.
// Kept local so the harness has no browser DOM dependency.
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'of', 'with', 'and', 'or', 'is', 'it', 'its',
  'in', 'on', 'at', 'to', 'for', 'from', 'this', 'that', 'these', 'those',
  'visible', 'front', 'back', 'side', 'clear', 'partial',
  'can', 'tin', 'container', 'label'
]);

function tokenize(s) {
  if (!s) return new Set();
  const toks = s.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/);
  const out = new Set();
  for (const t of toks) {
    if (t && t.length > 1 && !STOP_WORDS.has(t)) out.add(t);
  }
  return out;
}

function jaccard(a, b) {
  let inter = 0;
  const shared = [];
  for (const k of a) {
    if (b.has(k)) { inter++; shared.push(k); }
  }
  const union = new Set([...a, ...b]).size;
  return { score: union === 0 ? 0 : inter / union, shared };
}

function mockCheckCatalogMatch(description, catalog) {
  if (!catalog.length || !description.trim()) return { match: false };
  const cand = tokenize(description);
  let best = { score: 0, entry: null, shared: [] };
  for (const c of catalog) {
    const entryToks = tokenize((c.label || '') + ' ' + (c.description || ''));
    const j = jaccard(cand, entryToks);
    if (j.score > best.score) best = { score: j.score, entry: c, shared: j.shared };
  }
  if (best.score >= 0.4 && best.entry) {
    return {
      match: true,
      entry: { label: best.entry.label, description: best.entry.description, time: best.entry.time },
      reason: `tokens overlap {${best.shared.join(', ')}}, ${best.score.toFixed(2)} similarity`
    };
  }
  return { match: false };
}

// Mock of captureWithValidation's VLM second-pass check.
// The real validator asks an in-browser VLM "does this image contain any {TARGET_CATEGORY}?"
// Here we approximate that by using ground truth: if is_target is false, the validator
// would have said NO and blocked the capture.
//
// TODO: once the image-based classical harness lands, replace this with an actual
// VLM pass against sample.photo_path so validator_catch_rate reflects real behavior
// rather than an oracle lookup.
function mockValidatorWouldBlock(sample) {
  return sample.ground_truth && sample.ground_truth.is_target === false;
}

// Run one sample through the agent loop with mocked tools.
async function runSample(sample, catalog, systemWithMemory) {
  const messages = [
    { role: 'user', content: 'Vision model output: ' + sample.vlm_text }
  ];

  let capturedLabel = null;
  let captureAttempted = false;
  let captureBlockedByValidator = false;
  let checkCatalogMatchCalled = false;
  let catalogMatchReported = false;
  let totalTokens = { input: 0, output: 0 };
  let apiCalls = 0;
  const toolsUsed = [];

  for (let i = 0; i < 4; i++) {
    const data = await callClaude(messages, systemWithMemory);
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
        captureAttempted = true;
        if (mockValidatorWouldBlock(sample)) {
          captureBlockedByValidator = true;
          result = `Capture rejected: VLM says no ${TARGET_CATEGORY} visible in the frame. The camera may have moved. Try again.`;
        } else {
          capturedLabel = tc.input.label || '';
          result = `Frame saved as "${capturedLabel}". Observation saved to memory. Prompt reset.`;
          catalog.push({
            label: capturedLabel,
            description: tc.input.description || '',
            time: new Date().toLocaleTimeString()
          });
        }
      } else if (tc.name === 'set_vlm_prompt') {
        result = 'Prompt updated. Next VLM output will use this prompt.';
      } else if (tc.name === 'check_image') {
        result = sample.check_image_description
          || (sample.ground_truth?.is_target ? 'A cylindrical can on a surface.' : 'No can visible in the frame.');
      } else if (tc.name === 'check_catalog_match') {
        checkCatalogMatchCalled = true;
        const m = mockCheckCatalogMatch(tc.input.description || '', catalog);
        if (m.match) catalogMatchReported = true;
        result = JSON.stringify(m);
      } else if (tc.name === 'guide_operator') {
        result = 'Message "' + (tc.input.message || '') + '" sent to phone overlay.';
      } else {
        result = 'Unknown tool.';
      }

      results.push({ type: 'tool_result', tool_use_id: tc.id, content: result });
    }

    // Successful capture — exit immediately (mirrors live agent behavior).
    if (capturedLabel && !captureBlockedByValidator) break;

    messages.push({ role: 'user', content: results });

    // If VLM prompt was changed, inject follow-up caption.
    if (toolCalls.some(tc => tc.name === 'set_vlm_prompt')) {
      const followUp = sample.follow_up || sample.vlm_text;
      messages.push({ role: 'user', content: 'Vision model output: ' + followUp });
    }

    if (data.stop_reason === 'end_turn') break;
  }

  return {
    capturedLabel,
    captureAttempted,
    captureBlockedByValidator,
    checkCatalogMatchCalled,
    catalogMatchReported,
    apiCalls,
    totalTokens,
    toolsUsed
  };
}

// Score a single sample against its ground truth.
// Returns { correct: bool, decision_kind: 'captured'|'skipped'|'rejected-by-validator' }.
function scoreSample(sample, runResult) {
  const gt = sample.ground_truth || {};
  const capturedEffective = runResult.capturedLabel !== null && !runResult.captureBlockedByValidator;

  if (sample.category === 'negative') {
    // Correct iff nothing was captured (validator-block counts as correct refusal).
    return { correct: !capturedEffective, decision_kind: capturedEffective ? 'wrong-capture' : 'skipped' };
  }

  if (sample.category === 'adversarial') {
    if (gt.is_target === false) {
      return { correct: !capturedEffective, decision_kind: capturedEffective ? 'wrong-capture' : 'skipped' };
    }
    // Adversarial-but-still-target is not in the current set, but handle defensively.
    return { correct: capturedEffective, decision_kind: capturedEffective ? 'captured' : 'missed' };
  }

  if (sample.category === 'duplicate') {
    // Duplicate pairs: the first sample in the pair expects capture; the second
    // (has duplicate_of) expects skip. The signal under test is whether the agent
    // called check_catalog_match and acted on the returned match.
    if (gt.duplicate_of) {
      return {
        correct: !capturedEffective && runResult.catalogMatchReported,
        decision_kind: capturedEffective ? 'wrong-capture' : 'skipped'
      };
    }
    return { correct: capturedEffective, decision_kind: capturedEffective ? 'captured' : 'missed' };
  }

  // clear + occluded: expect a capture, label proximity is informational.
  if (gt.is_target) {
    return { correct: capturedEffective, decision_kind: capturedEffective ? 'captured' : 'missed' };
  }
  return { correct: !capturedEffective, decision_kind: capturedEffective ? 'wrong-capture' : 'skipped' };
}

function emptyCategoryBucket() {
  return {
    n: 0,
    correct: 0,
    tp: 0,  // predicted capture, ground truth says capture-worthy
    fp: 0,  // predicted capture, ground truth says no
    fn: 0,  // no capture, ground truth said capture-worthy
    tn: 0,  // no capture, ground truth said no
    tokens: 0,
    calls: 0
  };
}

async function main() {
  console.log(`Running ${SAMPLES.length} samples across ${CATEGORIES.length} categories...\n`);

  const catalog = makeCatalog();
  const results = [];
  const perCategory = Object.fromEntries(CATEGORIES.map(c => [c, emptyCategoryBucket()]));

  let correctAll = 0;
  let totalAll = 0;
  let totalTokensAll = 0;
  let totalCallsAll = 0;
  let falsePositives = 0;
  let falsePositiveDenominator = 0;
  let validatorCatches = 0;
  let validatorOpportunities = 0;

  // Sort so the first half of each duplicate pair runs before the second.
  const ordered = [...SAMPLES].sort((a, b) => {
    const aDup = a.ground_truth?.duplicate_of ? 1 : 0;
    const bDup = b.ground_truth?.duplicate_of ? 1 : 0;
    return aDup - bDup;
  });

  for (const sample of ordered) {
    process.stdout.write(`  ${sample.id}... `);
    try {
      const r = await runSample(sample, catalog, AGENT_SYSTEM);
      const { correct, decision_kind } = scoreSample(sample, r);

      const bucket = perCategory[sample.category] || (perCategory[sample.category] = emptyCategoryBucket());
      bucket.n++;
      if (correct) bucket.correct++;

      const capturedEffective = r.capturedLabel !== null && !r.captureBlockedByValidator;
      const expectedCapture =
        sample.category === 'negative' ? false
        : sample.category === 'adversarial' ? sample.ground_truth?.is_target === true
        : sample.category === 'duplicate' ? !sample.ground_truth?.duplicate_of
        : sample.ground_truth?.is_target === true;

      if (expectedCapture && capturedEffective) bucket.tp++;
      else if (!expectedCapture && capturedEffective) bucket.fp++;
      else if (expectedCapture && !capturedEffective) bucket.fn++;
      else bucket.tn++;

      bucket.tokens += r.totalTokens.input + r.totalTokens.output;
      bucket.calls += r.apiCalls;

      if (!expectedCapture) {
        falsePositiveDenominator++;
        if (capturedEffective) falsePositives++;
      }

      if (r.captureAttempted) {
        validatorOpportunities++;
        if (r.captureBlockedByValidator) validatorCatches++;
      }

      totalTokensAll += r.totalTokens.input + r.totalTokens.output;
      totalCallsAll += r.apiCalls;
      totalAll++;
      if (correct) correctAll++;

      const status = correct ? 'OK ' : 'BAD';
      const gtLabel = sample.ground_truth?.expected_label
        || (sample.ground_truth?.duplicate_of ? `duplicate_of=${sample.ground_truth.duplicate_of}` : '')
        || (sample.ground_truth?.is_target === false ? 'not-target' : '');
      console.log(
        `${status}  decision=${decision_kind}, gt=${gtLabel || '-'}, captured=${r.capturedLabel ?? 'none'}, calls=${r.apiCalls}, tokens=${r.totalTokens.input + r.totalTokens.output}`
      );

      results.push({
        id: sample.id,
        category: sample.category,
        ground_truth: sample.ground_truth,
        captured_label: r.capturedLabel,
        capture_attempted: r.captureAttempted,
        capture_blocked_by_validator: r.captureBlockedByValidator,
        check_catalog_match_called: r.checkCatalogMatchCalled,
        catalog_match_reported: r.catalogMatchReported,
        correct,
        decision_kind,
        tools_used: r.toolsUsed,
        api_calls: r.apiCalls,
        tokens: r.totalTokens
      });
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      results.push({ id: sample.id, error: e.message });
      totalAll++;
    }
  }

  // Per-category metrics.
  const categoryMetrics = {};
  for (const [cat, s] of Object.entries(perCategory)) {
    if (s.n === 0) {
      categoryMetrics[cat] = { n: 0, correct: 0, accuracy: null, precision: null, recall: null, f1: null, avg_tokens: null, avg_calls: null };
      continue;
    }
    const precision = (s.tp + s.fp) > 0 ? s.tp / (s.tp + s.fp) : null;
    const recall = (s.tp + s.fn) > 0 ? s.tp / (s.tp + s.fn) : null;
    const f1 = (precision !== null && recall !== null && precision + recall > 0)
      ? (2 * precision * recall) / (precision + recall)
      : null;
    categoryMetrics[cat] = {
      n: s.n,
      correct: s.correct,
      accuracy: round3(s.correct / s.n),
      precision: round3(precision),
      recall: round3(recall),
      f1: round3(f1),
      avg_tokens: Math.round(s.tokens / s.n),
      avg_calls: round1(s.calls / s.n)
    };
  }

  const scores = {
    target_category: TARGET_CATEGORY,
    total_samples: totalAll,
    correct: correctAll,
    overall_accuracy: totalAll ? round3(correctAll / totalAll) : null,
    false_positive_rate: falsePositiveDenominator ? round3(falsePositives / falsePositiveDenominator) : null,
    validator_catch_rate: validatorOpportunities ? round3(validatorCatches / validatorOpportunities) : null,
    validator_catches: validatorCatches,
    validator_opportunities: validatorOpportunities,
    efficiency: {
      avg_tokens: totalAll ? Math.round(totalTokensAll / totalAll) : null,
      avg_api_calls: totalAll ? round1(totalCallsAll / totalAll) : null
    },
    per_category: categoryMetrics,
    results
  };

  console.log('\n' + '='.repeat(60));
  console.log(`Target:              ${TARGET_CATEGORY}`);
  console.log(`Overall accuracy:    ${fmt(scores.overall_accuracy)} (${correctAll}/${totalAll})`);
  console.log(`False positive rate: ${fmt(scores.false_positive_rate)}`);
  console.log(`Validator catch rate: ${fmt(scores.validator_catch_rate)} (${validatorCatches}/${validatorOpportunities})`);
  console.log(`Avg tokens / sample: ${fmt(scores.efficiency.avg_tokens)}`);
  console.log(`Avg API calls:       ${fmt(scores.efficiency.avg_api_calls)}`);
  console.log('');
  console.log('Per category:');
  for (const cat of CATEGORIES) {
    const m = categoryMetrics[cat];
    if (!m || m.n === 0) { console.log(`  ${cat.padEnd(12)} n=0`); continue; }
    console.log(
      `  ${cat.padEnd(12)} n=${m.n}  acc=${fmt(m.accuracy)}  P=${fmt(m.precision)}  R=${fmt(m.recall)}  F1=${fmt(m.f1)}  tok=${fmt(m.avg_tokens)}`
    );
  }
  console.log('='.repeat(60));

  mkdirSync(dirname(SCORES_OUT), { recursive: true });
  writeFileSync(SCORES_OUT, JSON.stringify(scores, null, 2));
  console.log(`\nScores written to ${SCORES_OUT}`);
}

function round3(x) { return x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 1000) / 1000; }
function round1(x) { return x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 10) / 10; }
function fmt(x) { return x === null || x === undefined ? '—' : String(x); }

main().catch(e => { console.error(e); process.exit(1); });
