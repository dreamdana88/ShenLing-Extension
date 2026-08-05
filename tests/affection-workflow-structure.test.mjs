import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { registerAffectionInjectionEvents } from '../src/features/affection/injection.js';
import {
  commitAffectionUpdateFromConfirmedSummary,
  startAffectionProfileBuildsForPending,
} from '../src/features/affection/lifecycle.js';
import {
  configureAffectionWorkflow,
  isAffectionAnalysisActive,
} from '../src/features/affection/runtime.js';
import { registerAffectionWorkflowEvents } from '../src/features/affection/workflow.js';

const affectionDir = fileURLToPath(new URL('../src/features/affection/', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const TARGET_MODULES = [
  'model.js',
  'runtime.js',
  'profile.js',
  'generation.js',
  'lifecycle.js',
  'injection.js',
  'workflow.js',
  'panel.js',
];

const MOVED_FROM_WORKFLOW = [
  'configureAffectionWorkflow',
  'isAffectionAnalysisActive',
  'createGenericAffectionStages',
  'normalizeAffectionProfileStages',
  'AFFECTION_TRANSPORT_POLICY',
  'AFFECTION_PROFILE_BUILD_TIMEOUT_MS',
  'runAffectionProfileBuildApiPreview',
  'startAffectionProfileBuildsForPending',
  'commitAffectionUpdateFromConfirmedSummary',
  'commitSelectedPendingAffectionUpdates',
  'parseAffectionUpdateFromMemory',
  'prepareAffectionUpdateFromSummaryResult',
  'storePendingAffectionUpdate',
  'syncAffectionInjection',
  'buildAffectionInjection',
  'AFFECTION_STATE_PROMPT_ID',
  'createAffectionBuildTaskKey',
  'createBuildRequestId',
  'createProfileDraft',
  'markAffectionStoreUpdated',
  'parseAffectionProfileResponse',
  'buildAffectionStageBehaviorText',
];

const INTERNAL_BRIDGES = {
  'profile.js': [
    'buildAffectionStageBehaviorText',
    'parseAffectionProfileResponse',
    'createProfileDraft',
  ],
  'generation.js': [
    'createBuildRequestId',
    'resolveAffectionProfileContext',
    'executeCustomAffectionProfileBuild',
    'logAffectionProfileBuild',
  ],
  'lifecycle.js': [
    'markAffectionStoreUpdated',
  ],
};

async function readAffection(name) {
  return readFile(path.join(affectionDir, name), 'utf8');
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

test('Phase 6B target modules exist', async () => {
  for (const name of TARGET_MODULES) {
    const source = await readAffection(name);
    assert.ok(source.length > 0, `${name} should exist`);
  }
});

test('workflow.js no longer defines moved public symbols', async () => {
  const workflow = await readAffection('workflow.js');
  for (const name of MOVED_FROM_WORKFLOW) {
    assert.equal(
      hasExportDefinition(workflow, name),
      false,
      `workflow.js must not export moved symbol ${name}`,
    );
  }
  assert.match(workflow, /export async function adjustAffectionProfileValue/);
  assert.match(workflow, /export async function regenerateAffectionProfileStages/);
  assert.match(workflow, /export function buildAffectionUpdatePromptSection/);
  assert.match(workflow, /export function registerAffectionWorkflowEvents/);
});

test('production consumers import from duty owners', async () => {
  const index = await readFile(path.join(repoRoot, 'index.js'), 'utf8');
  assert.match(index, /from ['"]\.\/src\/features\/affection\/runtime\.js['"]/);
  assert.match(index, /from ['"]\.\/src\/features\/affection\/workflow\.js['"]/);
  assert.match(index, /configureAffectionWorkflow/);
  assert.match(index, /registerAffectionWorkflowEvents/);

  const panel = await readAffection('panel.js');
  assert.match(panel, /from ['"]\.\/generation\.js['"]/);
  assert.match(panel, /from ['"]\.\/injection\.js['"]/);
  assert.match(panel, /from ['"]\.\/lifecycle\.js['"]/);
  assert.match(panel, /from ['"]\.\/profile\.js['"]/);
  assert.match(panel, /from ['"]\.\/workflow\.js['"]/);
  assert.match(panel, /from ['"]\.\/model\.js['"]/);
  const panelImportBlocks = [...panel.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*['"](\.\/[^'"]+)['"]/g)];
  const workflowImportNames = panelImportBlocks
    .filter(match => match[2] === './workflow.js')
    .flatMap(match => match[1].split(',').map(part => part.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean));
  for (const forbidden of [
    'runAffectionProfileBuildApiPreview',
    'createGenericAffectionStages',
    'startAffectionProfileBuildsForPending',
    'commitSelectedPendingAffectionUpdates',
    'syncAffectionInjection',
  ]) {
    assert.equal(
      workflowImportNames.includes(forbidden),
      false,
      `panel must not import ${forbidden} from workflow.js`,
    );
  }

  const summaryWorkflow = await readFile(path.join(repoRoot, 'src/features/summary/workflow.js'), 'utf8');
  assert.match(summaryWorkflow, /from ['"]\.\.\/affection\/lifecycle\.js['"]/);
  assert.match(summaryWorkflow, /from ['"]\.\.\/affection\/workflow\.js['"]/);
  assert.match(summaryWorkflow, /prepareAffectionUpdateFromSummaryResult/);
  assert.match(summaryWorkflow, /buildAffectionUpdatePromptSection/);

  const effects = await readFile(path.join(repoRoot, 'src/features/summary/confirmed-effects.js'), 'utf8');
  assert.match(effects, /from ['"]\.\.\/affection\/generation\.js['"]/);
  assert.match(effects, /from ['"]\.\.\/affection\/lifecycle\.js['"]/);
  assert.match(effects, /from ['"]\.\.\/affection\/runtime\.js['"]/);
});

test('Affection static import graph is acyclic and respects contracts', async () => {
  const graph = new Map();
  for (const name of TARGET_MODULES.filter(item => item !== 'panel.js')) {
    const source = await readAffection(name);
    graph.set(
      name,
      collectLocalImports(source).filter(item => TARGET_MODULES.includes(item)),
    );
  }
  const cycle = detectCycles(graph);
  assert.equal(cycle, null, cycle ? `cycle detected: ${cycle.join(' -> ')}` : '');

  const model = await readAffection('model.js');
  assert.equal(collectLocalImports(model).length, 0);

  const runtime = await readAffection('runtime.js');
  assert.equal(collectLocalImports(runtime).length, 0);

  const profile = await readAffection('profile.js');
  assert.deepEqual(collectLocalImports(profile), ['model.js']);

  const generation = await readAffection('generation.js');
  for (const forbidden of ['lifecycle.js', 'injection.js', 'workflow.js', 'panel.js']) {
    assert.equal(collectLocalImports(generation).includes(forbidden), false);
  }

  const injection = await readAffection('injection.js');
  for (const forbidden of ['generation.js', 'lifecycle.js', 'workflow.js', 'panel.js']) {
    assert.equal(collectLocalImports(injection).includes(forbidden), false);
  }

  const lifecycle = await readAffection('lifecycle.js');
  assert.equal(collectLocalImports(lifecycle).includes('workflow.js'), false);

  const workflow = await readAffection('workflow.js');
  assert.equal(collectLocalImports(workflow).includes('panel.js'), false);
});

test('no dual production definitions, backup copies, or workflow bridge re-exports', async () => {
  const names = await readdir(affectionDir);
  for (const name of names) {
    assert.equal(/_old|_legacyCopy|backup/i.test(name), false, `unexpected backup file: ${name}`);
  }

  const workflow = await readAffection('workflow.js');
  assert.equal(/export\s+\*\s+from\s+['"]\.\//.test(workflow), false);
  assert.equal(/export\s*\{[\s\S]{200,}\}\s*from\s*['"]\.\//.test(workflow), false);

  for (const [owner, symbols] of Object.entries(INTERNAL_BRIDGES)) {
    for (const symbol of symbols) {
      let definitions = 0;
      let owners = [];
      for (const name of names.filter(item => item.endsWith('.js'))) {
        const source = await readAffection(name);
        if (hasExportDefinition(source, symbol)) {
          definitions += 1;
          owners.push(name);
        }
      }
      assert.equal(definitions, 1, `${symbol} should have one export, got ${owners.join(',')}`);
      assert.equal(owners[0], owner);
      assert.equal(hasExportDefinition(workflow, symbol), false);
    }
  }

  let eventRegisteredDefs = 0;
  for (const name of names.filter(item => item.endsWith('.js'))) {
    const source = await readAffection(name);
    if (/let\s+affectionEventsRegistered\b/.test(source) || /var\s+affectionEventsRegistered\b/.test(source)) {
      eventRegisteredDefs += 1;
    }
  }
  assert.equal(eventRegisteredDefs, 1, 'affectionEventsRegistered must have one production definition');
});

test('registerAffectionWorkflowEvents return semantics stay pending-handler based', async () => {
  const first = registerAffectionWorkflowEvents();
  const second = registerAffectionWorkflowEvents();
  assert.equal(first, true);
  assert.equal(second, true);

  const injection = await readAffection('injection.js');
  const workflow = await readAffection('workflow.js');
  assert.match(workflow, /affectionPendingCommitRegistered\s*=\s*true/);
  assert.match(workflow, /return affectionPendingCommitRegistered/);
  assert.equal(/return registerAffectionInjectionEvents\(/.test(workflow), false);
  assert.match(injection, /let affectionEventsRegistered/);
  assert.equal(/let affectionEventsRegistered/.test(workflow), false);

  // injection registration remains idempotent
  assert.equal(typeof registerAffectionInjectionEvents(), 'boolean');
  assert.equal(typeof registerAffectionInjectionEvents(), 'boolean');
});

test('runtime gate and transport defaults remain frozen after split', () => {
  assert.equal(typeof configureAffectionWorkflow, 'function');
  assert.equal(typeof isAffectionAnalysisActive, 'function');
  assert.equal(typeof startAffectionProfileBuildsForPending, 'function');
  assert.equal(typeof commitAffectionUpdateFromConfirmedSummary, 'function');

  // Single ESM singleton: reconfigure merges options rather than replacing module identity.
  configureAffectionWorkflow({ refreshPanel: () => {} });
  configureAffectionWorkflow({ addCommunicationLog: () => {} });
  assert.equal(isAffectionAnalysisActive({
    enabled: true,
    modules: {
      summary: { enabled: true },
      affection: { enabled: true, mode: 'normal' },
    },
  }), true);
  assert.equal(isAffectionAnalysisActive({
    enabled: true,
    modules: {
      summary: { enabled: true },
      affection: { enabled: true, mode: 'off' },
    },
  }), false);
});
