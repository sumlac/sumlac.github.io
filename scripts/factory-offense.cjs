#!/usr/bin/env node
'use strict';

// Scope: this checkout and a loopback-only browser. No public targets or models.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FIXED_SEED = 'sumlac-factory-pages-v2';
const PAGES = ['index.html', 'defense-factory/index.html', 'offense-factory/index.html'];
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const clip = value => String(value).slice(0, 2400);

function localURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) {
    throw new Error('Browser target must use http://127.0.0.1 with no credentials.');
  }
  return url;
}
async function restrictBrowser(context, target, blocked) {
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port === target.port) return route.continue();
    blocked.push(url.origin);
    return route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**/*', socket => {
    blocked.push('WebSocket blocked');
    return socket.close({ code: 1008, reason: 'Outside local test transport scope' });
  });
}

async function readDocument(root, name) {
  const { parse } = await import('parse5');
  const nodes = [];
  const document = parse(fs.readFileSync(path.join(root, name), 'utf8'));
  function visit(node) {
    if (node.tagName) nodes.push({ tag: node.tagName, attrs: Object.fromEntries((node.attrs || []).map(attr => [attr.name, attr.value])) });
    for (const child of node.childNodes || []) visit(child);
    if (node.content) visit(node.content);
  }
  visit(document);
  return nodes;
}

async function inspectReferences(root, pages = PAGES) {
  const documents = new Map();
  const references = [];
  for (const file of pages) documents.set(file, await readDocument(root, file));
  for (const [file, nodes] of documents) {
    const base = new URL(file.endsWith('index.html') ? file.slice(0, -10) : file, 'https://sumlac.com/');
    for (const { tag, attrs } of nodes) {
      const value = tag === 'a' || tag === 'link' ? attrs.href : ['script', 'img', 'source'].includes(tag) ? attrs.src : null;
      if (!value) continue;
      const url = new URL(value, base);
      if (url.origin !== 'https://sumlac.com') continue;
      const pathname = decodeURIComponent(url.pathname);
      const target = path.resolve(root, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname));
      assert.ok(target.startsWith(path.resolve(root) + path.sep), `Reference escapes checkout: ${file}: ${value}`);
      assert.ok(fs.existsSync(target) && fs.statSync(target).isFile(), `Missing local reference: ${file}: ${value}`);
      if (tag === 'a' && url.hash && /\.html?$/i.test(target)) {
        const name = path.relative(root, target).split(path.sep).join('/');
        if (!documents.has(name)) documents.set(name, await readDocument(root, name));
        const id = decodeURIComponent(url.hash.slice(1));
        assert.ok(documents.get(name).some(node => node.attrs.id === id), `Missing fragment: ${file}: ${value}`);
      }
      references.push({ file, value });
    }
  }
  return references;
}

const campaigns = [
  ['source.local-references', 'Public links, fragments, and local assets resolve in this checkout', async () => ({ references: await inspectReferences(ROOT) })],
  ['source.unique-anchors', 'Public document anchors have unique identities', async () => {
    const evidence = [];
    for (const file of PAGES) {
      const nodes = await readDocument(ROOT, file);
      const ids = nodes.map(node => node.attrs.id).filter(Boolean);
      assert.equal(new Set(ids).size, ids.length, `Duplicate document ID in ${file}`);
      evidence.push({ file, uniqueIds: ids.length });
    }
    return { documents: evidence };
  }],
  ['source.script-syntax', 'Local public scripts compile without executing their contents', async () => {
    const scripts = new Set();
    for (const file of PAGES) {
      for (const node of await readDocument(ROOT, file)) {
        if (node.tag !== 'script' || !node.attrs.src) continue;
        const url = new URL(node.attrs.src, new URL(file, 'https://sumlac.com/'));
        if (url.origin === 'https://sumlac.com') scripts.add(decodeURIComponent(url.pathname).slice(1));
      }
    }
    assert.ok(scripts.size, 'No public scripts found');
    for (const file of scripts) new vm.Script(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file });
    return { scripts: [...scripts], executed: false };
  }],
];

async function worker(id, seed) {
  const definition = campaigns.find(([key]) => key === id);
  if (!definition) throw new Error('Unknown internal campaign: ' + id);
  const started = Date.now();
  try {
    const evidence = await definition[2]();
    return { id, title: definition[1], status: 'passed', durationMs: Date.now() - started, evidence };
  } catch (error) {
    return { id, title: definition[1], status: 'failed', durationMs: Date.now() - started, evidence: { error: clip(error.message), expected: error.expected, actual: error.actual }, reproduction: { seed, invocation: `node scripts/factory-offense.cjs --seed ${quote(seed)}` } };
  }
}

async function browserCampaigns(target, seed) {
  let playwright;
  try { playwright = require('playwright'); }
  catch { return [{ id: 'browser.runtime', title: 'Local browser runtime', status: 'inconclusive', evidence: { error: 'Playwright is unavailable. Run npm ci and npx playwright install chromium.' } }]; }
  const checks = [];
  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'reduce', acceptDownloads: true });
    const blocked = [], errors = [];
    await restrictBrowser(context, target, blocked);
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    page.on('pageerror', error => errors.push(error.message));
    const goto = async relative => {
      const response = await page.goto(new URL(relative, target).href, { waitUntil: 'domcontentloaded', timeout: 15000 });
      if (!response || !response.ok()) throw new Error('Local target did not return a successful document.');
    };
    const check = async (id, title, action) => {
      const started = Date.now();
      try { const evidence = await action(); checks.push({ id, title, status: 'passed', durationMs: Date.now() - started, evidence }); }
      catch (error) { checks.push({ id, title, status: 'failed', durationMs: Date.now() - started, evidence: { error: clip(error.message), browserExceptions: errors.slice() }, reproduction: { seed, invocation: `node scripts/factory-offense.cjs --browser --url ${quote(target.href)} --seed ${quote(seed)}` } }); }
    };
    await check('browser.homepage-readiness', 'Both factory essays and contact are available without a splash', async () => {
      await goto('/');
      assert.equal(await page.locator('#boot-screen, #boot-overlay, #splash-screen').count(), 0);
      for (const mode of ['defense', 'offense']) {
        const card = page.locator(`.factory-preview-${mode}`);
        assert.equal(await card.isVisible(), true);
        assert.equal(await card.getAttribute('href'), `/${mode}-factory/`);
      }
      assert.equal(await page.locator('#contact').count(), 1);
      assert.ok(await page.locator('#contact a[href^="mailto:"]').count());
      return { linkedFactories: ['defense', 'offense'], contactAvailable: true };
    });
    for (const mode of ['defense', 'offense']) {
      await check(`browser.${mode}-stages`, `${mode} process stages support pointer and keyboard navigation`, async () => {
        await goto(`/${mode}-factory/`);
        const tabs = page.locator('.f-stage-tab');
        const count = await tabs.count();
        assert.ok(count >= 2);
        for (let index = 0; index < count; index++) {
          await tabs.nth(index).click();
          assert.equal(await tabs.nth(index).getAttribute('aria-selected'), 'true');
          assert.equal(await page.locator('.f-stage-panel:visible').count(), 1);
        }
        await tabs.last().press('Home');
        assert.equal(await tabs.first().getAttribute('aria-selected'), 'true');
        await tabs.first().press('ArrowRight');
        assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true');
        return { stages: count, keyboardNavigation: true };
      });
      await check(`browser.${mode}-cases`, `${mode} illustrative cases keep bounded steps and export labeled evidence`, async () => {
        await goto(`/${mode}-factory/`);
        const values = await page.locator('#scenario-select option').evaluateAll(options => options.map(option => option.value));
        for (const value of values) {
          await page.locator('#scenario-select').selectOption(value);
          assert.equal(await page.locator('#walk-prev').isDisabled(), true);
          for (let step = 1; step <= 4; step++) {
            assert.equal(await page.locator('#walk-counter').textContent(), `STEP ${step} OF 4`);
            assert.match(await page.locator('#walk-evidence').textContent(), /SAMPLE \/ NOT A LIVE FINDING/);
            if (step < 4) await page.locator('#walk-next').click();
          }
          assert.equal(await page.locator('#walk-next').isDisabled(), true);
          await page.locator('#walk-reset').click();
          assert.equal(await page.locator('#walk-counter').textContent(), 'STEP 1 OF 4');
        }
        const downloadPromise = page.waitForEvent('download');
        await page.locator('#walk-download').click();
        const download = await downloadPromise;
        const artifact = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
        assert.equal(artifact.factory, mode);
        assert.equal(artifact.illustrative, true);
        assert.equal(artifact.live_finding, false);
        assert.equal(artifact.model_calls, false);
        assert.equal(artifact.steps.length, 4);
        return { cases: values, stepsPerCase: 4, sampleArtifact: download.suggestedFilename(), liveFinding: false };
      });
      await check(`browser.${mode}-query-boundary`, `${mode} case selection accepts known cases and ignores hostile query values`, async () => {
        const payloads = ['__proto__', 'constructor', '<img src=x onerror="globalThis.__factoryEscape=1">', '<svg onload="globalThis.__factoryEscape=1">', `unknown-${seed}`];
        for (const payload of payloads) {
          await goto(`/${mode}-factory/?case=${encodeURIComponent(payload)}`);
          assert.equal(await page.locator('#scenario-select').inputValue(), 'injection');
          assert.equal(await page.evaluate(() => !!globalThis.__factoryEscape || !!document.querySelector('#scenario-heading img, #scenario-heading svg, #walk-evidence script, #walk-evidence img, #walk-evidence svg')), false);
        }
        await goto(`/${mode}-factory/?case=output`);
        assert.equal(await page.locator('#scenario-select').inputValue(), 'output');
        return { hostileValues: payloads, knownCaseSelected: 'output', executed: false };
      });
    }
    await check('browser.runtime-boundaries', 'Factory interactions produce no uncaught exceptions or outside transport', async () => {
      assert.deepEqual(errors, [], 'uncaught browser exceptions');
      assert.deepEqual(blocked, [], 'unexpected transport outside the local test origin');
      return { browserExceptions: errors, blockedExternalOrigins: blocked };
    });
    await context.close();
  } catch (error) {
    checks.push({ id: 'browser.runtime', title: 'Local browser runtime and target availability', status: 'inconclusive', evidence: { error: clip(error.message) } });
  } finally { if (browser) await browser.close(); }
  return checks;
}

function markdown(report) {
  const lines = ['# Offense Factory evidence', '', `Status: **${report.status}**`, `Seed: \`${report.seed}\``, `Target: \`${report.target}\``, '', 'Only this checkout and its loopback browser were exercised. The report is not a claim of complete security.', '', '| Check | Result |', '| --- | --- |'];
  for (const check of report.checks) lines.push(`| ${check.id} | ${check.status} |`);
  for (const check of report.checks.filter(item => item.status !== 'passed')) lines.push('', `## ${check.id}`, '', check.evidence?.error || 'See the JSON evidence.', '', '```json', JSON.stringify(check.reproduction || {}, null, 2), '```');
  lines.push('', 'Checked references, case selections, and captured outcomes are preserved in the adjacent JSON report.', '');
  return lines.join('\n');
}
function argsOf(args) {
  const options = { output: 'artifacts/factory/offense.json', seed: `${FIXED_SEED}:${new Date().toISOString().slice(0, 10)}`, browser: false, url: 'http://127.0.0.1:8000/' };
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === '--browser') options.browser = true;
    else if (['--output', '--seed', '--url', '--case'].includes(option)) {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Missing value for ' + option);
      options[option.slice(2)] = args[++index];
    } else throw new Error('Unknown argument: ' + option);
  }
  return options;
}
async function main(args = process.argv.slice(2)) {
  const startedAt = new Date().toISOString();
  let options;
  try { options = argsOf(args); }
  catch (error) { console.error(error.message); return 2; }
  if (options.case) {
    const result = options.case === '__browser' ? await browserCampaigns(localURL(options.url), options.seed) : await worker(options.case, options.seed);
    process.stdout.write(JSON.stringify(result));
    return 0;
  }
  const checks = [];
  let target;
  try { target = localURL(options.url); }
  catch (error) { checks.push({ id: 'scope.loopback', title: 'Authorized browser scope', status: 'inconclusive', evidence: { error: error.message } }); }
  if (target) {
    for (const [id, title] of campaigns) {
      const child = spawnSync(process.execPath, [__filename, '--case', id, '--seed', options.seed], { encoding: 'utf8', timeout: 6000, maxBuffer: 2 * 1024 * 1024 });
      if (child.error || child.status !== 0) {
        const timedOut = child.error?.code === 'ETIMEDOUT';
        checks.push({ id, title, status: timedOut ? 'failed' : 'inconclusive', evidence: { error: timedOut ? 'Campaign exceeded its 6 second process budget.' : clip(child.error?.message || child.stderr || 'Campaign process failed.'), exitCode: child.status, signal: child.signal }, reproduction: { seed: options.seed, invocation: `node scripts/factory-offense.cjs --seed ${quote(options.seed)}` } });
      } else {
        try { checks.push(JSON.parse(child.stdout)); }
        catch { checks.push({ id, title, status: 'inconclusive', evidence: { error: 'Campaign returned invalid evidence.', stdout: clip(child.stdout), stderr: clip(child.stderr) } }); }
      }
    }
    if (options.browser) {
      const child = spawnSync(process.execPath, [__filename, '--case', '__browser', '--url', target.href, '--seed', options.seed], { encoding: 'utf8', timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
      if (child.error || child.status !== 0) checks.push({ id: 'browser.runtime', title: 'Bounded local browser campaign', status: 'inconclusive', evidence: { error: clip(child.error?.message || child.stderr || 'Browser campaign process failed.'), exitCode: child.status, signal: child.signal } });
      else {
        try { checks.push(...JSON.parse(child.stdout)); }
        catch { checks.push({ id: 'browser.runtime', title: 'Browser evidence availability', status: 'inconclusive', evidence: { error: 'Browser returned invalid evidence.', stdout: clip(child.stdout), stderr: clip(child.stderr) } }); }
      }
    }
  }
  const summary = { passed: checks.filter(item => item.status === 'passed').length, failed: checks.filter(item => item.status === 'failed').length, inconclusive: checks.filter(item => item.status === 'inconclusive').length, total: checks.length };
  const status = summary.failed ? 'failed' : summary.inconclusive ? 'inconclusive' : 'passed';
  const report = { version: 1, factory: 'offense', status, startedAt, finishedAt: new Date().toISOString(), seed: options.seed, seedPolicy: { fixed: FIXED_SEED, rotation: 'UTC date by default; --seed records the same query probe inputs' }, target: options.browser ? options.url : 'local public factory documents and their assets', scope: 'Authorized repository only; external browser requests blocked; no model calls or remote probing.', browserRequested: options.browser, checks, findings: checks.filter(item => item.status === 'failed').map(item => ({ id: item.id, title: item.title, severity: 'needs-review', evidence: item.evidence, reproduction: item.reproduction })), summary };
  const output = path.resolve(options.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(output.replace(/\.json$/i, '') + '.md', markdown(report));
  console.log(`Offense Factory ${status}: ${summary.passed} passed, ${summary.failed} failed, ${summary.inconclusive} inconclusive. Evidence: ${path.relative(process.cwd(), output)}`);
  return status === 'passed' ? 0 : status === 'failed' ? 1 : 2;
}

module.exports = { main, localURL, markdown, restrictBrowser, inspectReferences };
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.stack); process.exitCode = 2; });
