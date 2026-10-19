#!/usr/bin/env node
'use strict';

// This factory examines this checkout only. It never commits, opens a PR, or
// submits traffic to public services. Suggestions are artifacts for review.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');
const http = require('node:http');

const SKIP = new Set(['.git', 'node_modules', 'artifacts']);
const statuses = new Set(['passed', 'failed', 'inconclusive']);
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const normalize = name => name.split(path.sep).join('/');

function sourceFiles(root) {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /\.html?$/i.test(entry.name)) files.push(file);
    }
  }
  walk(root);
  return files.sort();
}

function isExternalUrl(value) {
  try {
    const url = new URL(value, 'https://sumlac.com/');
    return ['http:', 'https:'].includes(url.protocol) && url.origin !== 'https://sumlac.com';
  } catch { return false; }
}

async function inspectSources(root) {
  const { parse } = await import('parse5');
  const findings = [];
  const changes = [];
  const files = sourceFiles(root);
  let externalTabs = 0;
  let externalScripts = 0;
  for (const absolute of files) {
    const file = normalize(path.relative(root, absolute));
    const source = fs.readFileSync(absolute, 'utf8');
    const document = parse(source, { sourceCodeLocationInfo: true });
    const edits = [];
    function visit(node) {
      const attrs = Object.fromEntries((node.attrs || []).map(attr => [attr.name, attr.value]));
      const location = node.sourceCodeLocation;
      if (node.tagName === 'a' && attrs.target?.trim().toLowerCase() === '_blank' && isExternalUrl(attrs.href)) {
        externalTabs++;
        const tokens = (attrs.rel || '').toLowerCase().split(/\s+/);
        if (!tokens.includes('noopener') && !tokens.includes('noreferrer')) {
          const id = `tab-isolation:${file}:${location.startLine}:${location.startCol}`;
          findings.push({ id, rule: 'external-tab-isolation', severity: 'low', confidence: 'static-confirmed', file,
            line: location.startLine, message: 'External new-tab link omits explicit opener isolation. Modern browsers often imply noopener; add it explicitly for defense in depth.',
            evidence: { href: attrs.href, target: attrs.target, rel: attrs.rel || '', source: 'HTML parsed with source locations' }, repair: 'noopener-links' });
          const rel = location.attrs?.rel;
          if (rel) {
            const value = `${attrs.rel} noopener`.trim().replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
            edits.push({ start: rel.startOffset, end: rel.endOffset, value: `rel="${value}"` });
          } else {
            const tagEnd = location.startTag.endOffset;
            const start = source[tagEnd - 2] === '/' ? tagEnd - 2 : tagEnd - 1;
            edits.push({ start, end: start, value: ' rel="noopener"' });
          }
        }
      }
      if (node.tagName === 'script' && attrs.src && isExternalUrl(attrs.src)) {
        externalScripts++;
        const url = new URL(attrs.src, 'https://sumlac.com/');
        if (url.protocol === 'http:') {
          findings.push({ id: `script-transport:${file}:${location.startLine}`, rule: 'script-transport', severity: 'high', confidence: 'static-confirmed', file,
            line: location.startLine, message: 'Executable script uses unencrypted HTTP. Review the source and HTTPS availability before changing it.', evidence: { src: attrs.src } });
        } else if (!attrs.integrity) {
          findings.push({ id: `script-integrity:${file}:${location.startLine}`, rule: 'script-integrity', severity: 'medium', confidence: 'review-candidate', file,
            line: location.startLine, message: 'Remote executable script lacks an integrity pin. Review whether this asset supports SRI; this is a supply-chain review candidate, not a demonstrated exploit.', evidence: { src: attrs.src } });
        }
      }
      for (const child of node.childNodes || []) visit(child);
      if (node.content) visit(node.content);
    }
    visit(document);
    if (edits.length) {
      let after = source;
      for (const edit of edits.sort((a, b) => b.start - a.start)) after = after.slice(0, edit.start) + edit.value + after.slice(edit.end);
      changes.push({ file, before: source, after, beforeHash: digest(source), afterHash: digest(after) });
    }
  }
  return { files: files.map(file => normalize(path.relative(root, file))), externalTabs, externalScripts, findings, changes };
}

