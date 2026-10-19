'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { localURL, markdown, inspectReferences } = require('../scripts/factory-offense.cjs');

test('offense browser scope accepts only an explicit loopback HTTP origin', () => {
  assert.equal(localURL('http://127.0.0.1:8000/').origin, 'http://127.0.0.1:8000');
  for (const url of ['https://sumlac.com/', 'http://example.com/', 'file:///tmp/index.html', 'http://user:secret@127.0.0.1:8000/', 'https://127.0.0.1:8000/']) {
    assert.throws(() => localURL(url), /127\.0\.0\.1/, url);
  }
});

test('an out-of-scope target produces inconclusive evidence and a nonzero result', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sumlac-offense-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'offense.json');
  const child = spawnSync(process.execPath, ['scripts/factory-offense.cjs', '--url', 'https://example.com/', '--output', output], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 2, child.stderr);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(report.status, 'inconclusive');
  assert.equal(report.summary.passed, 0);
  assert.equal(report.checks[0].id, 'scope.loopback');
  assert.equal(report.checks[0].status, 'inconclusive');
});

test('a source run preserves check results and reproducible evidence', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sumlac-offense-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'offense.json');
  const child = spawnSync(process.execPath, ['scripts/factory-offense.cjs', '--seed', 'factory-test-seed', '--output', output], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(report.seed, 'factory-test-seed');
  assert.equal(report.status, 'passed');
  assert.equal(report.summary.total, report.checks.length);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.inconclusive, 0);
  assert.equal(report.checks.length, 3);
  assert.ok(report.checks.every(check => check.status === 'passed' && check.evidence));
  const referenceCheck = report.checks.find(check => check.id === 'source.local-references');
  assert.ok(referenceCheck.evidence.references.some(entry => new URL(entry.value, 'https://sumlac.com/').pathname === '/factory.js'));
  assert.equal(report.checks.find(check => check.id === 'source.script-syntax').evidence.executed, false);
  assert.equal(fs.existsSync(output.replace(/\.json$/, '.md')), true);
});

test('the human report preserves failures and inconclusive checks without success claims', () => {
  const report = { status: 'failed', seed: 'reproduce-this', target: 'local fixture', checks: [
    { id: 'confirmed-fixture', status: 'failed', evidence: { error: 'Expected boundary did not hold' }, reproduction: { command: 'fixture command', seed: 'reproduce-this' } },
    { id: 'unavailable-browser', status: 'inconclusive', evidence: { error: 'Runtime unavailable' } }
  ] };
  const text = markdown(report);
  assert.match(text, /Status: \*\*failed\*\*/);
  assert.match(text, /unavailable-browser \| inconclusive/);
  assert.match(text, /fixture command/);
  assert.match(text, /Expected boundary did not hold/);
});

test('local-reference audit validates cross-document fragments and catches missing assets', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sumlac-reference-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'defense-factory'));
  fs.writeFileSync(path.join(directory, 'index.html'), '<a href="/defense-factory/#thesis">Defense</a><a href="https://example.com/">External</a>');
  fs.writeFileSync(path.join(directory, 'defense-factory/index.html'), '<h1 id="thesis">Thesis</h1>');
  const references = await inspectReferences(directory, ['index.html']);
  assert.equal(references.length, 1);
  fs.writeFileSync(path.join(directory, 'defense-factory/index.html'), '<h1>No matching anchor</h1>');
  await assert.rejects(inspectReferences(directory, ['index.html']), /Missing fragment/);
  fs.writeFileSync(path.join(directory, 'index.html'), '<script src="/removed.js"></script>');
  await assert.rejects(inspectReferences(directory, ['index.html']), /Missing local reference/);
});
