'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { inspectSources, validateOffense, verifyProposal, writePatch, main } = require('../scripts/factory-defense.cjs');

function fixture(t, html = '<p>Fixture</p>') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sumlac-defense-test-'));
  fs.writeFileSync(path.join(root, 'index.html'), html);
  fs.mkdirSync(path.join(root, 'tests'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'tests', 'fixture.test.cjs'), `const test=require('node:test'); const assert=require('node:assert/strict'); const fs=require('node:fs'); test('fixture remains valid',()=>assert.match(fs.readFileSync('index.html','utf8'), /Fixture/));`);
  fs.writeFileSync(path.join(root, 'scripts', 'factory-offense.cjs'), `const fs=require('node:fs'),path=require('node:path'); const output=process.argv[process.argv.indexOf('--output')+1]; fs.mkdirSync(path.dirname(output),{recursive:true}); fs.writeFileSync(output,JSON.stringify({factory:'offense',status:'passed',target:{scope:'fixture'},checks:[{id:'fixture-check',status:'passed'}],findings:[]}));`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const goodOffense = () => ({ factory: 'offense', status: 'passed', target: { scope: 'local' }, checks: [{ id: 'check', status: 'passed' }], findings: [] });

test('HTML parser ignores lookalike tags in comments and scripts and recognizes encoded attributes', async t => {
  const root = fixture(t, `<!-- <a href="https://evil.example" target="_blank"> -->
    <script>const sample='<a href="https://evil.example" target="_blank">';</script>
    <a href="https://example.com" target="_blank" rel="NOOPENER">safe</a>
    <a href="https://example.com" target="_blank" rel="noreferrer">safe</a>
    <a href="/local" target="_blank">local</a>
    <a href="&#104;ttps://example.com" target="_blank">Fixture</a>`);
  const audit = await inspectSources(root);
  assert.equal(audit.externalTabs, 3);
  assert.equal(audit.findings.length, 1);
  assert.equal(audit.findings[0].confidence, 'static-confirmed');
  assert.equal(audit.changes.length, 1);
  assert.match(audit.changes[0].after, /target="_blank" rel="noopener">Fixture/);
  assert.equal(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), audit.changes[0].before);
});

test('repair preserves existing rel tokens and safely quotes the parsed attribute value', async t => {
  const root = fixture(t, `<a href="https://example.com" target="_blank" rel='external &quot;custom&quot;'>Fixture</a>`);
  const { changes } = await inspectSources(root);
  assert.match(changes[0].after, /rel="external &quot;custom&quot; noopener"/);
  fs.writeFileSync(path.join(root, 'index.html'), changes[0].after);
  assert.equal((await inspectSources(root)).findings.length, 0);
});

test('source audit distinguishes HTTP execution from remote integrity review candidates', async t => {
  const root = fixture(t, `<script src="http://example.com/bad.js"></script><script src="https://example.com/review.js"></script><script src="local.js"></script><p>Fixture</p>`);
  const { findings, changes } = await inspectSources(root);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].rule, 'script-transport');
  assert.equal(findings[0].confidence, 'static-confirmed');
  assert.equal(findings[1].confidence, 'review-candidate');
  assert.equal(changes.length, 0, 'No speculative repairs of executable dependencies');
});

test('offense intake rejects empty, malformed, or contradictory reports', () => {
  assert.throws(() => validateOffense(null));
  assert.throws(() => validateOffense({ ...goodOffense(), checks: [] }));
  assert.throws(() => validateOffense({ ...goodOffense(), checks: [{ id: 'bad', status: 'unknown' }] }));
  assert.throws(() => validateOffense({ ...goodOffense(), checks: [{ id: 'failed', status: 'failed' }] }));
  const incomplete = { ...goodOffense(), status: 'inconclusive', checks: [{ id: 'browser', status: 'inconclusive' }] };
  assert.equal(validateOffense(incomplete).status, 'inconclusive');
});

