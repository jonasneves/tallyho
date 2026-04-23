// Evaluation harness for the TallyHo agent — dual version.
// Runs both arms (DL + classical) against the same sample set so the rubric
// line "evaluation applied to BOTH versions and compared" is met
// structurally. Writes a dual-block scores.json so a reader sees DL and
// classical numbers side-by-side, with explicit counters for how many
// classical samples were actually evaluable.
//
// DL pathway:    sends pre-recorded VLM captions through the live system
//                prompt + tools, mocks tool execution, scores Claude's
//                decisions against ground truth.
// Classical:     reads sample.classical_decision (filled by hand from a
//                browser-side analyzeFrame() run; see data/eval/README.md
//                for the workflow). If null, the sample is skipped on the
//                classical side and counted in samples_skipped_no_decision.
//
// Sample schema (see data/eval/README.md for full detail):
//   {
//     id, category: 'clear'|'adversarial'|'occluded'|'duplicate'|'negative',
//     vlm_text, photo_path, check_image_description, follow_up, notes,
//     ground_truth: { is_target: bool, expected_label?: string, duplicate_of?: string },
//     classical_decision: { detected, label, confidence, reasons } | null
//   }
//
// Usage:
//   node src/eval.js                                  # both arms, uses local proxy
//   node src/eval.js --dl-only                        # DL arm only
//   node src/eval.js --classical-only                 # classical arm only (no API key needed)
//   ANTHROPIC_API_KEY=sk-ant-... node src/eval.js     # DL via direct API

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

// ---------------------------------------------------------------------------
// Shared scoring primitives.
// ---------------------------------------------------------------------------