function validateOffense(report) {
  if (!report || report.factory !== 'offense' || !statuses.has(report.status) || !Array.isArray(report.checks) || !report.checks.length || !Array.isArray(report.findings)) {
    throw new Error('Offense report has no valid factory, status, checks, or findings.');
  }
  if (report.checks.some(check => !check || typeof check.id !== 'string' || !statuses.has(check.status))) throw new Error('Offense report contains a malformed check.');
  const expected = report.checks.some(check => check.status === 'failed') ? 'failed' : report.checks.some(check => check.status === 'inconclusive') ? 'inconclusive' : 'passed';
  if (report.status !== expected) throw new Error('Offense report status contradicts its checks.');
  if (!report.target || !['object', 'string'].includes(typeof report.target)) throw new Error('Offense report is missing target information.');
  return report;
}

function runNode(args, cwd, timeout = 120000) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
  return { status: result.error ? 'inconclusive' : result.status === 0 ? 'passed' : 'failed', exitCode: result.status,
    command: ['node', ...args], stdout: result.stdout || '', stderr: result.stderr || '', error: result.error?.message };
}

async function serveLocal(root) {
  const server = http.createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      const file = path.resolve(root, `.${pathname.endsWith('/') ? `${pathname}index.html` : pathname}`);
      if (file !== root && !file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[path.extname(file)] || 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': type });
      fs.createReadStream(file).on('error', () => response.destroy()).pipe(response);
    } catch { response.writeHead(400).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

function runNodeAsync(args, cwd, timeout = 180000) {
  return new Promise(resolve => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', error;
    const timer = setTimeout(() => { error = 'Process exceeded time budget'; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-4 * 1024 * 1024); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4 * 1024 * 1024); });
    child.on('error', err => { error = err.message; });
    child.on('close', exitCode => { clearTimeout(timer); resolve({ status: error ? 'inconclusive' : exitCode === 0 ? 'passed' : 'failed', exitCode, command: ['node', ...args], stdout, stderr, error }); });
  });
}

