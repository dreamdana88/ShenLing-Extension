import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { configureCaptureWorkflow, getWorkflowOption } from '../src/features/memoir/runtime.js';

const memoirDir = fileURLToPath(new URL('../src/features/memoir/', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const TARGET_MODULES = [
  'runtime.js',
  'extraction.js',
  'pending.js',
  'memoir-commit.js',
  'capture-material.js',
  'capture-generation.js',
  'capture-commit.js',
  'workflow.js',
  'worldbook-manager.js',
  'panel.js',
];

const MOVED_FROM_WORKFLOW = [
  'configureCaptureWorkflow',
  'tryExtractMemoirFromGrandSummary',
  'stageMemoirCandidates',
  'discardMemoirPending',
  'commitMemoirCandidates',
  'buildCaptureSourceMaterial',
  'runCaptureGeneration',
  'commitCaptureDrafts',
  'CAPTURE_GENERATION_TIMEOUT_MS',
  'MAX_CAPTURE_CHAT_MESSAGES',
  'parseCaptureGenerationResponse',
  'prepareCaptureGeneration',
];

async function readMemoir(name) {
  return readFile(path.join(memoirDir, name), 'utf8');
}

function collectStaticImports(source) {
  return [...source.matchAll(/(?:import\s+[\s\S]*?\s+from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)]
    .map(match => match[1]);
}

function collectLocalImports(source) {
  return collectStaticImports(source)
    .filter(spec => spec.startsWith('./') && spec.endsWith('.js'))
    .map(spec => path.posix.basename(spec));
}

function hasExportDefinition(source, name) {
  return [
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`),
    new RegExp(`export\\s+const\\s+${name}\\b`),
    new RegExp(`export\\s+\\{[^}]*\\b${name}\\b[^}]*\\}`),
  ].some(pattern => pattern.test(source));
}

function detectCycles(graph) {
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  function dfs(node) {
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      return [...stack.slice(start), node];
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

test('Phase 6C target modules exist', async () => {
  for (const name of TARGET_MODULES) {
    assert.ok((await readMemoir(name)).length > 0, `${name} should exist`);
  }
});

test('workflow.js only keeps manual extract orchestration', async () => {
  const workflow = await readMemoir('workflow.js');
  assert.match(workflow, /export async function runManualMemoirExtraction/);
  for (const name of MOVED_FROM_WORKFLOW) {
    assert.equal(
      hasExportDefinition(workflow, name),
      false,
      `workflow.js must not export ${name}`,
    );
  }
  assert.equal(/export\s+\*\s+from\s+['"]\.\//.test(workflow), false);
  assert.equal(/export\s*\{[\s\S]{120,}\}\s*from\s*['"]\.\//.test(workflow), false);
});

test('production consumers import from duty owners', async () => {
  const index = await readFile(path.join(repoRoot, 'index.js'), 'utf8');
  assert.match(index, /from ['"]\.\/src\/features\/memoir\/runtime\.js['"]/);
  assert.match(index, /configureCaptureWorkflow/);

  const panel = await readMemoir('panel.js');
  assert.match(panel, /from ['"]\.\/capture-material\.js['"]/);
  assert.match(panel, /from ['"]\.\/capture-generation\.js['"]/);
  assert.match(panel, /from ['"]\.\/capture-commit\.js['"]/);
  assert.match(panel, /from ['"]\.\/memoir-commit\.js['"]/);
  assert.match(panel, /from ['"]\.\/pending\.js['"]/);
  assert.match(panel, /from ['"]\.\/workflow\.js['"]/);
  const panelBlocks = [...panel.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*['"](\.\/[^'"]+)['"]/g)];
  const workflowNames = panelBlocks
    .filter(match => match[2] === './workflow.js')
    .flatMap(match => match[1].split(',').map(part => part.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean));
  assert.deepEqual(workflowNames, ['runManualMemoirExtraction']);

  const archive = await readFile(path.join(repoRoot, 'src/features/summary/archive.js'), 'utf8');
  assert.match(archive, /from ['"]\.\.\/memoir\/extraction\.js['"]/);
  assert.match(archive, /from ['"]\.\.\/memoir\/pending\.js['"]/);
  assert.equal(/from ['"]\.\.\/memoir\/workflow\.js['"]/.test(archive), false);
});

test('Memoir static import graph is acyclic and respects contracts', async () => {
  const nodes = TARGET_MODULES.filter(name => name !== 'panel.js');
  const graph = new Map();
  for (const name of nodes) {
    const source = await readMemoir(name);
    graph.set(name, collectLocalImports(source).filter(item => nodes.includes(item)));
  }
  const cycle = detectCycles(graph);
  assert.equal(cycle, null, cycle ? `cycle: ${cycle.join(' -> ')}` : '');

  const runtime = await readMemoir('runtime.js');
  assert.equal(collectLocalImports(runtime).length, 0);

  const extraction = await readMemoir('extraction.js');
  assert.deepEqual(collectLocalImports(extraction), ['worldbook-manager.js']);

  const pending = await readMemoir('pending.js');
  assert.equal(collectLocalImports(pending).length, 0);

  const memoirCommit = await readMemoir('memoir-commit.js');
  assert.deepEqual(collectLocalImports(memoirCommit), ['worldbook-manager.js']);

  const captureMaterial = await readMemoir('capture-material.js');
  assert.equal(collectLocalImports(captureMaterial).length, 0);

  const captureGeneration = await readMemoir('capture-generation.js');
  for (const forbidden of ['pending.js', 'memoir-commit.js', 'capture-commit.js', 'workflow.js', 'panel.js']) {
    assert.equal(collectLocalImports(captureGeneration).includes(forbidden), false);
  }

  const captureCommit = await readMemoir('capture-commit.js');
  assert.deepEqual(collectLocalImports(captureCommit), ['worldbook-manager.js']);

  const workflow = await readMemoir('workflow.js');
  assert.deepEqual(
    collectLocalImports(workflow).sort(),
    ['extraction.js', 'pending.js'].sort(),
  );

  const worldbook = await readMemoir('worldbook-manager.js');
  for (const forbidden of [
    'runtime.js',
    'extraction.js',
    'pending.js',
    'memoir-commit.js',
    'capture-material.js',
    'capture-generation.js',
    'capture-commit.js',
    'workflow.js',
    'panel.js',
  ]) {
    assert.equal(collectLocalImports(worldbook).includes(forbidden), false);
  }
});

test('single definitions, single workflowOptions, no dual track', async () => {
  const names = (await readdir(memoirDir)).filter(name => name.endsWith('.js'));
  for (const name of names) {
    assert.equal(/_old|_legacyCopy|backup/i.test(name), false, `backup file: ${name}`);
  }

  const symbols = {
    configureCaptureWorkflow: 'runtime.js',
    getWorkflowOption: 'runtime.js',
    tryExtractMemoirFromGrandSummary: 'extraction.js',
    buildSourceKey: 'extraction.js',
    stageMemoirCandidates: 'pending.js',
    commitMemoirCandidates: 'memoir-commit.js',
    buildCaptureSourceMaterial: 'capture-material.js',
    runCaptureGeneration: 'capture-generation.js',
    commitCaptureDrafts: 'capture-commit.js',
    runManualMemoirExtraction: 'workflow.js',
  };
  for (const [symbol, owner] of Object.entries(symbols)) {
    const owners = [];
    for (const name of names) {
      if (hasExportDefinition(await readMemoir(name), symbol)) owners.push(name);
    }
    assert.deepEqual(owners, [owner], `${symbol} owners=${owners.join(',')}`);
  }

  let workflowOptionsDefs = 0;
  for (const name of names) {
    if (/let\s+workflowOptions\b/.test(await readMemoir(name))) workflowOptionsDefs += 1;
  }
  assert.equal(workflowOptionsDefs, 1);
});

test('runtime configureCaptureWorkflow is a single ESM singleton', () => {
  configureCaptureWorkflow({ addCommunicationLog: () => 1 });
  configureCaptureWorkflow({ getActiveApiProfile: () => ({ name: 'p' }) });
  assert.equal(typeof getWorkflowOption('addCommunicationLog'), 'function');
  assert.equal(typeof getWorkflowOption('getActiveApiProfile'), 'function');
  assert.equal(getWorkflowOption('missing'), null);
  assert.equal(getWorkflowOption('addCommunicationLog')(), 1);
});
