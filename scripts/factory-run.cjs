#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function combinedExit(...children) {
  const codes = children.map(child => child.error || child.signal || !Number.isInteger(child.status) ? 2 : child.status === 0 ? 0 : child.status === 1 ? 1 : 2);
  return codes.includes(1) ? 1 : codes.some(code => code !== 0) ? 2 : 0;
}
function main() {
  const root = path.resolve(__dirname, '..');
  const offenseReport = path.join(root, 'artifacts', 'factory', 'offense.json');
  // A failed producer must not accidentally reuse yesterday's passing evidence.
  fs.rmSync(offenseReport, { force: true });
  const offense = spawnSync(process.execPath, ['scripts/factory-offense.cjs', '--output', offenseReport], { cwd: root, stdio: 'inherit' });
  const defense = spawnSync(process.execPath, ['scripts/factory-defense.cjs', '--offense-report', offenseReport, '--output', 'artifacts/factory/defense.json'], { cwd: root, stdio: 'inherit' });
  return combinedExit(offense, defense);
}
module.exports = { combinedExit };
if (require.main === module) process.exitCode = main();
