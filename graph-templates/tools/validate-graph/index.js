#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function readJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadRegistry(templatesRoot) {
  const registryPath = path.join(templatesRoot, 'template-registry.json');
  const registry = readJson(registryPath);
  if (!registry) {
    throw new Error(`Could not read ${registryPath} — run this from a checkout that has graph-templates/template-registry.json`);
  }
  const byId = new Map();
  for (const entry of registry.templates || []) byId.set(entry.id, entry);
  return byId;
}

function topoCheckCycles(nodeIds, edgesByNode) {
  const state = new Map(nodeIds.map((id) => [id, 0])); // 0=unvisited,1=visiting,2=done
  const cyclePath = [];
  let cycle = null;

  function visit(id, stack) {
    if (cycle) return;
    const s = state.get(id);
    if (s === 1) {
      cycle = [...stack, id];
      return;
    }
    if (s === 2) return;
    state.set(id, 1);
    for (const dep of edgesByNode.get(id) || []) {
      visit(dep, [...stack, id]);
      if (cycle) return;
    }
    state.set(id, 2);
  }

  for (const id of nodeIds) {
    if (state.get(id) === 0) visit(id, []);
    if (cycle) break;
  }
  return cycle;
}

function validate(projectDir, templatesRoot) {
  const errors = [];
  const warnings = [];
  const repairs = [];

  const registry = loadRegistry(templatesRoot);

  const architecture = readJson(path.join(projectDir, 'architecture.json'));
  if (!architecture) {
    errors.push({ check: 'invalid-schemas', message: 'architecture.json missing or not valid JSON at project root' });
    return { valid: false, errors, warnings, repairs };
  }

  const nodes = (architecture.data && architecture.data.nodes) || [];
  const edges = (architecture.data && architecture.data.edges) || [];
  const nodeIds = nodes.map((n) => n.id);
  const nodeIdSet = new Set(nodeIds);

  // Missing dependencies + build requires-edge map for cycle check
  const requiresEdges = new Map();
  for (const node of nodes) {
    const entry = registry.get(node.id);
    if (!entry) {
      errors.push({ check: 'missing-dependencies', message: `node "${node.id}" is not in the template registry` });
      continue;
    }
    const requires = (entry.dependsOn || []).filter((t) => t.relationship === 'requires').map((t) => t.id);
    requiresEdges.set(node.id, requires);
    for (const dep of requires) {
      if (!nodeIdSet.has(dep)) {
        errors.push({ check: 'missing-dependencies', message: `node "${node.id}" requires "${dep}" which is not in this project's node list` });
      }
    }
    const conflicts = (entry.dependsOn || []).filter((t) => t.relationship === 'conflicts').map((t) => t.id);
    for (const c of conflicts) {
      if (nodeIdSet.has(c)) {
        errors.push({ check: 'duplicate-functionality', message: `node "${node.id}" conflicts with "${c}", both are present in this project` });
      }
    }
  }

  // Circular dependencies
  const cycle = topoCheckCycles(nodeIds, requiresEdges);
  if (cycle) {
    errors.push({ check: 'circular-dependencies', message: `dependency cycle: ${cycle.join(' -> ')}` });
  }

  // Invalid connections (edges[])
  for (const edge of edges) {
    if (!nodeIdSet.has(edge.from) || !nodeIdSet.has(edge.to)) {
      errors.push({ check: 'invalid-connections', message: `edge ${edge.from} -> ${edge.to} references a node not in this project` });
    }
  }

  // Orphan nodes: nothing requires/extends them, nothing in edges points to them, and they aren't a
  // project.* root. Most categories are LEGITIMATELY leaves in a requires-DAG (a devops/testing/docs/
  // auth-flow/api-route node is a terminal feature, not a library other nodes build on — nothing is
  // expected to "require" it). Only the structural composition layers (backend.repository/service/
  // controller, meant to be wired into something further downstream) are flagged, since "generated but
  // never composed into a route" there is an actual bug signal, not normal graph shape.
  const ORPHAN_CHECKED_CATEGORIES = new Set(['backend']);
  const referenced = new Set();
  for (const deps of requiresEdges.values()) for (const d of deps) referenced.add(d);
  for (const edge of edges) referenced.add(edge.to);
  for (const node of nodes) {
    const isRoot = node.id.startsWith('project.');
    const entry = registry.get(node.id);
    const checkable = entry && ORPHAN_CHECKED_CATEGORIES.has(entry.category);
    if (!isRoot && checkable && !referenced.has(node.id)) {
      warnings.push({ check: 'orphan-nodes', message: `node "${node.id}" is generated but nothing depends on or connects to it` });
    }
  }

  // Missing environment variables
  const envExamplePath = path.join(projectDir, '.env.example');
  const envExample = fs.existsSync(envExamplePath) ? fs.readFileSync(envExamplePath, 'utf8') : '';
  for (const node of nodes) {
    const entry = registry.get(node.id);
    if (!entry) continue;
    for (const v of entry.environment || []) {
      if (v.required && !envExample.includes(`${v.name}=`) && !envExample.includes(`${v.name} =`)) {
        warnings.push({ check: 'missing-environment-variables', message: `"${v.name}" (required by ${node.id}) is not documented in .env.example` });
        repairs.push({ check: 'missing-environment-variables', message: `add "${v.name}=" to .env.example`, nodeId: node.id });
      }
    }
  }

  // Version conflicts (manifest vs registry)
  const manifest = readJson(path.join(projectDir, '.graph', 'manifest.json'));
  if (manifest && manifest.nodes) {
    for (const [id, info] of Object.entries(manifest.nodes)) {
      const entry = registry.get(id);
      if (!entry) continue;
      const [installedMajor] = String(info.version || '0.0.0').split('.').map(Number);
      const [currentMajor] = String(entry.version || '0.0.0').split('.').map(Number);
      if (currentMajor > installedMajor) {
        warnings.push({ check: 'version-conflicts', message: `"${id}" is installed at v${info.version}, registry is at v${entry.version} (major bump — see the template's README "Migrating from" section)` });
      }
    }
  }

  // Missing tests
  const testSchema = readJson(path.join(projectDir, 'test.json'));
  const coveredNodeIds = new Set(((testSchema && testSchema.data && testSchema.data.suites) || []).map((s) => s.nodeId));
  for (const node of nodes) {
    const entry = registry.get(node.id);
    if (entry && entry.testing && entry.testing.strategy && entry.testing.strategy !== 'none' && !coveredNodeIds.has(node.id)) {
      warnings.push({ check: 'missing-tests', message: `node "${node.id}" has no entry in test.json data.suites` });
    }
  }

  return { valid: errors.length === 0, errors, warnings, repairs };
}

function main() {
  const projectDir = path.resolve(process.argv[2] || '.');
  const templatesRoot = path.resolve(process.argv[3] || path.join(__dirname, '..', '..'));
  const result = validate(projectDir, templatesRoot);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.valid ? 0 : 1);
}

main();
