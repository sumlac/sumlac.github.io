'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.installTerminalCommands = require('../terminal-commands.js');
const SumlacShell = require('../terminal-engine.js');

function makeShell(options = {}) {
  return new SumlacShell({ storage: null, ...options });
}
async function output(shell, line, expected, code = 0) {
  const result = await shell.execute(line);
  assert.equal(result.code, code, `${line}: ${result.stderr}`);
  if (expected !== undefined) assert.equal(result.stdout, expected, line);
  return result;
}
function memoryStorage() {
  const data = new Map();
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
  };
}

test('quotes and escapes preserve arguments and protect shell punctuation', async () => {
  const shell = makeShell();
  await output(shell, `echo 'a|b && c; > d'`, 'a|b && c; > d\n');
  await output(shell, `echo '$USER' "$USER"`, '$USER visitor\n');
  await output(shell, 'echo hello\\ world a"b c"d', 'hello world ab cd\n');
  await output(shell, 'printf "[%s]" ""', '[]');
  await output(shell, `echo '*'`, '*\n');
});

test('conditional operators preserve exit status and short circuit mutations', async () => {
  const shell = makeShell();
  await output(shell, 'false && touch should-not-exist || echo recovered', 'recovered\n');
  await output(shell, 'test -e should-not-exist', '', 1);
  await output(shell, 'true || touch also-not-created', '');
  await output(shell, 'test -e also-not-created', '', 1);
  await output(shell, 'false; echo $?', '1\n');
  await output(shell, 'command_that_does_not_exist', undefined, 127);
  await output(shell, 'echo $?', '127\n');
});

test('filesystem mutations, paths with spaces and stdin/output redirection compose', async () => {
  const shell = makeShell();
  await output(shell, 'mkdir -p "project notes/data"; cd "project notes/data"');
  await output(shell, 'pwd', '/home/visitor/project notes/data\n');
  await output(shell, 'printf "first\\nsecond\\n" > notes.txt');
  await output(shell, 'echo third >> notes.txt');
  await output(shell, 'cat < notes.txt', 'first\nsecond\nthird\n');
  await output(shell, 'cp notes.txt copy.txt; mv copy.txt renamed.txt');
  await output(shell, 'cat renamed.txt', 'first\nsecond\nthird\n');
  await output(shell, 'rm renamed.txt; test -e renamed.txt', '', 1);
  await output(shell, 'cd ..; pwd', '/home/visitor/project notes\n');
  await output(shell, 'cd ~; pwd', '/home/visitor\n');
});

test('pipelines transform real file content and use the final stage status', async () => {
  const shell = makeShell();
  await output(shell, 'printf "beta\\nalpha\\nbeta\\n" > input.txt');
  await output(shell, 'cat input.txt | sort | uniq > unique.txt');
  await output(shell, 'cat unique.txt', 'alpha\nbeta\n');
  const count = await output(shell, 'cat input.txt | grep beta | wc -l');
  assert.equal(count.stdout.trim(), '2');
  await output(shell, 'cat input.txt | grep absent', '', 1);
  const lastStage = await output(shell, 'cat absent.txt | wc -l');
  assert.equal(lastStage.stdout.trim(), '0');
  assert.match(lastStage.stderr, /absent/);
});

test('stderr redirects and appends remain separate from stdout', async () => {
  const shell = makeShell();
  const result = await output(shell, 'cat absent.txt 2> errors.txt', '', 1);
  assert.equal(result.stderr, '');
  const error = await output(shell, 'cat errors.txt');
  assert.match(error.stdout, /absent\.txt/);
  await output(shell, 'cat another.txt 2>> errors.txt', '', 1);
  const combined = await output(shell, 'cat errors.txt');
  assert.match(combined.stdout, /absent\.txt/);
  assert.match(combined.stdout, /another\.txt/);
});

test('environment assignment, export, unset and aliases maintain session state', async () => {
  const shell = makeShell();
  await output(shell, 'export QA_VALUE="hello world"');
  await output(shell, 'echo "$QA_VALUE"', 'hello world\n');
  await output(shell, 'QA_VALUE=temporary printenv QA_VALUE', 'temporary\n');
  await output(shell, 'echo "$QA_VALUE"', 'hello world\n');
  await output(shell, 'unset QA_VALUE; echo "[$QA_VALUE]"', '[]\n');
  await output(shell, `alias qa='echo alias-ok'`);
  await output(shell, 'qa extra', 'alias-ok extra\n');
  await output(shell, 'unalias qa; qa', undefined, 127);
});