async function verifyProposal(root, changes, { browser = false, seed = 'security-factory', patchFile } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sumlac-defense-'));
  const checks = [];
  let local;
  try {
    fs.cpSync(root, temporary, { recursive: true, filter: file => {
      const relative = path.relative(root, file);
      return !relative.split(path.sep).some(part => SKIP.has(part)) && !fs.lstatSync(file).isSymbolicLink();
    } });
    const dependencies = path.join(root, 'node_modules');
    if (fs.existsSync(dependencies)) fs.symlinkSync(dependencies, path.join(temporary, 'node_modules'), 'dir');
    for (const change of changes) {
      const destination = path.resolve(temporary, change.file);
      if (!destination.startsWith(temporary + path.sep)) throw new Error('Proposal path escapes temporary checkout');
      if (digest(fs.readFileSync(destination, 'utf8')) !== change.beforeHash) throw new Error(`Source changed since proposal: ${change.file}`);
    }
    const verificationDirectory = path.join(temporary, 'artifacts', 'patch-verification');
    fs.mkdirSync(verificationDirectory, { recursive: true });
    const expectedPatch = path.join(verificationDirectory, 'expected.patch');
    writePatch(changes, expectedPatch);
    const expectedHash = digest(fs.readFileSync(expectedPatch));
    const artifactBytes = fs.readFileSync(patchFile || expectedPatch);
    if (digest(artifactBytes) !== expectedHash) throw new Error('Patch artifact differs from the generated proposal; refusing to verify changed or malformed bytes');
    const appliedPatch = path.join(verificationDirectory, 'artifact.patch');
    fs.writeFileSync(appliedPatch, artifactBytes);
    checks.push({ id: 'proposal-patch-artifact', status: 'passed', sha256: expectedHash, detail: 'Exact emitted patch bytes match the conservative proposal and were copied into the temporary checkout' });
    for (const [id, args] of [['proposal-patch-check', ['apply', '--check', appliedPatch]], ['proposal-patch-apply', ['apply', appliedPatch]]]) {
      const result = spawnSync('git', args, { cwd: temporary, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
      const status = result.error ? 'inconclusive' : result.status === 0 ? 'passed' : 'failed';
      checks.push({ id, status, exitCode: result.status, command: ['git', ...args], stdout: result.stdout || '', stderr: result.stderr || '', error: result.error?.message });
      if (status !== 'passed') return { status, checks, browserRetested: false };
    }
    for (const change of changes) {
      const actualHash = digest(fs.readFileSync(path.join(temporary, change.file)));
      if (actualHash !== change.afterHash) throw new Error(`Applied patch does not produce the proposed file hash: ${change.file}`);
    }
    checks.push({ id: 'proposal-result-hashes', status: 'passed', detail: `${changes.length} patched files match their proposed SHA-256 hashes` });
    const audit = await inspectSources(temporary);
    const unresolved = audit.findings.filter(finding => finding.rule === 'external-tab-isolation');
    checks.push({ id: 'proposal-source-recheck', status: unresolved.length ? 'failed' : 'passed', detail: `${unresolved.length} unresolved external-tab isolation findings` });
    const tests = fs.readdirSync(path.join(temporary, 'tests')).filter(file => file.endsWith('.test.cjs')).sort().map(file => `tests/${file}`);
    if (!tests.length) throw new Error('No regression tests exist in proposal checkout');
    checks.push({ id: 'proposal-regression-tests', ...runNode(['--test', ...tests], temporary) });
    const reportFile = path.join(temporary, 'artifacts', 'proposal-offense.json');
    const args = ['scripts/factory-offense.cjs', '--output', reportFile, '--seed', seed];
    if (browser) { local = await serveLocal(temporary); args.push('--browser', '--url', local.url); }
    checks.push({ id: 'proposal-offense-retest', ...await runNodeAsync(args, temporary) });
    try {
      const report = validateOffense(JSON.parse(fs.readFileSync(reportFile, 'utf8')));
      checks.push({ id: 'proposal-offense-evidence', status: report.status, detail: `${report.checks.length} recorded offense checks; seed ${seed}` });
    } catch (error) { checks.push({ id: 'proposal-offense-evidence', status: 'inconclusive', detail: error.message }); }
    const status = checks.some(check => check.status === 'failed') ? 'failed' : checks.some(check => check.status === 'inconclusive') ? 'inconclusive' : 'passed';
    return { status, checks, isolation: 'temporary checkout removed after verification', browserRetested: browser };
  } catch (error) {
    checks.push({ id: 'proposal-verification', status: 'inconclusive', detail: error.message });
    return { status: 'inconclusive', checks, browserRetested: browser };
  } finally {
    if (local) await local.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function writePatch(changes, destination) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sumlac-patch-'));
  let patch = '';
  try {
    for (const change of changes) {
      if (path.isAbsolute(change.file) || change.file.split(/[\\/]/).some(part => part === '..') || change.file.includes('\0')) throw new Error('Proposal path escapes patch workspace');
      const beforeRelative = path.join('a', change.file), afterRelative = path.join('b', change.file);
      const before = path.join(temporary, beforeRelative), after = path.join(temporary, afterRelative);
      fs.mkdirSync(path.dirname(before), { recursive: true }); fs.mkdirSync(path.dirname(after), { recursive: true });
      fs.writeFileSync(before, change.before); fs.writeFileSync(after, change.after);
      const diff = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--no-prefix', '--', beforeRelative, afterRelative], { cwd: temporary, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      if (diff.status !== 1) throw new Error('Could not generate reviewable patch');
      if (!diff.stdout.split('\n').some(line => line.startsWith('@@'))) throw new Error('Patch contains no hunk');
      // Preserve Git's own path quoting, including spaces, tabs, and Unicode.
      patch += diff.stdout;
    }
    fs.writeFileSync(destination, patch);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

async function main(argv = process.argv.slice(2)) {
  const options = { root: process.cwd(), output: 'artifacts/factory/defense.json', offenseReport: 'artifacts/factory/offense.json', browser: false };
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i];
    if (option === '--browser') options.browser = true;
    else if (['--root', '--output', '--offense-report'].includes(option) && argv[i + 1]) options[{ '--root': 'root', '--output': 'output', '--offense-report': 'offenseReport' }[option]] = argv[++i];
    else throw new Error(`Unknown or incomplete option: ${option}`);
  }
  const root = fs.realpathSync(options.root);
  const output = path.resolve(options.output);
  const artifactDirectory = path.dirname(output);
  fs.mkdirSync(artifactDirectory, { recursive: true });
  fs.rmSync(path.join(artifactDirectory, 'noopener-links.patch'), { force: true });
  const report = { factory: 'defense', status: 'inconclusive', target: { repository: 'sumlac/sumlac.github.io', root, scope: 'this checkout and temporary local copies only' },
    checks: [], findings: [], proposals: [], summary: '', startedAt: new Date().toISOString(), finishedAt: null };
  let offense;
  try {
    offense = validateOffense(JSON.parse(fs.readFileSync(path.resolve(options.offenseReport), 'utf8')));
    report.checks.push({ id: 'offense-intake', status: offense.status, report: normalize(path.relative(root, path.resolve(options.offenseReport))), detail: `${offense.checks.length} offense checks; preserves upstream failure and inconclusive results` });
    for (const finding of offense.findings) report.findings.push({ ...finding, sourceFactory: 'offense', repair: null });
  } catch (error) { report.checks.push({ id: 'offense-intake', status: 'inconclusive', detail: error.message }); }
  try {
    const tests = fs.readdirSync(path.join(root, 'tests')).filter(file => file.endsWith('.test.cjs')).sort().map(file => `tests/${file}`);
    if (!tests.length) throw new Error('No baseline regression tests found');
    report.checks.push({ id: 'baseline-regression-tests', ...runNode(['--test', ...tests], root) });
  } catch (error) { report.checks.push({ id: 'baseline-regression-tests', status: 'inconclusive', detail: error.message }); }
  try {
    const audit = await inspectSources(root);
    report.findings.push(...audit.findings);
    report.checks.push({ id: 'html-source-scope', status: audit.files.length ? 'passed' : 'inconclusive', files: audit.files, detail: `${audit.files.length} HTML documents parsed; JavaScript data-flow and HTTP headers are outside this static audit` });
    report.checks.push({ id: 'external-tab-isolation', status: audit.findings.some(item => item.rule === 'external-tab-isolation') ? 'failed' : 'passed', detail: `${audit.externalTabs} external new-tab links inspected with an HTML parser` });
    report.checks.push({ id: 'script-transport', status: audit.findings.some(item => item.rule === 'script-transport') ? 'failed' : 'passed', detail: `${audit.externalScripts} remote executable script references inspected` });
    const reviewCandidates = audit.findings.filter(item => item.confidence === 'review-candidate');
    report.checks.push({ id: 'remote-script-review', status: reviewCandidates.length ? 'inconclusive' : 'passed', detail: `${reviewCandidates.length} remote scripts require human integrity-pin review; no exploit is inferred` });
    if (audit.changes.length) {
      const patchFile = path.join(artifactDirectory, 'noopener-links.patch');
      writePatch(audit.changes, patchFile);
      const verification = await verifyProposal(root, audit.changes, { browser: options.browser, seed: offense?.seed || 'security-factory', patchFile });
      report.proposals.push({ id: 'noopener-links', title: 'Explicitly isolate external new-tab links', status: verification.status === 'passed' ? 'verified' : verification.status,
        patch: path.basename(patchFile), requiresHumanReview: true, appliedToWorkingTree: false,
        files: audit.changes.map(({ file, beforeHash, afterHash }) => ({ file, beforeHash, afterHash })), verification });
    }
  } catch (error) { report.checks.push({ id: 'source-audit', status: 'inconclusive', detail: error.message }); }
  report.status = report.checks.some(check => check.status === 'failed') ? 'failed' : report.checks.some(check => check.status === 'inconclusive') ? 'inconclusive' : 'passed';
  report.summary = `${report.findings.length} findings; ${report.proposals.length} patch proposals. ${report.proposals.length ? 'Proposals exist only as artifacts and require human review; source findings remain open until merged.' : 'No automatic repair is justified by the current evidence.'}`;
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(artifactDirectory, 'defense-manifest.json'), `${JSON.stringify({ report: path.basename(output), proposals: report.proposals.map(({ id, patch, status, files }) => ({ id, patch, status, files })), requiresHumanReview: true }, null, 2)}\n`);
  console.log(`Defense Factory: ${report.status}. ${report.summary}\nReport: ${output}`);
  return report.status === 'passed' ? 0 : report.status === 'failed' ? 1 : 2;
}

module.exports = { inspectSources, validateOffense, verifyProposal, writePatch, main };
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 2; });
