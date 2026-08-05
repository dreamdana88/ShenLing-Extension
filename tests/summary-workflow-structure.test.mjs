import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const summaryDir = fileURLToPath(new URL('../src/features/summary/', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const TARGET_MODULES = [
  'runtime.js',
  'generation.js',
  'state.js',
  'manual-guard.js',
  'manual.js',
  'archive.js',
  'workflow.js',
];

const MOVED_PUBLIC_FROM_WORKFLOW = [
  'configureSummaryWorkflow',
  'notifySummary',
  'generateSummaryMemory',
  'SUMMARY_TRANSPORT_POLICY',
  'MANUAL_SUMMARY_GENERATION_TIMEOUT_MS',
  'resolveSummaryTransportPlan',
  'createSimpleFingerprint',
  'markSummaryWriteIgnored',
  'clearSummaryWriteIgnored',
  'scanExistingSummaryState',
  'clearStaleSummaryRunningTask',
  'getAutoSummaryFingerprint',
  'summarizeOpeningMessage',
  'regenerateMemoryForMessage',
  'regenerateLatestGrandMemory',
  'processAutoGrandMemory',
  'processTotalGrandMemory',
  'processLegacyGrandArchive',
  'buildArchiveMemoryMaterial',
  'MANUAL_CHAT_GUARD_REASON',
];

async function readSummary(name) {
  return readFile(path.join(summaryDir, name), 'utf8');
}

function collectStaticImports(source) {
  const imports = [];
  const re = /(?:import\s+[\s\S]*?\s+from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;
  let match = re.exec(source);
  while (match) {
    imports.push(match[1]);
    match = re.exec(source);
  }
  return imports;
}

function collectLocalSummaryImports(source) {
  return collectStaticImports(source)
    .filter(spec => spec.startsWith('./') && spec.endsWith('.js'))
    .map(spec => path.posix.basename(spec));
}

function assertNoForbiddenImports(source, forbidden, label) {
  const imports = collectStaticImports(source);
  for (const rule of forbidden) {
    const hit = imports.some(spec => rule.test(spec));
    assert.equal(hit, false, `${label} must not import ${rule}`);
  }
}

function hasExportDefinition(source, name) {
  const patterns = [
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`),
    new RegExp(`export\\s+const\\s+${name}\\b`),
    new RegExp(`export\\s+\\{[^}]*\\b${name}\\b[^}]*\\}`),
  ];
  return patterns.some(pattern => pattern.test(source));
}

function detectCycles(graph) {
  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  function dfs(node) {
    if (visiting.has(node)) {
      const cycleStart = stack.indexOf(node);
      return [...stack.slice(cycleStart), node];
    }
    if (visited.has(node)) return null;
    visiting.add(node);
    stack.push(node);
    for (const next of graph.get(node) || []) {
      const cycle = dfs(next);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
    return null;
  }

  for (const node of graph.keys()) {
    const cycle = dfs(node);
    if (cycle) return cycle;
  }
  return null;
}

test('Phase 6A target modules exist', async () => {
  for (const name of TARGET_MODULES) {
    const source = await readSummary(name);
    assert.ok(source.length > 0, `${name} should exist`);
  }
});

test('workflow.js no longer defines moved public symbols', async () => {
  const workflow = await readSummary('workflow.js');
  for (const name of MOVED_PUBLIC_FROM_WORKFLOW) {
    assert.equal(
      hasExportDefinition(workflow, name),
      false,
      `workflow.js must not export moved symbol ${name}`,
    );
  }
  assert.match(workflow, /export function shouldRunAutoSummary/);
  assert.match(workflow, /export async function generateConfirmedSummaryForTask/);
  assert.match(workflow, /export function registerImmediateWordReplaceEvents/);
});

test('production consumers import from duty owners', async () => {
  const index = await readFile(path.join(repoRoot, 'index.js'), 'utf8');
  assert.match(index, /from ['"]\.\/src\/features\/summary\/runtime\.js['"]/);
  assert.match(index, /from ['"]\.\/src\/features\/summary\/state\.js['"]/);
  assert.match(index, /from ['"]\.\/src\/features\/summary\/workflow\.js['"]/);
  assert.match(index, /configureSummaryWorkflow/);
  assert.match(index, /clearStaleSummaryRunningTask/);
  assert.match(index, /generateConfirmedSummaryForTask/);

  const panel = await readSummary('panel.js');
  assert.match(panel, /from ['"]\.\/generation\.js['"]/);
  assert.match(panel, /from ['"]\.\/runtime\.js['"]/);
  assert.match(panel, /from ['"]\.\/state\.js['"]/);
  assert.match(panel, /from ['"]\.\/manual\.js['"]/);
  assert.match(panel, /from ['"]\.\/archive\.js['"]/);
  assert.equal(/from ['"]\.\/workflow\.js['"]/.test(panel), false);

  const consumer = await readSummary('confirmed-consumer.js');
  assert.match(consumer, /from ['"]\.\/state\.js['"]/);
  assert.match(consumer, /from ['"]\.\/workflow\.js['"]/);
  assert.match(consumer, /getAutoSummaryFingerprint/);
  assert.match(consumer, /shouldRunAutoSummary/);

  const effects = await readSummary('confirmed-effects.js');
  assert.match(effects, /from ['"]\.\/archive\.js['"]/);
  assert.match(effects, /processAutoGrandMemory/);
  assert.equal(/from ['"]\.\/workflow\.js['"]/.test(effects), false);

  const wordReplace = await readFile(path.join(repoRoot, 'src/features/word-replace/panel.js'), 'utf8');
  assert.match(wordReplace, /from ['"]\.\.\/summary\/state\.js['"]/);

  const memoirPanel = await readFile(path.join(repoRoot, 'src/features/memoir/panel.js'), 'utf8');
  assert.match(memoirPanel, /from ['"]\.\.\/summary\/generation\.js['"]/);
});

test('Summary static import graph is acyclic and respects contracts', async () => {
  const graph = new Map();
  for (const name of TARGET_MODULES) {
    const source = await readSummary(name);
    graph.set(name, collectLocalSummaryImports(source).filter(item => TARGET_MODULES.includes(item)));
  }

  const cycle = detectCycles(graph);
  assert.equal(cycle, null, cycle ? `cycle detected: ${cycle.join(' -> ')}` : '');

  const runtime = await readSummary('runtime.js');
  assertNoForbiddenImports(runtime, [
    /^\.\/generation\.js$/,
    /^\.\/state\.js$/,
    /^\.\/manual-guard\.js$/,
    /^\.\/manual\.js$/,
    /^\.\/archive\.js$/,
    /^\.\/workflow\.js$/,
    /^\.\/panel\.js$/,
    /^\.\/confirmed-/,
  ], 'runtime.js');
  assert.equal(collectLocalSummaryImports(runtime).length, 0);

  const generation = await readSummary('generation.js');
  assertNoForbiddenImports(generation, [
    /^\.\/state\.js$/,
    /^\.\/manual-guard\.js$/,
    /^\.\/manual\.js$/,
    /^\.\/archive\.js$/,
    /^\.\/workflow\.js$/,
    /^\.\/panel\.js$/,
    /^\.\/confirmed-/,
  ], 'generation.js');
  assert.deepEqual(collectLocalSummaryImports(generation), ['runtime.js']);

  const state = await readSummary('state.js');
  assertNoForbiddenImports(state, [
    /^\.\/generation\.js$/,
    /^\.\/manual-guard\.js$/,
    /^\.\/manual\.js$/,
    /^\.\/archive\.js$/,
    /^\.\/workflow\.js$/,
    /^\.\/panel\.js$/,
    /^\.\/confirmed-/,
    /affection\/workflow/,
    /emotion-profile\/workflow/,
    /plot-outline\/workflow/,
    /memoir\/workflow/,
  ], 'state.js');

  const guard = await readSummary('manual-guard.js');
  assertNoForbiddenImports(guard, [
    /^\.\/generation\.js$/,
    /^\.\/manual\.js$/,
    /^\.\/archive\.js$/,
    /^\.\/workflow\.js$/,
    /^\.\/panel\.js$/,
    /^\.\/confirmed-/,
  ], 'manual-guard.js');

  const manual = await readSummary('manual.js');
  assertNoForbiddenImports(manual, [
    /^\.\/workflow\.js$/,
    /^\.\/panel\.js$/,
    /^\.\/confirmed-consumer\.js$/,
    /^\.\/confirmed-effects\.js$/,
    /memoir\/workflow/,
  ], 'manual.js');

  const archive = await readSummary('archive.js');
  assertNoForbiddenImports(archive, [
    /^\.\/manual\.js$/,
    /^\.\/workflow\.js$/,
    /^\.\/panel\.js$/,
    /^\.\/confirmed-consumer\.js$/,
    /^\.\/confirmed-effects\.js$/,
    /affection\/workflow/,
  ], 'archive.js');

  const workflow = await readSummary('workflow.js');
  assertNoForbiddenImports(workflow, [
    /^\.\/manual\.js$/,
    /^\.\/manual-guard\.js$/,
    /^\.\/panel\.js$/,
    /^\.\/confirmed-consumer\.js$/,
    /^\.\/confirmed-effects\.js$/,
    /memoir\/workflow/,
  ], 'workflow.js');
});

test('no backup dual implementations or large workflow re-export barrel', async () => {
  const names = await readdir(summaryDir);
  for (const name of names) {
    assert.equal(/_old|_legacyCopy|backup/i.test(name), false, `unexpected backup file: ${name}`);
  }

  const workflow = await readSummary('workflow.js');
  assert.equal(/export\s*\{[\s\S]{200,}\}\s*from\s*['"]\.\/(manual|archive|state|generation)/.test(workflow), false);
  assert.equal(/export\s+\*\s+from\s+['"]\.\//.test(workflow), false);

  // Each moved public symbol should have exactly one production definition under summary/.
  const productionFiles = names.filter(name => name.endsWith('.js'));
  for (const symbol of [
    'configureSummaryWorkflow',
    'generateSummaryMemory',
    'processAutoGrandMemory',
    'summarizeOpeningMessage',
    'buildArchiveMemoryMaterial',
    'scanExistingSummaryState',
  ]) {
    let definitions = 0;
    for (const name of productionFiles) {
      const source = await readSummary(name);
      if (hasExportDefinition(source, symbol)) definitions += 1;
    }
    assert.equal(definitions, 1, `${symbol} should have exactly one production export, got ${definitions}`);
  }
});