test('untrusted strings and special object keys remain plain filesystem data', async () => {
  const shell = makeShell();
  const payload = '<img src=x onerror="globalThis.__terminalInjected=true">';
  await output(shell, `printf '%s' '${payload}' > __proto__`);
  await output(shell, 'cat __proto__', payload);
  await output(shell, 'echo safe > constructor; cat constructor', 'safe\n');
  assert.equal(globalThis.__terminalInjected, undefined);
  assert.equal({}.terminalInjected, undefined);
});

test('malformed syntax fails without partial filesystem mutation', async () => {
  const shell = makeShell();
  for (const line of [`echo 'unfinished`, 'echo unfinished |', 'echo unfinished >', 'echo x | ; cat', 'true && ; echo x', 'echo x ;; echo y']) {
    const result = await shell.execute(line);
    assert.notEqual(result.code, 0, line);
    assert.ok(result.stderr, line);
  }
  await output(shell, 'pwd', '/home/visitor\n');
});

test('filesystem, environment, aliases and history survive reload through storage', async () => {
  const storage = memoryStorage();
  const options = { storage, storageKey: 'sumlac-test-state' };
  const first = makeShell(options);
  await output(first, 'mkdir persist; cd persist; echo durable > saved.txt');
  await output(first, 'export QA_PERSIST=restored');
  await output(first, `alias persisted='echo remembered'`);
  const second = makeShell(options);
  await output(second, 'pwd', '/home/visitor/persist\n');
  await output(second, 'cat saved.txt', 'durable\n');
  await output(second, 'echo $QA_PERSIST', 'restored\n');
  await output(second, 'persisted', 'remembered\n');
  assert.ok(second.history.some(line => line.includes('saved.txt')));
});

test('malformed or unavailable browser storage does not break the shell', async () => {
  const corrupt = memoryStorage();
  corrupt.setItem('corrupt-state', '{bad-json');
  const restored = makeShell({ storage: corrupt, storageKey: 'corrupt-state' });
  await output(restored, 'echo available', 'available\n');
  const denied = {
    getItem() { throw new Error('blocked storage'); },
    setItem() { throw new Error('quota exceeded'); },
    removeItem() { throw new Error('blocked storage'); },
  };
  const fallback = makeShell({ storage: denied });
  await output(fallback, 'echo still-available > note.txt; cat note.txt', 'still-available\n');
});

test('abort interrupts sleeping commands and the shell remains usable', { timeout: 2000 }, async () => {
  const shell = makeShell();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20);
  try {
    const result = await shell.execute('sleep 10 && echo should-not-run', { signal: controller.signal });
    assert.equal(result.code, 130);
    assert.doesNotMatch(result.stdout, /should-not-run/);
  } finally {
    clearTimeout(timer);
  }
  await output(shell, 'echo recovered', 'recovered\n');
});

test('source and aliases see environment updates made earlier in the same command', async () => {
  const shell = makeShell();
  await output(shell, `printf 'export FROM_SCRIPT=ok; echo $FROM_SCRIPT\\n' > script.sh`);
  await output(shell, 'source script.sh; echo $FROM_SCRIPT', 'ok\nok\n');
  await output(shell, `alias setqa='export FROM_ALIAS=ready; echo $FROM_ALIAS'`);
  await output(shell, 'setqa; echo $FROM_ALIAS', 'ready\nready\n');
  await output(shell, 'TEMP_VALUE=prefix env printenv TEMP_VALUE', 'prefix\n');
  const timed = await output(shell, 'TEMP_VALUE=prefix time printenv TEMP_VALUE', 'prefix\n');
  assert.match(timed.stderr, /real/);
  await output(shell, 'echo "[$TEMP_VALUE]"', '[]\n');
});

test('redirection truncates before reading and descriptor order changes the destination', async () => {
  const shell = makeShell();
  await output(shell, 'echo original > same.txt; cat same.txt > same.txt; cat same.txt', '');
  const toConsole = await output(shell, 'cat absent.txt 2>&1 > out.txt', undefined, 1);
  assert.match(toConsole.stdout, /absent\.txt/);
  assert.equal(toConsole.stderr, '');
  await output(shell, 'cat out.txt', '');
  const toFile = await output(shell, 'cat absent.txt > out.txt 2>&1', '', 1);
  assert.equal(toFile.stderr, '');
  const saved = await output(shell, 'cat out.txt');
  assert.match(saved.stdout, /absent\.txt/);
});