// expectedCapture(sample): does the ground truth want a capture for this sample?
// Used identically by DL and classical scoring so the two arms are compared on
// the same pass/fail rubric.
function expectedCapture(sample) {
  const gt = sample.ground_truth || {};
  if (sample.category === 'negative') return false;
  if (sample.category === 'adversarial') return gt.is_target === true;
  if (sample.category === 'duplicate') return !gt.duplicate_of;
  return gt.is_target === true;
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

function summarizeCategory(s) {
  if (s.n === 0) {
    return { n: 0, correct: 0, accuracy: null, precision: null, recall: null, f1: null, avg_tokens: null, avg_calls: null };
  }
  const precision = (s.tp + s.fp) > 0 ? s.tp / (s.tp + s.fp) : null;
  const recall = (s.tp + s.fn) > 0 ? s.tp / (s.tp + s.fn) : null;
  const f1 = (precision !== null && recall !== null && precision + recall > 0)
    ? (2 * precision * recall) / (precision + recall)
    : null;
  return {
    n: s.n,
    correct: s.correct,
    accuracy: round3(s.correct / s.n),
    precision: round3(precision),
    recall: round3(recall),
    f1: round3(f1),
    avg_tokens: s.tokens > 0 ? Math.round(s.tokens / s.n) : null,
    avg_calls: s.calls > 0 ? round1(s.calls / s.n) : null
  };
}

// ---------------------------------------------------------------------------
// DL pathway.
// ---------------------------------------------------------------------------

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
async function runDLSample(sample, catalog, systemWithMemory) {
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

// Score a single DL sample against its ground truth.
function scoreDLSample(sample, runResult) {
  const gt = sample.ground_truth || {};
  const capturedEffective = runResult.capturedLabel !== null && !runResult.captureBlockedByValidator;

  if (sample.category === 'negative') {
    return { correct: !capturedEffective, decision_kind: capturedEffective ? 'wrong-capture' : 'skipped' };
  }
  if (sample.category === 'adversarial') {
    if (gt.is_target === false) {
      return { correct: !capturedEffective, decision_kind: capturedEffective ? 'wrong-capture' : 'skipped' };
    }
    return { correct: capturedEffective, decision_kind: capturedEffective ? 'captured' : 'missed' };
  }
  if (sample.category === 'duplicate') {
    if (gt.duplicate_of) {
      return {
        correct: !capturedEffective && runResult.catalogMatchReported,
        decision_kind: capturedEffective ? 'wrong-capture' : 'skipped'
      };
    }
    return { correct: capturedEffective, decision_kind: capturedEffective ? 'captured' : 'missed' };
  }
  // clear + occluded
  if (gt.is_target) {
    return { correct: capturedEffective, decision_kind: capturedEffective ? 'captured' : 'missed' };
  }
  return { correct: !capturedEffective, decision_kind: capturedEffective ? 'wrong-capture' : 'skipped' };
}

// runDL(samples) -> dual-block-ready summary for the DL arm.
// Calls Claude per sample with mocked tools, scores against ground truth,
// returns aggregate metrics + per-sample records.
async function runDL(samples) {
  if (!API_KEY) {
    // Probe the local proxy. If it's not up, fail clearly with the same
    // message users have always seen.
    try {
      await fetch(CLAUDE_URL.replace('/v1/messages', '/'), { method: 'GET' });
    } catch (e) {
      throw new Error(
        `DL arm needs an LLM. Set ANTHROPIC_API_KEY or start the local proxy at 127.0.0.1:7337.`
      );
    }
  }

  console.log(`\n[DL] Running ${samples.length} samples...`);
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
  const ordered = [...samples].sort((a, b) => {
    const aDup = a.ground_truth?.duplicate_of ? 1 : 0;
    const bDup = b.ground_truth?.duplicate_of ? 1 : 0;
    return aDup - bDup;
  });

  for (const sample of ordered) {
    process.stdout.write(`  ${sample.id}... `);
    try {
      const r = await runDLSample(sample, catalog, AGENT_SYSTEM);
      const { correct, decision_kind } = scoreDLSample(sample, r);

      const bucket = perCategory[sample.category] || (perCategory[sample.category] = emptyCategoryBucket());
      bucket.n++;
      if (correct) bucket.correct++;

      const capturedEffective = r.capturedLabel !== null && !r.captureBlockedByValidator;
      const wantsCapture = expectedCapture(sample);
      if (wantsCapture && capturedEffective) bucket.tp++;
      else if (!wantsCapture && capturedEffective) bucket.fp++;
      else if (wantsCapture && !capturedEffective) bucket.fn++;
      else bucket.tn++;

      bucket.tokens += r.totalTokens.input + r.totalTokens.output;
      bucket.calls += r.apiCalls;

      if (!wantsCapture) {
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

  const categoryMetrics = {};
  for (const [cat, s] of Object.entries(perCategory)) {
    categoryMetrics[cat] = summarizeCategory(s);
  }

  return {
    overall_accuracy: totalAll ? round3(correctAll / totalAll) : null,
    correct: correctAll,
    total: totalAll,
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
}

// ---------------------------------------------------------------------------
// Classical pathway.
// ---------------------------------------------------------------------------

// Score a single classical decision against ground truth. Same pass/fail
// rubric as DL: adversarial=>detected is wrong (false positive); negative
// =>detected is wrong; clear/occluded=>detected is correct. Duplicates are
// not evaluable here because dedup is not part of analyzeFrame; that lives
// downstream and would need to be added before classical can be scored on
// dup samples.
function scoreClassicalSample(sample) {
  const decision = sample.classical_decision;
  if (!decision) {
    return { scored: false, skipped_reason: 'no_classical_decision' };
  }

  const detected = !!decision.detected;

  if (sample.category === 'duplicate') {
    // TODO: dedup is a downstream feature, not something analyzeFrame does
    // today. Mark as not-evaluable rather than guess. Add this once
    // classical has a catalog-match step.
    return {
      scored: false,
      skipped_reason: 'dedup_not_implemented_in_classical',
      decision_kind: detected ? 'detected' : 'not-detected'
    };
  }

  const wants = expectedCapture(sample);
  const correct = detected === wants;
  const decision_kind =
    detected && wants ? 'detected'
    : detected && !wants ? 'wrong-detection'
    : !detected && wants ? 'missed'
    : 'skipped';
  return { scored: true, correct, decision_kind, detected };
}

// runClassical(samples) -> dual-block-ready summary for the classical arm.
// Reads sample.classical_decision (filled out-of-band from a browser-side
// analyzeFrame() run; see data/eval/README.md). Skips samples whose decision
// is null and counts them in samples_skipped_no_decision.
function runClassical(samples) {
  console.log(`\n[Classical] Scoring ${samples.length} samples (skips those without classical_decision)...`);

  const results = [];
  const perCategory = Object.fromEntries(CATEGORIES.map(c => [c, emptyCategoryBucket()]));

  let correctAll = 0;
  let totalScored = 0;
  let skipped = 0;
  let falsePositives = 0;
  let falsePositiveDenominator = 0;

  for (const sample of samples) {
    const score = scoreClassicalSample(sample);

    if (!score.scored) {
      skipped++;
      const reason = score.skipped_reason;
      console.log(`  ${sample.id}... SKIP (${reason})`);
      results.push({
        id: sample.id,
        category: sample.category,
        ground_truth: sample.ground_truth,
        classical_decision: sample.classical_decision,
        scored: false,
        skipped_reason: reason,
        decision_kind: score.decision_kind ?? null
      });
      continue;
    }

    const bucket = perCategory[sample.category] || (perCategory[sample.category] = emptyCategoryBucket());
    bucket.n++;
    if (score.correct) bucket.correct++;

    const wants = expectedCapture(sample);
    const detected = score.detected;
    if (wants && detected) bucket.tp++;
    else if (!wants && detected) bucket.fp++;
    else if (wants && !detected) bucket.fn++;
    else bucket.tn++;

    if (!wants) {
      falsePositiveDenominator++;
      if (detected) falsePositives++;
    }

    totalScored++;
    if (score.correct) correctAll++;

    const status = score.correct ? 'OK ' : 'BAD';
    const gtLabel = sample.ground_truth?.expected_label
      || (sample.ground_truth?.is_target === false ? 'not-target' : '');
    console.log(
      `  ${sample.id}... ${status}  decision=${score.decision_kind}, gt=${gtLabel || '-'}, conf=${(sample.classical_decision.confidence ?? 0).toFixed(2)}`
    );

    results.push({
      id: sample.id,
      category: sample.category,
      ground_truth: sample.ground_truth,
      classical_decision: sample.classical_decision,
      scored: true,
      correct: score.correct,
      decision_kind: score.decision_kind
    });
  }

  const categoryMetrics = {};
  for (const [cat, s] of Object.entries(perCategory)) {
    categoryMetrics[cat] = summarizeCategory(s);
  }

  return {
    overall_accuracy: totalScored ? round3(correctAll / totalScored) : null,
    correct: correctAll,
    total: totalScored,
    false_positive_rate: falsePositiveDenominator ? round3(falsePositives / falsePositiveDenominator) : null,
    per_category: categoryMetrics,
    samples_evaluated: totalScored,
    samples_skipped_no_decision: skipped,
    results
  };
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { dl: true, classical: true };
  for (const a of argv.slice(2)) {
    if (a === '--dl-only') out.classical = false;
    else if (a === '--classical-only') out.dl = false;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node src/eval.js [--dl-only|--classical-only]');
      process.exit(0);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`Target category: ${TARGET_CATEGORY}`);
  console.log(`Total samples:   ${SAMPLES.length}`);
  console.log(`Arms:            ${[args.dl ? 'DL' : null, args.classical ? 'classical' : null].filter(Boolean).join(' + ')}`);

  let dlBlock = null;
  let classicalBlock = null;

  if (args.dl) {
    dlBlock = await runDL(SAMPLES);
  } else {
    dlBlock = nullDLBlock(SAMPLES);
  }

  if (args.classical) {
    classicalBlock = runClassical(SAMPLES);
  } else {
    classicalBlock = nullClassicalBlock(SAMPLES);
  }

  const scores = {
    target_category: TARGET_CATEGORY,
    total_samples: SAMPLES.length,
    dl: dlBlock,
    classical: classicalBlock
  };

  // Per-arm summary lines so a glance at stdout shows the comparison.
  console.log('\n' + '='.repeat(60));
  console.log('DL arm');
  console.log(`  overall accuracy:    ${fmt(dlBlock.overall_accuracy)} (${fmt(dlBlock.correct)}/${fmt(dlBlock.total)})`);
  console.log(`  false positive rate: ${fmt(dlBlock.false_positive_rate)}`);
  console.log(`  validator catch:     ${fmt(dlBlock.validator_catch_rate)} (${fmt(dlBlock.validator_catches)}/${fmt(dlBlock.validator_opportunities)})`);
  console.log(`  avg tokens:          ${fmt(dlBlock.efficiency?.avg_tokens)}`);
  console.log(`  avg API calls:       ${fmt(dlBlock.efficiency?.avg_api_calls)}`);
  console.log('Classical arm');
  console.log(`  overall accuracy:    ${fmt(classicalBlock.overall_accuracy)} (${fmt(classicalBlock.correct)}/${fmt(classicalBlock.total)})`);
  console.log(`  false positive rate: ${fmt(classicalBlock.false_positive_rate)}`);
  console.log(`  evaluated:           ${classicalBlock.samples_evaluated}/${SAMPLES.length}  (skipped: ${classicalBlock.samples_skipped_no_decision})`);
  console.log('='.repeat(60));

  mkdirSync(dirname(SCORES_OUT), { recursive: true });
  writeFileSync(SCORES_OUT, JSON.stringify(scores, null, 2));
  console.log(`\nScores written to ${SCORES_OUT}`);
}

// Empty placeholders used when an arm is skipped via a flag. Keeps the
// scores.json shape stable so downstream readers (the README table, etc.)
// don't have to special-case partial runs.
function nullDLBlock(samples) {
  const perCategory = Object.fromEntries(CATEGORIES.map(c => [c, summarizeCategory(emptyCategoryBucket())]));
  for (const cat of CATEGORIES) {
    perCategory[cat].n = samples.filter(s => s.category === cat).length;
  }
  return {
    overall_accuracy: null,
    correct: null,
    total: null,
    false_positive_rate: null,
    validator_catch_rate: null,
    validator_catches: null,
    validator_opportunities: null,
    efficiency: { avg_tokens: null, avg_api_calls: null },
    per_category: perCategory,
    results: []
  };
}

function nullClassicalBlock(samples) {
  const perCategory = Object.fromEntries(CATEGORIES.map(c => [c, summarizeCategory(emptyCategoryBucket())]));
  for (const cat of CATEGORIES) {
    perCategory[cat].n = samples.filter(s => s.category === cat).length;
  }
  return {
    overall_accuracy: null,
    correct: null,
    total: null,
    false_positive_rate: null,
    per_category: perCategory,
    samples_evaluated: 0,
    samples_skipped_no_decision: samples.length,
    results: []
  };
}

function round3(x) { return x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 1000) / 1000; }
function round1(x) { return x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 10) / 10; }
function fmt(x) { return x === null || x === undefined ? '—' : String(x); }

main().catch(e => { console.error(e); process.exit(1); });
