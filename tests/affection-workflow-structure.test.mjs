import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { registerAffectionInjectionEvents } from '../src/features/affection/injection.js';
import {
  commitAffectionUpdateFromConfirmedSummary,
  commitSelectedPendingAffectionUpdates,
  parseAffectionUpdateFromMemory,
} from '../src/features/affection/lifecycle.js';
import {
  configureAffectionWorkflow,
  isAffectionAnalysisActive,
} from '../src/features/affection/runtime.js';
import { registerAffectionWorkflowEvents } from '../src/features/affection/workflow.js';
import { AFFECTION_TRANSPORT_POLICY } from '../src/features/affection/generation.js';

const affectionDir = fileURLToPath(new URL('../src/features/affection/', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const TARGET_MODULES = [
  'model.js',
  'runtime.js',
  'profile.js',
  'generation.js',
  'manual-profile.js',
  'lifecycle.js',
  'injection.js',
  'workflow.js',
  'panel.js',
];

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

test('Phase 6B/C affection modules exist', async () => {
  for (const name of TARGET_MODULES) {
    const source = await readAffection(name);
    assert.ok(source.length > 0, `${name} should exist`);
  }
});

test('lifecycle no longer exports auto first-build API', async () => {
  const lifecycle = await readAffection('lifecycle.js');
  for (const name of [
    'startAffectionProfileBuildsForPending',
    'retryAffectionBuildTask',
    'updateAffectionBuildTaskInitialValue',
    'useGenericAffectionBuildTask',
    'createAffectionBuildTaskKey',
  ]) {
    assert.equal(hasExportDefinition(lifecycle, name), false, `${name} must be removed`);
  }
  assert.match(lifecycle, /export function markAffectionStoreUpdated/);
  assert.match(lifecycle, /export function parseAffectionUpdateFromMemory/);
  assert.match(lifecycle, /export async function commitAffectionUpdateFromConfirmedSummary/);
  assert.match(lifecycle, /export async function commitSelectedPendingAffectionUpdates/);
  assert.doesNotMatch(lifecycle, /buildTasks/);
  assert.match(lifecycle, /retired_affection_first_ignored|change_without_profile/);
});

test('production consumers import from duty owners', async () => {
  const index = await readFile(path.join(repoRoot, 'index.js'), 'utf8');
  assert.match(index, /from ['"]\.\/src\/features\/affection\/runtime\.js['"]/);
  assert.match(index, /from ['"]\.\/src\/features\/affection\/workflow\.js['"]/);

  const effects = await readFile(path.join(repoRoot, 'src/features/summary/confirmed-effects.js'), 'utf8');
  assert.match(effects, /from ['"]\.\.\/affection\/lifecycle\.js['"]/);
  assert.doesNotMatch(effects, /AFFECTION_TRANSPORT_POLICY/);
  assert.doesNotMatch(effects, /transportPolicy/);
});

test('Affection static import graph is acyclic', async () => {
  const graph = new Map();
  for (const name of TARGET_MODULES.filter(item => item !== 'panel.js')) {
    const source = await readAffection(name);
    graph.set(
      name,
      collectLocalImports(source).filter(item => TARGET_MODULES.includes(item)),
    );
  }
  // generation may dynamic-import manual-profile; static graph should still be acyclic
  const cycle = detectCycles(graph);
  assert.equal(cycle, null, cycle ? `cycle detected: ${cycle.join(' -> ')}` : '');
});

test('no dual production definitions for markAffectionStoreUpdated', async () => {
  const names = await readdir(affectionDir);
  let definitions = 0;
  let owners = [];
  for (const name of names.filter(item => item.endsWith('.js'))) {
    const source = await readAffection(name);
    if (hasExportDefinition(source, 'markAffectionStoreUpdated')) {
      definitions += 1;
      owners.push(name);
    }
  }
  assert.equal(definitions, 1, `owners=${owners.join(',')}`);
  assert.equal(owners[0], 'lifecycle.js');
});

test('registerAffectionWorkflowEvents remains pending-handler based', async () => {
  const first = registerAffectionWorkflowEvents();
  const second = registerAffectionWorkflowEvents();
  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(typeof registerAffectionInjectionEvents(), 'boolean');
});

test('runtime gate remains and transport is configured-only', () => {
  assert.equal(typeof configureAffectionWorkflow, 'function');
  assert.equal(typeof isAffectionAnalysisActive, 'function');
  assert.equal(typeof commitAffectionUpdateFromConfirmedSummary, 'function');
  assert.equal(typeof commitSelectedPendingAffectionUpdates, 'function');
  assert.equal(typeof parseAffectionUpdateFromMemory, 'function');
  assert.equal(AFFECTION_TRANSPORT_POLICY.CONFIGURED, 'configured');
  assert.equal(Object.hasOwn(AFFECTION_TRANSPORT_POLICY, 'LEGACY'), false);
  assert.equal(isAffectionAnalysisActive({
    enabled: true,
    modules: {
      summary: { enabled: true },
      affection: { enabled: true, mode: 'normal' },
    },
  }), true);
});