test('copying into existing directories merges once and incompatible targets fail', async () => {
  const shell = makeShell();
  await output(shell, 'mkdir -p source destination/source; echo content > source/data.txt');
  await output(shell, 'cp -r source destination');
  await output(shell, 'cat destination/source/data.txt', 'content\n');
  await output(shell, 'test -e destination/source/source', '', 1);
  await output(shell, 'mkdir destination/name; echo content > name');
  await output(shell, 'cp name destination', undefined, 1);
  await output(shell, 'mkdir -p moving target/moving; echo moved > moving/file.txt');
  await output(shell, 'mv moving target');
  await output(shell, 'cat target/moving/file.txt', 'moved\n');
  await output(shell, 'test -e moving', '', 1);
});

test('directory traversal and file permissions apply to reads and navigation', async () => {
  const shell = makeShell();
  await output(shell, 'mkdir -p private/nested; echo secret > private/nested/file.txt');
  await output(shell, 'chmod 000 private');
  const denied = await output(shell, 'cat private/nested/file.txt', '', 1);
  assert.match(denied.stderr, /permission denied/);
  await output(shell, 'cd private/nested', '', 1);
  await output(shell, 'chmod 755 private; chmod 000 private/nested/file.txt');
  const listing = await output(shell, 'ls -l private/nested/file.txt');
  assert.match(listing.stdout, /^----------/);
  const metadata = await output(shell, 'stat private/nested/file.txt');
  assert.match(metadata.stdout, /Mode:\s+000/);
});

test('globs and completion honor quoting, hidden files, directories and spaces', async () => {
  const shell = makeShell();
  await output(shell, 'mkdir projects; touch alpha.txt beta.txt .hidden.txt "notes file.txt" projects/item.txt');
  await output(shell, 'echo [ab]*.txt', 'alpha.txt beta.txt\n');
  await output(shell, 'echo "*.txt"', '*.txt\n');
  const visible = await output(shell, 'echo *.txt');
  assert.doesNotMatch(visible.stdout, /\.hidden/);
  assert.deepEqual(shell.complete('ec').candidates, ['echo']);
  assert.equal(shell.complete('echo al').line, 'echo alpha.txt ');
  assert.equal(shell.complete('cd pro').line, 'cd projects/');
  assert.equal(shell.complete('echo x | gr').line, 'echo x | grep ');
  const spaced = shell.complete('cat not');
  assert.equal(spaced.line, 'cat notes\\ file.txt ');
  await output(shell, spaced.line, '');
});

test('history replay and command bypass retain consistent session behavior', async () => {
  const shell = makeShell();
  await output(shell, 'echo history-value', 'history-value\n');
  await output(shell, '!!', 'history-value\n');
  await output(shell, '!echo', 'history-value\n');
  await output(shell, '!99999', '', 1);
  await output(shell, `alias echo='printf aliased'`);
  await output(shell, 'echo', 'aliased');
  await output(shell, 'command echo original', 'original\n');
  await output(shell, 'history -c');
  assert.equal(shell.history.length, 0);
});

test('unsupported execution syntax is rejected without evaluating JavaScript', async () => {
  const shell = makeShell();
  for (const line of ['echo $(echo unsupported)', 'echo `echo unsupported`', '(echo unsupported)', 'echo hello &']) {
    const result = await shell.execute(line);
    assert.equal(result.code, 2, line);
    assert.match(result.stderr, /not supported|unsupported/, line);
  }
  await output(shell, 'echo recovered', 'recovered\n');
});

test('resource limits bound output, storage, recursion and command input', async () => {
  const shell = makeShell();
  const oversizedInput = await shell.execute('x'.repeat(SumlacShell.LIMITS.input + 1));
  assert.equal(oversizedInput.code, 2);
  assert.match(oversizedInput.stderr, /limit/);
  const tooManyItems = await output(shell, 'seq 1 10001', '', 1);
  assert.match(tooManyItems.stderr, /exceeds|limit/);
  const excessiveOutput = await shell.execute(`printf '%010000s' ${Array(30).fill('x').join(' ')}`);
  assert.equal(excessiveOutput.code, 1);
  assert.ok(excessiveOutput.stdout.length <= SumlacShell.LIMITS.output);
  assert.match(excessiveOutput.stderr, /output limit/);
  const loop = await output(shell, `alias forever='forever'; forever`, '', 1);
  assert.match(loop.stderr, /recursion limit/);
  assert.throws(() => shell.fs.writeFile('oversized.txt', 'x'.repeat(SumlacShell.LIMITS.bytes)), /full|limit/);
  assert.equal(shell.fs.exists('oversized.txt'), false);
  await output(shell, 'echo still-usable', 'still-usable\n');
});