test('proposal verification reruns real tests and offense evidence without modifying the checkout', async t => {
  const root = fixture(t, '<a href="https://example.com" target="_blank">Fixture</a>');
  // A substantive regression asserts the repair really reached the temporary copy.
  fs.writeFileSync(path.join(root, 'tests', 'isolation.test.cjs'), `const test=require('node:test'); const assert=require('node:assert/strict'); const fs=require('node:fs'); test('explicit link isolation',()=>assert.match(fs.readFileSync('index.html','utf8'), /rel="noopener"/));`);
  const { changes } = await inspectSources(root);
  const verified = await verifyProposal(root, changes);
  assert.equal(verified.status, 'passed', JSON.stringify(verified));
  assert.equal(verified.checks.find(check => check.id === 'proposal-regression-tests').status, 'passed');
  assert.equal(verified.checks.find(check => check.id === 'proposal-offense-evidence').status, 'passed');
  assert.equal(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), changes[0].before);
  const patch = path.join(root, 'proposal.patch');
  writePatch(changes, patch);
  assert.equal(spawnSync('git', ['apply', '--check', patch], { cwd: root }).status, 0);
  const exactArtifact = await verifyProposal(root, changes, { patchFile: patch });
  assert.equal(exactArtifact.status, 'passed');
  assert.equal(exactArtifact.checks.find(check => check.id === 'proposal-patch-check').status, 'passed');
  assert.equal(exactArtifact.checks.find(check => check.id === 'proposal-patch-apply').status, 'passed');
  assert.equal(exactArtifact.checks.find(check => check.id === 'proposal-result-hashes').status, 'passed');
});

test('tampered or malformed emitted patches cannot be verified', async t => {
  const root = fixture(t, '<a href="https://example.com" target="_blank">Fixture</a>');
  const { changes } = await inspectSources(root);
  const patchFile = path.join(root, 'proposal.patch');
  writePatch(changes, patchFile);
  // This remains a valid patch and would satisfy source isolation, but its bytes
  // and resulting file differ from the proposal that the reviewer was given.
  fs.writeFileSync(patchFile, fs.readFileSync(patchFile, 'utf8').replace('rel="noopener"', 'rel="noreferrer"'));
  const tampered = await verifyProposal(root, changes, { patchFile });
  assert.equal(tampered.status, 'inconclusive');
  assert.match(tampered.checks.at(-1).detail, /Patch artifact differs/);
  assert.equal(tampered.checks.some(check => check.id === 'proposal-patch-apply'), false);
  fs.writeFileSync(patchFile, 'malformed patch');
  assert.equal((await verifyProposal(root, changes, { patchFile })).status, 'inconclusive');
  assert.equal(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), changes[0].before);
  const badHash = await verifyProposal(root, [{ ...changes[0], afterHash: '0'.repeat(64) }]);
  assert.equal(badHash.status, 'inconclusive');
  assert.match(badHash.checks.at(-1).detail, /proposed file hash/);
});

test('exact artifact application handles directories and filenames containing spaces and Unicode', async t => {
  const root = fixture(t);
  const directory = path.join(root, 'release notes');
  fs.mkdirSync(directory);
  const htmlFile = path.join(directory, '安全 page.html');
  fs.writeFileSync(htmlFile, '<a href="https://example.com" target="_blank">Fixture</a>');
  const { changes } = await inspectSources(root);
  assert.equal(changes[0].file, 'release notes/安全 page.html');
  const patchFile = path.join(root, 'proposal.patch');
  writePatch(changes, patchFile);
  const result = await verifyProposal(root, changes, { patchFile });
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(fs.readFileSync(htmlFile, 'utf8'), changes[0].before);
});

test('a failing regression blocks verified status and stale source or escaping paths are rejected', async t => {
  const root = fixture(t, '<a href="https://example.com" target="_blank">Fixture</a>');
  const { changes } = await inspectSources(root);
  fs.writeFileSync(path.join(root, 'tests', 'failure.test.cjs'), `require('node:test')('fails',()=>{throw new Error('Regression detected')});`);
  assert.equal((await verifyProposal(root, changes)).status, 'failed');
  fs.writeFileSync(path.join(root, 'index.html'), 'Changed Fixture');
  const stale = await verifyProposal(root, changes);
  assert.equal(stale.status, 'inconclusive');
  assert.match(stale.checks[0].detail, /Source changed/);
  const escaped = await verifyProposal(root, [{ ...changes[0], file: '../outside.html' }]);
  assert.equal(escaped.status, 'inconclusive');
  assert.match(escaped.checks[0].detail, /escapes/);
});

test('clean baseline produces no proposal and missing offense evidence remains inconclusive', async t => {
  const root = fixture(t);
  const output = path.join(root, 'artifacts', 'defense.json');
  const absent = path.join(root, 'artifacts', 'absent.json');
  assert.equal(await main(['--root', root, '--output', output, '--offense-report', absent]), 2);
  const incomplete = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(incomplete.status, 'inconclusive');
  assert.equal(incomplete.proposals.length, 0);
  assert.match(incomplete.summary, /No automatic repair/);
  fs.writeFileSync(absent, JSON.stringify(goodOffense()));
  assert.equal(await main(['--root', root, '--output', output, '--offense-report', absent]), 0);
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).status, 'passed');
  assert.equal(fs.existsSync(path.join(root, 'artifacts', 'noopener-links.patch')), false);
});