test('unsafe regular expressions fail clearly while supported filters keep working', async () => {
  const shell = makeShell();
  const unsafe = await output(shell, "echo safe | grep -E '(a+)+$'", '', 1);
  assert.match(unsafe.stderr, /unsafe regular expression/);
  await output(shell, 'printf "first,1\\nsecond,2\\n" | cut -d , -f 2', '1\n2\n');
  await output(shell, 'echo alpha | sed s/alpha/beta/', 'beta\n');
  await output(shell, `printf 'a 1\\nb 2\\n' | awk '{ print $2 }'`, '1\n2\n');
});


test('pipefail and temporary assignment expansion follow shell exit semantics', async () => {
  const shell = makeShell();
  await output(shell, 'false | true; echo $?', '0\n');
  await output(shell, 'set -o pipefail; false | true; echo $?', '1\n');
  await output(shell, 'set +o pipefail');
  await output(shell, 'VALUE=original; VALUE=temporary echo $VALUE; echo $VALUE', 'original\noriginal\n');
});

test('concurrent and pre-aborted commands cannot mutate a running session', { timeout: 2000 }, async () => {
  const shell = makeShell();
  const controller = new AbortController();
  const running = shell.execute('sleep 10', { signal: controller.signal });
  const busy = await shell.execute('touch not-created');
  assert.equal(busy.code, 1);
  assert.match(busy.stderr, /already running/);
  assert.equal(shell.fs.exists('not-created'), false);
  controller.abort();
  assert.equal((await running).code, 130);
  const aborted = await shell.execute('touch also-not-created', { signal: controller.signal });
  assert.equal(aborted.code, 130);
  assert.equal(shell.fs.exists('also-not-created'), false);
  await output(shell, 'echo recovered', 'recovered\n');
});

test('nested source and alias output preserves clear events in presentation order', async () => {
  const trace = [];
  const shell = makeShell({ onEvent: event => trace.push(['event', event.type]) });
  const onOutput = chunk => {
    if (chunk.stdout) trace.push(['stdout', chunk.stdout]);
    if (chunk.stderr) trace.push(['stderr', chunk.stderr]);
  };
  await output(shell, `alias sequence='echo before; clear; echo after'`);
  await shell.execute('sequence', { interactive: true, onOutput });
  assert.deepEqual(trace, [['stdout', 'before\n'], ['event', 'clear'], ['stdout', 'after\n']]);
  await output(shell, `printf 'echo before; clear; echo after\\n' > sequence.sh`);
  trace.length = 0;
  await shell.execute('source sequence.sh', { interactive: true, onOutput });
  assert.deepEqual(trace, [['stdout', 'before\n'], ['event', 'clear'], ['stdout', 'after\n']]);
});

test('sourced positional arguments retain quoted argument boundaries and empty strings', async () => {
  const shell = makeShell({ seed: { '/home/visitor/args.sh': 'printf "<%s>\\n" "$@"\n' } });
  await output(shell, `source args.sh first 'second value' ''`, '<first>\n<second value>\n<>\n');
});

test('empty piped rg searches stdin, quiet grep stays silent and printf preserves signs', async () => {
  const shell = makeShell();
  await output(shell, 'echo alpha > visible.txt');
  await output(shell, 'true | rg alpha', '', 1);
  await output(shell, 'echo alpha | grep -qc alpha', '');
  await output(shell, `printf '%+06d' 42`, '+00042');
  await output(shell, 'printf %q unsupported', '', 1);
  await output(shell, 'seq 1e-2 1e-2 3e-2', '0.01\n0.02\n0.03\n');
  await output(shell, 'mkdir project; touch projects.txt');
  assert.deepEqual(shell.complete('echo before; cd proj').candidates, ['project/']);
});

test('an empty child environment and user identity remain independent of mutable variables', async () => {
  const shell = makeShell();
  await output(shell, 'env -i printenv USER', '', 1);
  await output(shell, 'env -i CHILD=present printenv CHILD', 'present\n');
  await output(shell, 'printenv USER', 'visitor\n');
  await output(shell, 'USER=changed whoami', 'visitor\n');
  await output(shell, 'USER=changed id -un', 'visitor\n');
  await output(shell, 'USER=changed printenv USER', 'changed\n');
});

test('clear and reset redirect terminal control text without clearing the display', async () => {
  const events = [];
  const shell = makeShell({ onEvent: event => events.push(event.type) });
  await output(shell, 'clear > control.txt');
  assert.deepEqual(events, []);
  await output(shell, 'cat control.txt', '\x1b[H\x1b[2J');
  await output(shell, 'reset > reset.txt');
  assert.deepEqual(events, []);
  await output(shell, 'cat reset.txt', '\x1b[H\x1b[2J');
  await shell.execute('clear', { interactive: true });
  assert.deepEqual(events, ['clear']);
});

test('executables enforce permission and isolate variables and directories while source shares them', async () => {
  const shell = makeShell({ seed: {
    '/home/visitor/run.sh': 'export CHILD_ONLY=value\ncd /tmp\necho "$1" > shared-result.txt\npwd\n',
  } });
  await output(shell, './run.sh argument', '', 126);
  await output(shell, 'chmod 755 run.sh; ./run.sh argument', '/tmp\n');
  await output(shell, 'pwd', '/home/visitor\n');
  await output(shell, 'echo "[$CHILD_ONLY]"', '[]\n');
  await output(shell, 'cat /tmp/shared-result.txt', 'argument\n');
  await output(shell, 'source run.sh sourced', '/tmp\n');
  await output(shell, 'pwd', '/tmp\n');
  await output(shell, 'echo "$CHILD_ONLY"', 'value\n');
  await output(shell, `sh -c 'printf "<%s>\\n" "$0" "$1"' custom-name first`, '<custom-name>\n<first>\n');
  const childExit = await output(shell, `sh -c 'exit 7'; echo $?`, '7\n');
  assert.deepEqual(childExit.events, []);
});

test('complex wildcard matching finishes without exponential backtracking', () => {
  // Isolate the adversarial case so a future regression cannot hang the test runner.
  const { spawnSync } = require('node:child_process');
  const enginePath = require.resolve('../terminal-engine.js');
  const commandsPath = require.resolve('../terminal-commands.js');
  const program = `
    globalThis.installTerminalCommands = require(${JSON.stringify(commandsPath)});
    const Shell = require(${JSON.stringify(enginePath)});
    (async () => {
      const shell = new Shell({ storage: null });
      shell.fs.writeFile('a'.repeat(120) + 'b', 'content');
      const pattern = '*a'.repeat(30) + 'z';
      const result = await shell.execute('echo ' + pattern);
      if (result.code !== 0 || result.stdout !== pattern + '\\n') process.exitCode = 1;
    })();
  `;
  const child = spawnSync(process.execPath, ['-e', program], { encoding: 'utf8', timeout: 1500 });
  assert.equal(child.error, undefined, child.error && child.error.message);
  assert.equal(child.status, 0, child.stderr);
});

test('command wrappers preserve display order and publish child output once', async () => {
  const trace = [];
  const shell = makeShell({ onEvent: event => trace.push(['event', event.type]) });
  const options = {
    interactive: true,
    onOutput(chunk) {
      if (chunk.stdout) trace.push(['stdout', chunk.stdout]);
      if (chunk.stderr) trace.push(['stderr', chunk.stderr]);
    },
  };
  const timed = await shell.execute('time clear', options);
  assert.equal(timed.code, 0);
  assert.equal(trace[0]?.[0], 'event');
  assert.equal(trace[0]?.[1], 'clear');
  assert.equal(trace.length, 2);
  assert.equal(trace[1][0], 'stderr');
  assert.match(trace[1][1], /real\s+\d/);

  await output(shell, `alias sequence='echo before; clear; echo after'`);
  trace.length = 0;
  const scoped = await shell.execute('env WRAPPER_VALUE=present sequence', options);
  assert.equal(scoped.code, 0);
  assert.deepEqual(trace, [['stdout', 'before\n'], ['event', 'clear'], ['stdout', 'after\n']]);

  trace.length = 0;
  const grouped = await shell.execute(`printf 'one\\ntwo\\n' | xargs -n 1 echo`, options);
  assert.equal(grouped.code, 0);
  assert.equal(grouped.stdout, 'one\ntwo\n');
  assert.equal(trace.filter(chunk => chunk[0] === 'stdout').map(chunk => chunk[1]).join(''), grouped.stdout);
  assert.deepEqual(trace.filter(chunk => chunk[0] === 'event'), []);
});
