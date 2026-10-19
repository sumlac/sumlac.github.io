/* Browser terminal utilities. All file operations use the isolated virtual filesystem. */
(function (global) {
  'use strict';

  const MAX_ITEMS = 10000;
  const MAX_OUTPUT = 1024 * 1024;
  const ok = (stdout = '', code = 0, stderr = '') => ({ stdout: String(stdout), stderr: String(stderr), code });
  const fail = (name, message, code = 1) => ok('', code, `${name}: ${message}\n`);
  const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
  const lines = text => text === '' ? [] : String(text).replace(/\n$/, '').split('\n');
  const outLines = values => values.length ? values.join('\n') + '\n' : '';
  const bytes = text => new TextEncoder().encode(String(text)).length;
  const human = size => size < 1024 ? String(size) : size < 1048576 ? `${(size / 1024).toFixed(1)}K` : `${(size / 1048576).toFixed(1)}M`;
  const basename = path => String(path).replace(/\/+$/, '').split('/').pop() || '/';
  const dirname = path => { const value = String(path).replace(/\/+$/, ''); const i = value.lastIndexOf('/'); return i < 0 ? '.' : i === 0 ? '/' : value.slice(0, i); };
  const countValue = (value, name = 'count') => { if (!/^\d+$/.test(String(value)) || Number(value) > MAX_ITEMS) throw new Error(`${name} must be an integer between 0 and ${MAX_ITEMS}`); return Number(value); };
  const checkSignal = signal => { if (signal && signal.aborted) { const error = new Error('interrupted'); error.name = 'AbortError'; throw error; } };
  const unknown = option => { throw new Error(`unsupported option '${option}' (see man for supported syntax)`); };
  function globRegex(pattern, insensitive = false) {
    pattern = String(pattern); if (pattern.length > 512) throw new Error('name pattern exceeds 512 characters');
    if (insensitive) pattern = pattern.toLowerCase();
    return { test(value) {
      value = insensitive ? String(value).toLowerCase() : String(value); let p = 0, v = 0, star = -1, retry = 0;
      while (v < value.length) {
        if (pattern[p] === '?' || pattern[p] === value[v]) { p++; v++; }
        else if (pattern[p] === '*') { star = p++; retry = v; }
        else if (star !== -1) { p = star + 1; v = ++retry; }
        else return false;
      }
      while (pattern[p] === '*') p++;
      return p === pattern.length;
    } };
  }
  function flags(args, allowed, valued = '') {
    const options = {}, rest = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--') { rest.push(...args.slice(i + 1)); break; }
      if (arg.startsWith('--')) unknown(arg);
      if (arg[0] !== '-' || arg === '-') { rest.push(arg); continue; }
      for (let j = 1; j < arg.length; j++) {
        const key = arg[j];
        if (!allowed.includes(key) && !valued.includes(key)) unknown('-' + key);
        if (valued.includes(key)) { const value = arg.slice(j + 1) || args[++i]; if (value === undefined) throw new Error(`option -${key} requires a value`); options[key] = value; break; }
        options[key] = true;
      }
    }
    return { options, rest };
  }
  async function sources(ctx, paths) {
    if (!paths.length) return [{ name: '-', text: ctx.stdin || '' }];
    return paths.map(path => ({ name: path, text: path === '-' ? ctx.stdin || '' : ctx.fs.readFile(path, ctx.cwd) }));
  }
  function walk(fs, path, cwd, maxDepth = 100, includeRoot = true) {
    const result = [];
    function visit(value, depth) {
      if (result.length >= MAX_ITEMS) throw new Error(`too many filesystem entries (limit ${MAX_ITEMS})`);
      const stat = fs.stat(value, cwd);
      if (includeRoot || depth) result.push({ ...stat, path: fs.normalize(value, cwd), depth });
      if (stat.type === 'dir' && depth < maxDepth) for (const entry of fs.list(value, cwd)) visit(entry.path || fs.normalize(value + '/' + entry.name, cwd), depth + 1);
    }
    visit(path, 0);
    return result;
  }
  function parseRanges(spec) {
    const ranges = String(spec).split(',').map(item => {
      const match = /^(\d+)(?:-(\d*)?)?$/.exec(item);
      if (match) { const start = Number(match[1]); const end = item.includes('-') ? match[2] ? Number(match[2]) : Infinity : start; if (start < 1 || end < start) throw new Error('invalid field range'); return [start, end]; }
      const leading = /^-(\d+)$/.exec(item);
      if (leading && Number(leading[1]) > 0) return [1, Number(leading[1])];
      throw new Error('invalid field range');
    });
    return index => ranges.some(([start, end]) => index >= start && index <= end);
  }
  function decodeEscapes(text) {
    return String(text).replace(/\\(0[0-7]{0,3}|x[0-9a-fA-F]{1,2}|[abefnrtv\\])/g, (_, value) => {
      if (value[0] === '0') return String.fromCharCode(parseInt(value.slice(1) || '0', 8));
      if (value[0] === 'x') return String.fromCharCode(parseInt(value.slice(1), 16));
      return ({ a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' })[value];
    });
  }
  function parseWords(text) {
    const result = []; let word = '', mode = '', escaped = false, started = false;
    for (const char of text) {
      if (escaped) { word += char; escaped = false; started = true; }
      else if (char === '\\' && mode !== "'") { escaped = true; started = true; }
      else if (mode) { if (char === mode) mode = ''; else word += char; started = true; }
      else if (char === '"' || char === "'") { mode = char; started = true; }
      else if (/\s/.test(char)) { if (started) { result.push(word); word = ''; started = false; } }
      else { word += char; started = true; }
    }
    if (mode || escaped) throw new Error('unmatched quote or trailing backslash in input');
    if (started) result.push(word);
    return result;
  }
  // Keep user regular expressions away from the UI thread. A fixed worker runs
  // only RegExp operations, has no shell/filesystem access, and is time-bounded.
  async function regexBatch(regex, texts, operation = 'test', replacement = '', signal) {
    if (regex.source.length > 512) throw new Error('regular expression exceeds 512 characters');
    if (/\\[1-9]|\(\?[=!<]|\)[+*{]|[+*?}]\s*[+*?{]/.test(regex.source)) throw new Error('unsafe regular expression: backreferences, lookarounds, and repeated groups are unsupported');
    const perform = (pattern, values, kind, substitute) => values.map(text => {
      pattern.lastIndex = 0;
      if (kind === 'split') return text.split(pattern);
      const matched = pattern.test(text); pattern.lastIndex = 0;
      if (kind === 'test') return matched;
      return { matched, value: text.replace(pattern, (...args) => {
        const named = typeof args[args.length - 1] === 'object', groups = args.slice(1, named ? -3 : -2);
        return substitute.replace(/\\([1-9&\\])|&/g, (token, escaped) => escaped === '&' ? '&' : escaped === '\\' ? '\\' : escaped ? groups[Number(escaped) - 1] || '' : args[0]);
      }) };
    });
    if (!global.Worker || !global.Blob || !global.URL || !global.URL.createObjectURL) return perform(regex, texts, operation, replacement);
    const source = `self.onmessage = function(event) { try { const data = event.data; const perform = ${perform.toString()}; self.postMessage({result: perform(new RegExp(data.source, data.flags), data.texts, data.operation, data.replacement)}); } catch(error) { self.postMessage({error: error.message}); } };`;
    const url = global.URL.createObjectURL(new global.Blob([source], { type: 'text/javascript' })); let worker;
    try { worker = new global.Worker(url); } catch (_) { global.URL.revokeObjectURL(url); throw new Error('regular expression worker is unavailable in this browser'); }
    global.URL.revokeObjectURL(url);
    return await new Promise((resolve, reject) => {
      let timer;
      const finish = (error, value) => { clearTimeout(timer); worker.terminate(); if (signal) signal.removeEventListener('abort', abort); if (error) reject(error); else resolve(value); };
      const abort = () => { const error = new Error('interrupted'); error.name = 'AbortError'; finish(error); };
      timer = setTimeout(() => finish(new Error('regular expression exceeded the 500 ms execution limit')), 500);
      worker.onmessage = event => event.data.error ? finish(new Error(event.data.error)) : finish(null, event.data.result);
      worker.onerror = () => finish(new Error('regular expression worker failed'));
      if (signal) { if (signal.aborted) { abort(); return; } signal.addEventListener('abort', abort, { once: true }); }
      worker.postMessage({ source: regex.source, flags: regex.flags, texts, operation, replacement });
    });
  }

  function installTerminalCommands(shell) {
    const register = (name, summary, usage, run) => shell.register(name, {
      summary, usage,
      run: async ctx => {
        try {
          checkSignal(ctx.signal);
          const result = await run(ctx);
          if (result.stdout && result.stdout.length > MAX_OUTPUT) return fail(name, 'output exceeds 1 MiB; narrow the query or save smaller results');
          return result;
        } catch (error) { return fail(name, error.name === 'AbortError' ? 'interrupted' : error.message || String(error), error.name === 'AbortError' ? 130 : 1); }
      }
    });

    register('echo', 'Write arguments to output', 'echo [-n] [-e|-E] [text ...]', ({ args }) => {
      let newline = true, escapes = false, index = 0;
      while (index < args.length && /^-[neE]+$/.test(args[index])) { for (const flag of args[index++].slice(1)) { if (flag === 'n') newline = false; else escapes = flag === 'e'; } }
      let text = args.slice(index).join(' ');
      if (escapes) { const end = text.indexOf('\\c'); if (end !== -1) { text = text.slice(0, end); newline = false; } text = decodeEscapes(text); }
      return ok(text + (newline ? '\n' : ''));
    });
    register('printf', 'Format text with a reusable format string', 'printf FORMAT [ARG ...]  (%s %d %i %f %b %% and \\n/\\t)', ({ args }) => {
      if (!args.length) throw new Error('missing format string');
      const format = decodeEscapes(args[0]); let remaining = args.slice(1), output = '';
      if (format.replace(/%[-+ 0]*\d*(?:\.\d+)?[sdifb%]/g, '').includes('%')) throw new Error('invalid or unsupported format conversion');
      const conversions = format.match(/%(?:[-+ 0]*\d*(?:\.\d+)?)[sdifb]/g) || [];
      do {
        let used = 0;
        output += format.replace(/%([-+ 0]*)(\d*)(?:\.(\d+))?([sdifb%])/g, (_, modifiers, width, precision, type) => {
          if (type === '%') return '%';
          const value = remaining[used++] ?? ''; let rendered;
          if (type === 's') rendered = precision === undefined ? value : value.slice(0, Number(precision));
          else if (type === 'b') rendered = decodeEscapes(value);
          else { const number = value === '' ? 0 : Number(value); if (!Number.isFinite(number)) throw new Error(`invalid number: ${value}`); rendered = type === 'f' ? number.toFixed(precision === undefined ? 6 : Math.min(Number(precision), 100)) : String(Math.trunc(number)); if (number >= 0 && modifiers.includes('+')) rendered = '+' + rendered; }
          if (Number(width) > MAX_ITEMS) throw new Error('format width too large');
          if (modifiers.includes('-')) return rendered.padEnd(Number(width), ' ');
          if (modifiers.includes('0') && /^[+-]/.test(rendered)) return rendered[0] + rendered.slice(1).padStart(Math.max(0, Number(width) - 1), '0');
          return rendered.padStart(Number(width), modifiers.includes('0') ? '0' : ' ');
        });
        remaining = remaining.slice(used);
        if (output.length > MAX_OUTPUT) throw new Error('formatted output too large');
      } while (remaining.length && conversions.length);
      return ok(output);
    });

    register('ls', 'List directory entries', 'ls [-alhRdrtS1A] [PATH ...]', ctx => {
      const { options: o, rest } = flags(ctx.args, 'alhRdrtS1A'); const paths = rest.length ? rest : ['.']; let output = '';
      const render = entry => {
        if (!o.l) return entry.name + (entry.type === 'dir' ? '/' : '');
        const date = new Date(entry.mtime || 0).toISOString().slice(0, 16).replace('T', ' ');
        const mode = entry.mode ?? (entry.type === 'dir' ? '755' : '644');
        const numeric = typeof mode === 'number' ? mode : parseInt(mode, 8);
        const permissions = [6, 3, 0].map(shift => ['r', 'w', 'x'].map((char, i) => numeric & (4 >> i) << shift ? char : '-').join('')).join('');
        return `${entry.type === 'dir' ? 'd' : '-'}${permissions} visitor ${String(o.h ? human(entry.size || 0) : entry.size || 0).padStart(7)} ${date} ${entry.name}${entry.type === 'dir' ? '/' : ''}`;
      };
      const listing = (path, label) => {
        const stat = ctx.fs.stat(path, ctx.cwd);
        if (stat.type !== 'dir' || o.d) { output += render({ ...stat, name: path }) + '\n'; return; }
        let entries = ctx.fs.list(path, ctx.cwd).filter(entry => o.a || o.A || !entry.name.startsWith('.'));
        entries.sort((a, b) => o.t ? Number(b.mtime) - Number(a.mtime) || a.name.localeCompare(b.name) : o.S ? (b.size || 0) - (a.size || 0) || a.name.localeCompare(b.name) : a.name.localeCompare(b.name));
        if (o.r) entries.reverse();
        if (label) output += path + ':\n';
        output += outLines(entries.map(render));
        if (o.R) for (const entry of entries) if (entry.type === 'dir') { output += '\n'; listing(entry.path || ctx.fs.normalize(path + '/' + entry.name, ctx.cwd), true); }
      };
      for (let i = 0; i < paths.length; i++) { if (i) output += '\n'; listing(paths[i], paths.length > 1 || o.R); }
      return ok(output);
    });
    register('cat', 'Read files or standard input', 'cat [-nbsE] [FILE ...]', async ctx => {
      const { options: o, rest } = flags(ctx.args, 'nbsE'); const items = await sources(ctx, rest); let text = items.map(item => item.text).join('');
      if (o.s) text = text.replace(/\n{3,}/g, '\n\n');
      if (o.n || o.b || o.E) { let number = 0; const newline = text.endsWith('\n'); text = lines(text).map(line => { const prefix = o.b ? line ? String(++number).padStart(6) + '\t' : '' : o.n ? String(++number).padStart(6) + '\t' : ''; return prefix + line + (o.E ? '$' : ''); }).join('\n') + (newline ? '\n' : ''); }
      return ok(text);
    });
    register('touch', 'Create files or refresh file timestamps', 'touch [-c] FILE ...', ctx => {
      const { options: o, rest } = flags(ctx.args, 'c'); if (!rest.length) throw new Error('missing file operand');
      for (const path of rest) { if (!ctx.fs.exists(path, ctx.cwd)) { if (!o.c) ctx.fs.writeFile(path, '', ctx.cwd); } else if (ctx.fs.stat(path, ctx.cwd).type === 'file') ctx.fs.writeFile(path, ctx.fs.readFile(path, ctx.cwd), ctx.cwd); }
      return ok();
    });
    register('mkdir', 'Create directories', 'mkdir [-p] DIRECTORY ...', ctx => {
      const { options: o, rest } = flags(ctx.args, 'p'); if (!rest.length) throw new Error('missing directory operand'); for (const path of rest) ctx.fs.mkdir(path, { recursive: !!o.p }, ctx.cwd); return ok();
    });
    register('rm', 'Remove files or directories', 'rm [-rf] PATH ... ', ctx => {
      const { options: o, rest } = flags(ctx.args, 'rfR'); if (!rest.length && !o.f) throw new Error('missing operand'); for (const path of rest) ctx.fs.remove(path, { recursive: !!(o.r || o.R), force: !!o.f }, ctx.cwd); return ok();
    });
    register('rmdir', 'Remove empty directories', 'rmdir DIRECTORY ...', ctx => {
      if (!ctx.args.length) throw new Error('missing directory operand');
      for (const path of ctx.args) { if (ctx.fs.stat(path, ctx.cwd).type !== 'dir') throw new Error(`${path}: not a directory`); if (ctx.fs.list(path, ctx.cwd).length) throw new Error(`${path}: directory not empty`); ctx.fs.remove(path, { recursive: true }, ctx.cwd); } return ok();
    });
    for (const command of ['cp', 'mv']) register(command, command === 'cp' ? 'Copy files and directories' : 'Move or rename files and directories', `${command} ${command === 'cp' ? '[-rR] ' : ''}[-n] SOURCE ... DEST`, ctx => {
      const { options: o, rest } = flags(ctx.args, command === 'cp' ? 'rRn' : 'n'); if (rest.length < 2) throw new Error('source and destination are required');
      const dest = rest.pop(); const destIsDir = ctx.fs.exists(dest, ctx.cwd) && ctx.fs.stat(dest, ctx.cwd).type === 'dir';
      if (rest.length > 1 && !destIsDir) throw new Error('target must be a directory for multiple sources');
      for (const source of rest) { const target = destIsDir ? ctx.fs.normalize(dest + '/' + basename(source), ctx.cwd) : dest; if (o.n && ctx.fs.exists(target, ctx.cwd)) continue; if (command === 'cp') ctx.fs.copy(source, dest, { recursive: !!(o.r || o.R) }, ctx.cwd); else ctx.fs.move(source, dest, ctx.cwd); } return ok();
    });
    register('chmod', 'Set file and directory permissions', 'chmod OCTAL_MODE FILE ...  (owner read/write/execute bits apply inside the sandbox)', ctx => {
      const [mode, ...paths] = ctx.args; if (!/^[0-7]{3}$/.test(mode || '') || !paths.length) throw new Error('expected three octal digits and file paths'); for (const path of paths) ctx.fs.chmod(path, mode, ctx.cwd); return ok();
    });
    register('stat', 'Show file metadata', 'stat FILE ...', ctx => {
      if (!ctx.args.length) throw new Error('missing file operand'); return ok(ctx.args.map(path => { const stat = ctx.fs.stat(path, ctx.cwd), mode = stat.mode ?? (stat.type === 'dir' ? '755' : '644'); return `  File: ${ctx.fs.normalize(path, ctx.cwd)}\n  Type: ${stat.type === 'dir' ? 'directory' : 'regular file'}\n  Size: ${stat.size || 0} bytes\n  Mode: ${typeof mode === 'number' ? mode.toString(8).padStart(3, '0') : mode}\nModify: ${new Date(stat.mtime || 0).toISOString()}\n`; }).join(''));
    });
    register('tree', 'Show a directory tree', 'tree [-ad] [-L DEPTH] [DIRECTORY]', ctx => {
      const { options: o, rest } = flags(ctx.args, 'ad', 'L'); if (rest.length > 1) throw new Error('expected at most one directory'); const root = rest[0] || '.'; const max = o.L === undefined ? 30 : countValue(o.L, 'depth'); let output = root + '\n', dirs = 0, files = 0;
      const visit = (path, prefix, depth) => { if (depth >= max) return; const entries = ctx.fs.list(path, ctx.cwd).filter(e => (o.a || !e.name.startsWith('.')) && (!o.d || e.type === 'dir')).sort((a, b) => a.name.localeCompare(b.name)); for (let i = 0; i < entries.length; i++) { const entry = entries[i], last = i === entries.length - 1; if (dirs + files >= MAX_ITEMS) throw new Error('too many entries'); output += prefix + (last ? '└── ' : '├── ') + entry.name + (entry.type === 'dir' ? '/' : '') + '\n'; if (entry.type === 'dir') { dirs++; visit(entry.path || path + '/' + entry.name, prefix + (last ? '    ' : '│   '), depth + 1); } else files++; } };
      visit(root, '', 0); return ok(output + `\n${dirs} directories, ${files} files\n`);
    });
    register('find', 'Find files by name, type, and depth', 'find [PATH ...] [-name GLOB|-iname GLOB] [-type f|d] [-maxdepth N] [-mindepth N] [-print]', ctx => {
      const roots = []; let name = null, insensitive = false, type = null, max = 100, min = 0;
      for (let i = 0; i < ctx.args.length; i++) { const arg = ctx.args[i]; if (arg === '-name' || arg === '-iname') { name = ctx.args[++i]; if (name === undefined) throw new Error(`${arg} requires a pattern`); insensitive = arg === '-iname'; } else if (arg === '-type') { type = ctx.args[++i]; if (!['f', 'd'].includes(type)) throw new Error('type must be f or d'); } else if (arg === '-maxdepth' || arg === '-mindepth') { const value = countValue(ctx.args[++i], 'depth'); if (arg === '-maxdepth') max = value; else min = value; } else if (arg === '-print') {} else if (arg.startsWith('-')) unknown(arg); else roots.push(arg); }
      const pattern = name === null ? null : globRegex(name, insensitive); const output = [];
      for (const root of roots.length ? roots : ['.']) for (const entry of walk(ctx.fs, root, ctx.cwd, max)) if (entry.depth >= min && (!type || entry.type === (type === 'd' ? 'dir' : 'file')) && (!pattern || pattern.test(basename(entry.path)))) output.push(entry.path);
      return ok(outLines(output));
    });
    register('basename', 'Strip directory and optional suffix from paths', 'basename PATH [SUFFIX]', ({ args }) => { if (!args.length || args.length > 2) throw new Error('expected path and optional suffix'); let name = basename(args[0]); if (args[1] && name.endsWith(args[1])) name = name.slice(0, -args[1].length); return ok(name + '\n'); });
    register('dirname', 'Print parent directory names', 'dirname PATH ...', ({ args }) => { if (!args.length) throw new Error('missing path'); return ok(outLines(args.map(dirname))); });
    register('realpath', 'Resolve paths', 'realpath PATH ...', ctx => { if (!ctx.args.length) throw new Error('missing path'); return ok(outLines(ctx.args.map(path => ctx.fs.normalize(path, ctx.cwd)))); });
    register('du', 'Measure directory and file sizes', 'du [-ash] [-d DEPTH] [PATH ...]', ctx => {
      const { options: o, rest } = flags(ctx.args, 'ash', 'd'); const max = o.d === undefined ? Infinity : countValue(o.d, 'depth'); const output = [];
      for (const root of rest.length ? rest : ['.']) { const entries = walk(ctx.fs, root, ctx.cwd); const totals = new Map(entries.map(e => [e.path, e.type === 'file' ? e.size || 0 : 0])); for (const entry of [...entries].reverse()) if (entry.depth) { const parent = dirname(entry.path); totals.set(parent, (totals.get(parent) || 0) + totals.get(entry.path)); } for (const entry of entries) if ((o.s ? entry.depth === 0 : entry.depth <= max && (o.a || entry.type === 'dir' || entry.depth === 0))) output.push(`${o.h ? human(totals.get(entry.path)) : totals.get(entry.path)}\t${entry.path}`); }
      return ok(outLines(output));
    });
    register('df', 'Report workspace disk usage', 'df [-h]', ctx => {
      const { options: o, rest } = flags(ctx.args, 'h'); if (rest.length) throw new Error('path operands are not supported'); const entries = walk(ctx.fs, '/', '/'); const files = entries.filter(e => e.type === 'file'); const size = files.reduce((sum, entry) => sum + (entry.size || 0), 0); return ok(`Filesystem\tContent bytes\tFiles\tDirectories\nbrowser-vfs\t${o.h ? human(size) : size}\t${files.length}\t${entries.length - files.length}\nStorage quota is browser-managed; this reports virtual file content only.\n`);
    });

    const grep = name => register(name, 'Search text with regular expressions or fixed strings', `${name} [-invrclwFxEqHh] [-e PATTERN] PATTERN [FILE ...]  (-r searches directories)`, async ctx => {
      let args = [...ctx.args], patterns = [], o = {}, paths = [], havePattern = false, afterOptions = false;
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (!afterOptions && arg === '--') { afterOptions = true; continue; }
        if (!afterOptions && arg[0] === '-' && arg !== '-') {
          for (let j = 1; j < arg.length; j++) { const flag = arg[j]; if (flag === 'e') { const value = arg.slice(j + 1) || args[++i]; if (value === undefined) throw new Error('-e requires a pattern'); patterns.push(value); havePattern = true; break; } if (!'invrRclwFxEqHh'.includes(flag)) unknown('-' + flag); o[flag] = true; }
        } else if (!havePattern) { patterns.push(arg); havePattern = true; } else paths.push(arg);
      }
      if (!havePattern) throw new Error('missing search pattern');
      if (patterns.length > 32) throw new Error('at most 32 search patterns are supported');
      const regexes = patterns.map(pattern => { let source = o.F ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern; if (o.w) source = `\\b(?:${source})\\b`; if (o.x) source = `^(?:${source})$`; return new RegExp(source, o.i ? 'i' : ''); });
      if (name === 'rg' && !paths.length && !ctx.hasStdin && !ctx.stdin) { paths = ['.']; o.r = true; }
      let expanded = [];
      for (const path of paths) {
        if (path === '-') { expanded.push(path); continue; }
        const stat = ctx.fs.stat(path, ctx.cwd);
        if (stat.type === 'dir') { if (!(o.r || o.R || name === 'rg')) throw new Error(`${path}: is a directory (use -r)`); expanded.push(...walk(ctx.fs, path, ctx.cwd).filter(e => e.type === 'file').map(e => e.path)); } else expanded.push(path);
      }
      if (paths.length && !expanded.length) return ok('', 1);
      const items = await sources(ctx, expanded); const output = []; let found = false;
      for (const item of items) { let count = 0; const matched = []; const values = lines(item.text), tests = new Array(values.length).fill(false);
        for (const regex of regexes) { const results = await regexBatch(regex, values, 'test', '', ctx.signal); for (let i = 0; i < results.length; i++) tests[i] = tests[i] || results[i]; }
        for (let i = 0; i < values.length; i++) { let matches = tests[i]; if (o.v) matches = !matches; if (matches) { count++; found = true; if (o.q) return ok(); matched.push((o.n ? `${i + 1}:` : '') + values[i]); } } if (o.q) continue; const showName = !o.h && (o.H || items.length > 1); if (o.l) { if (count) output.push(item.name === '-' ? '(standard input)' : item.name); } else if (o.c) output.push((showName ? item.name + ':' : '') + count); else output.push(...matched.map(value => (showName ? item.name + ':' : '') + value)); }
      return ok(outLines(output), found ? 0 : 1);
    });
    grep('grep'); grep('rg');
    for (const command of ['head', 'tail']) register(command, `Read the ${command === 'head' ? 'first' : 'last'} lines or bytes`, `${command} [-n COUNT|-c COUNT] [-qv] [FILE ...]  (tail also supports -n +N)`, async ctx => {
      const { options: o, rest } = flags(ctx.args, 'qv', 'nc'); if (o.n !== undefined && o.c !== undefined) throw new Error('choose -n or -c'); const raw = o.n ?? o.c ?? '10', from = command === 'tail' && raw.startsWith('+'); const count = countValue(from ? raw.slice(1) : raw); const items = await sources(ctx, rest); let output = '';
      for (let i = 0; i < items.length; i++) { const item = items[i]; if (!o.q && (o.v || items.length > 1)) output += (i ? '\n' : '') + `==> ${item.name === '-' ? 'standard input' : item.name} <==\n`; if (o.c !== undefined) { const buffer = new TextEncoder().encode(item.text); output += new TextDecoder().decode(from ? buffer.slice(Math.max(0, count - 1)) : command === 'head' ? buffer.slice(0, count) : count ? buffer.slice(-count) : new Uint8Array()); } else { const values = lines(item.text), selected = from ? values.slice(Math.max(0, count - 1)) : command === 'head' ? values.slice(0, count) : count ? values.slice(-count) : []; const lastIncluded = from || command === 'tail' || count >= values.length; output += selected.join('\n') + (selected.length && (item.text.endsWith('\n') || !lastIncluded) ? '\n' : ''); } }
      return ok(output);
    });
    register('wc', 'Count newlines, words, UTF-8 bytes, or characters', 'wc [-lwmc] [FILE ...]', async ctx => {
      const { options: o, rest } = flags(ctx.args, 'lwmc'); if (!Object.keys(o).length) Object.assign(o, { l: true, w: true, c: true }); const items = await sources(ctx, rest), totals = { l: 0, w: 0, m: 0, c: 0 }, output = [];
      const render = (counts, name) => ['l', 'w', 'm', 'c'].filter(k => o[k]).map(k => String(counts[k]).padStart(7)).join(' ') + (name ? ' ' + name : '');
      for (const item of items) { const counts = { l: (item.text.match(/\n/g) || []).length, w: (item.text.match(/\S+/gu) || []).length, m: Array.from(item.text).length, c: bytes(item.text) }; for (const key of Object.keys(counts)) totals[key] += counts[key]; output.push(render(counts, item.name === '-' ? '' : item.name)); } if (items.length > 1) output.push(render(totals, 'total')); return ok(outLines(output));
    });
    register('sort', 'Sort input lines', 'sort [-rnuf] [FILE ...]', async ctx => {
      const { options: o, rest } = flags(ctx.args, 'rnuf'); const items = await sources(ctx, rest); let values = items.flatMap(item => lines(item.text));
      const compare = (a, b) => { if (o.n) { const numeric = (parseFloat(a) || 0) - (parseFloat(b) || 0); if (numeric) return numeric; if (o.u) return 0; } const left = o.f ? a.toLowerCase() : a, right = o.f ? b.toLowerCase() : b; return left < right ? -1 : left > right ? 1 : 0; };
      values.sort((a, b) => o.r ? -compare(a, b) : compare(a, b)); if (o.u) values = values.filter((value, i) => !i || compare(value, values[i - 1]) !== 0); return ok(outLines(values));
    });
    register('uniq', 'Filter adjacent repeated lines', 'uniq [-cdui] [INPUT [OUTPUT]]', async ctx => {
      const { options: o, rest } = flags(ctx.args, 'cdui'); if (rest.length > 2) throw new Error('too many file operands'); const text = (await sources(ctx, rest.slice(0, 1)))[0].text; const groups = [];
      for (const value of lines(text)) { const previous = groups[groups.length - 1]; if (previous && (o.i ? previous.value.toLowerCase() === value.toLowerCase() : previous.value === value)) previous.count++; else groups.push({ value, count: 1 }); }
      const output = outLines(groups.filter(group => (!o.d || group.count > 1) && (!o.u || group.count === 1)).map(group => (o.c ? String(group.count).padStart(7) + ' ' : '') + group.value)); if (rest[1]) { ctx.fs.writeFile(rest[1], output, ctx.cwd); return ok(); } return ok(output);
    });
    register('cut', 'Extract delimited fields or character positions', 'cut (-f FIELDS [-d DELIM] [-s] | -c POSITIONS) [FILE ...]', async ctx => {
      const { options: o, rest } = flags(ctx.args, 's', 'fdc'); if ((o.f === undefined) === (o.c === undefined)) throw new Error('choose exactly one of -f or -c'); if (o.d !== undefined && [...o.d].length !== 1) throw new Error('delimiter must be one character'); const delimiter = o.d ?? '\t', selected = parseRanges(o.f ?? o.c); const items = await sources(ctx, rest), output = [];
      for (const item of items) for (const line of lines(item.text)) { if (o.c !== undefined) output.push([...line].filter((_, i) => selected(i + 1)).join('')); else if (!line.includes(delimiter)) { if (!o.s) output.push(line); } else output.push(line.split(delimiter).filter((_, i) => selected(i + 1)).join(delimiter)); } return ok(outLines(output));
    });
    register('tr', 'Translate, delete, or squeeze characters from input', 'tr [-ds] SET1 [SET2]  (ranges a-z and [:upper:]/[:lower:]/[:digit:]/[:space:])', ctx => {
      const { options: o, rest } = flags(ctx.args, 'ds'); if (!rest.length || rest.length > 2 || !o.d && !o.s && rest.length !== 2) throw new Error('expected character sets');
      const expand = value => { const expanded = decodeEscapes(value).replace(/\[:(upper|lower|digit|space|alpha|alnum):\]/g, (_, key) => ({ upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', lower: 'abcdefghijklmnopqrstuvwxyz', digit: '0123456789', space: ' \t\r\n\v\f', alpha: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' })[key]); const chars = [...expanded], result = []; for (let i = 0; i < chars.length; i++) { if (chars[i + 1] === '-' && chars[i + 2] !== undefined) { const start = chars[i].codePointAt(0), end = chars[i + 2].codePointAt(0); if (end < start || end - start > MAX_ITEMS) throw new Error('invalid character range'); for (let n = start; n <= end; n++) result.push(String.fromCodePoint(n)); i += 2; } else result.push(chars[i]); } return result; };
      const first = expand(rest[0]), second = rest[1] === undefined ? [] : expand(rest[1]); if (!o.d && rest.length === 2 && !second.length) throw new Error('second set cannot be empty'); const translate = new Map(first.map((char, i) => [char, second[Math.min(i, second.length - 1)]])); const squeeze = new Set(second.length ? second : first), deleted = new Set(first); let output = '', previous = null;
      for (let char of ctx.stdin || '') { if (o.d && deleted.has(char)) continue; if (!o.d && second.length && translate.has(char)) char = translate.get(char); if (o.s && char === previous && squeeze.has(char)) continue; output += char; previous = char; } return ok(output);
    });

    register('sed', 'Substitute text or print selected lines', 'sed [-n] [-e SCRIPT] SCRIPT [FILE ...]  (s/regex/replacement/gi, Np, N,Mp, /regex/p, Nd, N,Md)', async ctx => {
      const o = {}, scripts = [], paths = []; let scriptSeen = false;
      for (let i = 0; i < ctx.args.length; i++) { const arg = ctx.args[i]; if (arg === '-n') o.n = true; else if (arg === '-e') { if (ctx.args[i + 1] === undefined) throw new Error('-e requires a script'); scripts.push(ctx.args[++i]); scriptSeen = true; } else if (arg === '--') { if (!scriptSeen) { if (ctx.args[i + 1] === undefined) throw new Error('missing script'); scripts.push(ctx.args[++i]); scriptSeen = true; } paths.push(...ctx.args.slice(i + 1)); break; } else if (!scriptSeen) { scripts.push(arg); scriptSeen = true; } else paths.push(arg); }
      if (!scriptSeen) throw new Error('missing script');
      const parse = script => {
        if (script[0] === 's' && script.length > 1) { const delimiter = script[1]; if (/[\w\s\\]/.test(delimiter)) throw new Error('invalid substitution delimiter'); let pieces = [], part = ''; for (let i = 2; i < script.length; i++) { const char = script[i]; if (char === '\\' && script[i + 1] === delimiter) { part += delimiter; i++; } else if (char === delimiter) { pieces.push(part); part = ''; if (pieces.length === 2) { part = script.slice(i + 1); break; } } else part += char; } if (pieces.length !== 2 || !/^[gip]*$/.test(part)) throw new Error('expected s/regex/replacement/[gip]'); return { kind: 'sub', regex: new RegExp(pieces[0], (part.includes('g') ? 'g' : '') + (part.includes('i') ? 'i' : '')), replacement: pieces[1], print: part.includes('p') }; }
        const address = /^(\d+|\$)(?:,(\d+|\$))?([pd])$/.exec(script); if (address) return { kind: address[3], first: address[1], last: address[2] || address[1] };
        const pattern = /^\/(.*)\/([pd])$/.exec(script); if (pattern) return { kind: pattern[2], regex: new RegExp(pattern[1]) };
        throw new Error(`unsupported script: ${script}`);
      };
      const operations = scripts.map(parse), items = await sources(ctx, paths), values = items.flatMap(item => lines(item.text)), rows = values.map(value => ({ value, deleted: false, prints: [] })), output = [];
      for (const operation of operations) {
        const tests = operation.regex ? await regexBatch(operation.regex, rows.map(row => row.value), operation.kind === 'sub' ? 'replace' : 'test', operation.replacement || '', ctx.signal) : null;
        for (let i = 0; i < rows.length; i++) { const row = rows[i]; if (row.deleted) continue;
          if (operation.kind === 'sub') { row.value = tests[i].value; if (tests[i].matched && operation.print) row.prints.push(row.value); }
          else { const selected = tests ? tests[i] : i + 1 >= (operation.first === '$' ? values.length : Number(operation.first)) && i + 1 <= (operation.last === '$' ? values.length : Number(operation.last)); if (selected && operation.kind === 'd') row.deleted = true; else if (selected && operation.kind === 'p') row.prints.push(row.value); }
        }
      }
      for (const row of rows) { output.push(...row.prints); if (!row.deleted && !o.n) output.push(row.value); }
      return ok(outLines(output));
    });
    register('awk', 'Print selected text fields with a safe awk subset', 'awk [-F DELIMITER] \'[NR==N|NR>N|/regex/] { print $1, $2, NF, NR, "text" }\' [FILE ...]', async ctx => {
      let delimiter = null, index = 0; if (ctx.args[0] === '-F') { delimiter = ctx.args[1]; index = 2; if (delimiter === undefined) throw new Error('-F requires a delimiter'); } else if (ctx.args[0] && ctx.args[0].startsWith('-F')) { delimiter = ctx.args[0].slice(2); index = 1; }
      const script = ctx.args[index++]; if (!script) throw new Error('missing program'); const match = /^\s*(.*?)\s*\{\s*print\s*(.*?)\s*;?\s*\}\s*$/.exec(script); if (!match) throw new Error('supported program is [condition] { print FIELD, ... }; no arbitrary code execution');
      const condition = match[1], expression = match[2].replace(/;\s*$/, ''); const terms = []; let part = '', quoted = false, escaped = false;
      for (const char of expression) { if (escaped) { part += '\\' + char; escaped = false; } else if (char === '\\' && quoted) escaped = true; else if (char === '"') { quoted = !quoted; part += char; } else if (char === ',' && !quoted) { terms.push(part.trim()); part = ''; } else part += char; } if (quoted || escaped) throw new Error('unterminated string'); terms.push(part.trim());
      if (terms.some(term => !/^(?:\$\d+|NF|NR|"(?:[^"\\]|\\.)*"|\d+)$/.test(term) && term !== '')) throw new Error('print supports $0, $N, NF, NR, numbers, and quoted strings');
      let predicate = () => true, filterRegex = null;
      if (condition) { const n = /^NR\s*(==|!=|>=|<=|>|<)\s*(\d+)$/.exec(condition), regex = /^\/(.*)\/$/.exec(condition); if (n) { const target = Number(n[2]); predicate = (_, nr) => ({ '==': nr === target, '!=': nr !== target, '>=': nr >= target, '<=': nr <= target, '>': nr > target, '<': nr < target })[n[1]]; } else if (regex) filterRegex = new RegExp(regex[1]); else throw new Error('condition supports NR comparisons or /regex/'); }
      const separator = delimiter === null ? null : new RegExp(delimiter); const items = await sources(ctx, ctx.args.slice(index)), values = items.flatMap(item => lines(item.text)), output = [];
      const filtered = filterRegex ? await regexBatch(filterRegex, values, 'test', '', ctx.signal) : null, split = separator ? await regexBatch(separator, values, 'split', '', ctx.signal) : null;
      for (let i = 0; i < values.length; i++) { const line = values[i], nr = i + 1; if (filtered ? !filtered[i] : !predicate(line, nr)) continue; const fields = split ? split[i] : line.trim() ? line.trim().split(/\s+/) : []; output.push(terms.map(term => !term ? line : term === 'NR' ? nr : term === 'NF' ? fields.length : term[0] === '$' ? term === '$0' ? line : fields[Number(term.slice(1)) - 1] || '' : term[0] === '"' ? decodeEscapes(term.slice(1, -1).replace(/\\"/g, '"')) : term).join(' ')); }
      return ok(outLines(output));
    });

    register('tee', 'Copy input to files and output', 'tee [-a] FILE ...', ctx => { const { options: o, rest } = flags(ctx.args, 'a'); for (const path of rest) if (o.a) ctx.fs.appendFile(path, ctx.stdin || '', ctx.cwd); else ctx.fs.writeFile(path, ctx.stdin || '', ctx.cwd); return ok(ctx.stdin || ''); });
    register('xargs', 'Build bounded commands from input items', 'xargs [-0rt] [-n COUNT] [-I TOKEN] [COMMAND [ARG ...]]  (at most 128 invocations)', async ctx => {
      const o = {}, command = []; let parsing = true;
      for (let i = 0; i < ctx.args.length; i++) { const arg = ctx.args[i]; if (parsing && arg === '--') { parsing = false; continue; } if (parsing && arg.startsWith('-') && arg !== '-') { if (['-0', '-r', '-t'].includes(arg)) o[arg[1]] = true; else if (arg.startsWith('-n') || arg.startsWith('-I')) { const flag = arg[1], value = arg.slice(2) || ctx.args[++i]; if (value === undefined) throw new Error(`${arg} requires a value`); o[flag] = value; } else unknown(arg); } else { parsing = false; command.push(arg); } }
      const input = ctx.stdin || ''; let items = o['0'] ? input.split('\0').filter((v, i, all) => v !== '' || i < all.length - 1) : o.I ? lines(input).filter(value => value.trim()) : parseWords(input); if (!items.length && o.r) return ok(); if (!command.length) command.push('echo'); const amount = o.I ? 1 : o.n === undefined ? Math.max(1, items.length) : countValue(o.n); if (!amount) throw new Error('-n must be greater than zero'); const groups = items.length ? Array.from({ length: Math.ceil(items.length / amount) }, (_, i) => items.slice(i * amount, (i + 1) * amount)) : [[]]; if (groups.length > 128) throw new Error('too many command invocations (limit 128)'); let stdout = '', stderr = '', code = 0; const events = [], streamed = typeof ctx.stream === 'function';
      for (const group of groups) {
        checkSignal(ctx.signal); const parts = o.I ? command.map(value => value.split(o.I).join(group[0] || '')) : command.concat(group); const line = parts.map(quote).join(' ');
        if (o.t) { const trace = line + '\n'; stderr += trace; if (streamed) ctx.stream({ stdout: '', stderr: trace, events: [] }); }
        const result = await ctx.shell.run(line, { signal: ctx.signal, stdin: '', hasStdin: true, interactive: ctx.interactive, env: ctx.env, _scope: ctx.scope, _stream: ctx.stream });
        stdout += result.stdout || ''; stderr += result.stderr || ''; events.push(...result.events || []);
        if (streamed && !result._streamed) ctx.stream({ stdout: result.stdout || '', stderr: result.stderr || '', events: result.events || [] });
        if (result.code) code = 123; if (result.code === 130) { code = 130; break; }
        if ((result.events || []).some(event => event.type === 'exit' || event.type === 'reset')) break;
      }
      return { ...ok(stdout, code, stderr), events, _streamed: streamed };
    });
    register('base64', 'Encode or decode UTF-8 text', 'base64 [-d] [-w COLUMNS] [FILE]', async ctx => {
      const { options: o, rest } = flags(ctx.args, 'd', 'w'); if (rest.length > 1) throw new Error('expected at most one file'); const text = (await sources(ctx, rest))[0].text;
      if (o.d) { const value = text.replace(/\s/g, ''); if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.test(value)) throw new Error('invalid base64 input'); const binary = global.atob(value); return ok(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0)))); }
      const data = new TextEncoder().encode(text); let binary = ''; for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.slice(i, i + 8192)); const value = global.btoa(binary), width = o.w === undefined ? 76 : countValue(o.w, 'columns'); return ok(value ? width ? value.match(new RegExp(`.{1,${width}}`, 'g')).join('\n') + '\n' : value : '');
    });
    register('seq', 'Print a bounded sequence of numbers', 'seq [-s SEPARATOR] [-w] [FIRST [INCREMENT]] LAST', ({ args }) => {
      const options = {}; let index = 0; while (index < args.length) { if (args[index] === '-s') { options.s = args[index + 1]; if (options.s === undefined) throw new Error('-s requires a separator'); index += 2; } else if (args[index] === '-w') { options.w = true; index++; } else break; } const operands = args.slice(index); if (operands.length < 1 || operands.length > 3) throw new Error('expected one, two, or three numbers'); const values = operands.map(Number); if (values.some(value => !Number.isFinite(value))) throw new Error('all operands must be finite numbers'); const [first, step, last] = values.length === 1 ? [1, 1, values[0]] : values.length === 2 ? [values[0], 1, values[1]] : values; if (!step) throw new Error('increment cannot be zero'); const size = Math.floor((last - first) / step + 1e-10) + 1; if (size > MAX_ITEMS) throw new Error(`sequence exceeds ${MAX_ITEMS} items`); const precision = Math.min(10, Math.max(...operands.map(value => { const parts = value.toLowerCase().split('e'); return Math.max(0, (parts[0].split('.')[1] || '').length - Number(parts[1] || 0)); }))); const sequence = []; const width = Math.max(String(first).length, String(last).length); for (let i = 0; i < Math.max(0, size); i++) { const value = Number((first + step * i).toPrecision(15)); let rendered = precision && Math.abs(value) >= 1e-10 ? value.toFixed(precision) : String(value); if (options.w) rendered = rendered[0] === '-' ? '-' + rendered.slice(1).padStart(width - 1, '0') : rendered.padStart(width, '0'); sequence.push(rendered); } return ok(sequence.length ? sequence.join(options.s ?? '\n') + '\n' : '');
    });

    register('date', 'Show the current date and time', 'date [-u] [+FORMAT]  (%Y %m %d %H %M %S %s %a %b %z %Z %F %T %%)', ({ args }) => {
      const { options: o, rest } = flags(args, 'u'); if (rest.length > 1 || rest.length && rest[0][0] !== '+') throw new Error('expected +FORMAT'); const value = new Date(), utc = !!o.u, get = name => value[(utc ? 'getUTC' : 'get') + name](), pad = n => String(n).padStart(2, '0');
      if (!rest.length) return ok((utc ? value.toUTCString() : value.toString()) + '\n'); const offset = utc ? 0 : -value.getTimezoneOffset(); const zone = utc ? 'UTC' : Intl.DateTimeFormat().resolvedOptions().timeZone; const mappings = { Y: String(get('FullYear')), m: pad(get('Month') + 1), d: pad(get('Date')), H: pad(get('Hours')), M: pad(get('Minutes')), S: pad(get('Seconds')), s: String(Math.floor(value.getTime() / 1000)), a: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][get('Day')], b: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][get('Month')], z: (offset < 0 ? '-' : '+') + pad(Math.floor(Math.abs(offset) / 60)) + pad(Math.abs(offset) % 60), Z: zone, '%': '%' }; mappings.F = `${mappings.Y}-${mappings.m}-${mappings.d}`; mappings.T = `${mappings.H}:${mappings.M}:${mappings.S}`; return ok(rest[0].slice(1).replace(/%([YmdHMSsabzZFT%])/g, (_, code) => mappings[code]) + '\n');
    });
    register('uname', 'Show shell runtime information', 'uname [-asnrvmp]', ({ args }) => {
      const { options: o, rest } = flags(args, 'asnrvmp'); if (rest.length) throw new Error('unexpected operand'); const info = { s: 'Browser', n: global.location ? global.location.hostname : 'browser', r: '1', v: 'Sumlac virtual shell', m: global.navigator ? global.navigator.platform || 'unknown' : 'JavaScript', p: 'JavaScript' }; if (!Object.keys(o).length) o.s = true; return ok(['s', 'n', 'r', 'v', 'm', 'p'].filter(key => o.a || o[key]).map(key => info[key]).join(' ') + '\n');
    });
    register('hostname', 'Show the hostname', 'hostname', ({ args }) => { if (args.length) throw new Error('setting hostnames is unavailable in a browser'); return ok((global.location ? global.location.hostname : 'browser') + '\n'); });
    register('whoami', 'Print the current user name', 'whoami', ({ args }) => { if (args.length) throw new Error('unexpected operand'); return ok('visitor\n'); });
    register('id', 'Show user and group identity', 'id [-u|-g|-G] [-n]', ({ args }) => {
      const { options: o, rest } = flags(args, 'ugGn'); if (rest.length) throw new Error('user lookup is unavailable');
      const selected = ['u', 'g', 'G'].filter(key => o[key]); if (selected.length > 1) throw new Error('choose only one of -u, -g, or -G'); if (o.n && !selected.length) throw new Error('-n requires -u, -g, or -G');
      return ok((selected.length ? o.n ? 'visitor' : '1000' : 'uid=1000(visitor) gid=1000(visitor) groups=1000(visitor)') + '\n');
    });
    register('env', 'Print environment or run a command with temporary variables', 'env [-i] [NAME=VALUE ...] [COMMAND [ARG ...]]', async ctx => {
      let index = 0, empty = false; if (ctx.args[0] === '-i') { empty = true; index++; } const additions = {};
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(ctx.args[index] || '')) { const value = ctx.args[index++], eq = value.indexOf('='); additions[value.slice(0, eq)] = value.slice(eq + 1); }
      if (index === ctx.args.length) return ok(outLines(Object.entries({ ...(empty ? {} : ctx.env), ...additions }).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`)));
      return await ctx.shell.run(ctx.args.slice(index).map(quote).join(' '), { signal: ctx.signal, stdin: ctx.stdin || '', hasStdin: ctx.hasStdin, interactive: ctx.interactive, replaceEnv: empty, env: { ...(empty ? {} : ctx.env), ...additions }, _scope: ctx.scope, _stream: ctx.stream });
    });
    register('printenv', 'Print selected environment variables', 'printenv [NAME ...]', ctx => { if (!ctx.args.length) return ok(outLines(Object.entries(ctx.env).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`))); return ok(outLines(ctx.args.filter(key => Object.prototype.hasOwnProperty.call(ctx.env, key)).map(key => ctx.env[key])), ctx.args.every(key => Object.prototype.hasOwnProperty.call(ctx.env, key)) ? 0 : 1); });
    for (const command of ['which']) register(command, 'Locate commands and aliases', `${command} COMMAND ...`, ctx => {
      if (!ctx.args.length) throw new Error('missing command'); let code = 0, stderr = ''; const output = [];
      for (const name of ctx.args) { const alias = ctx.shell.aliases && ctx.shell.aliases[name]; if (alias !== undefined) output.push(command === 'which' ? `alias ${name}=${quote(alias)}` : `${name} is an alias for ${alias}`); else if (ctx.shell.commands.has(name)) output.push(`${name} (shell builtin)`); else { code = 1; stderr += `${command}: ${name}: not found\n`; } } return ok(outLines(output), code, stderr);
    });
    for (const command of ['test', '[']) register(command, 'Test file properties, strings, or integers', `${command} [-e|-f|-d|-s PATH] | [-n|-z STRING] | VALUE [=|!=|-eq|-ne|-lt|-le|-gt|-ge] VALUE`, ctx => {
      let args = [...ctx.args]; if (command === '[') { if (args.pop() !== ']') throw new Error("missing closing ']'"); }
      let invert = false; while (args[0] === '!') { invert = !invert; args.shift(); } let value = false;
      if (args.length === 0) value = false;
      else if (args.length === 1) value = args[0].length > 0;
      else if (args.length === 2) { const [flag, operand] = args;
        if (flag === '-z') value = operand.length === 0; else if (flag === '-n') value = operand.length > 0;
        else if (['-e', '-f', '-d', '-s'].includes(flag)) { if (ctx.fs.exists(operand, ctx.cwd)) { const stat = ctx.fs.stat(operand, ctx.cwd); value = flag === '-e' || flag === '-f' && stat.type === 'file' || flag === '-d' && stat.type === 'dir' || flag === '-s' && stat.size > 0; } }
        else throw new Error(`unsupported test operator ${flag}`);
      } else if (args.length === 3) { const [left, operator, right] = args;
        if (operator === '=' || operator === '==') value = left === right; else if (operator === '!=') value = left !== right;
        else if (['-eq', '-ne', '-lt', '-le', '-gt', '-ge'].includes(operator)) { if (!/^[+-]?\d+$/.test(left) || !/^[+-]?\d+$/.test(right)) throw new Error('integer expression expected'); const a = Number(left), b = Number(right); value = ({ '-eq': a === b, '-ne': a !== b, '-lt': a < b, '-le': a <= b, '-gt': a > b, '-ge': a >= b })[operator]; }
        else throw new Error(`unsupported test operator ${operator}`);
      } else throw new Error('unsupported expression; chain tests with && or ||');
      return ok('', (invert ? !value : value) ? 0 : 1);
    });
    register('sleep', 'Pause for a duration; Ctrl+C cancels', 'sleep DURATION[s|ms|m] ...  (maximum total: 60 seconds)', async ctx => {
      if (!ctx.args.length) throw new Error('missing duration'); let duration = 0; for (const arg of ctx.args) { const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(arg); if (!match) throw new Error(`invalid duration: ${arg}`); duration += Number(match[1]) * (match[2] === 'ms' ? 1 : match[2] === 'm' ? 60000 : 1000); } if (duration > 60000) throw new Error('maximum total duration is 60 seconds');
      await new Promise((resolve, reject) => { const aborted = () => { clearTimeout(timer); const error = new Error('interrupted'); error.name = 'AbortError'; reject(error); }; const timer = setTimeout(() => { if (ctx.signal) ctx.signal.removeEventListener('abort', aborted); resolve(); }, duration); if (ctx.signal) { if (ctx.signal.aborted) aborted(); else ctx.signal.addEventListener('abort', aborted, { once: true }); } }); return ok();
    });
    register('time', 'Measure command execution time', 'time COMMAND [ARG ...]', async ctx => {
      if (!ctx.args.length) throw new Error('missing command'); const clock = global.performance ? () => global.performance.now() : () => Date.now(), start = clock();
      const result = await ctx.shell.run(ctx.args.map(quote).join(' '), { signal: ctx.signal, stdin: ctx.stdin || '', hasStdin: ctx.hasStdin, interactive: ctx.interactive, env: ctx.env, _scope: ctx.scope, _stream: ctx.stream });
      const timing = `\nreal\t${((clock() - start) / 1000).toFixed(3)}s\n`;
      if (result._streamed && typeof ctx.stream === 'function') ctx.stream({ stdout: '', stderr: timing, events: [] });
      return { ...result, stderr: (result.stderr || '') + timing };
    });
    register('curl', 'Fetch an HTTP or HTTPS URL', 'curl [-iIfsS] [-X METHOD] [-H HEADER] [-d DATA] [-o FILE] [--max-time SECONDS] URL  (CORS applies; no host proxy)', async ctx => {
      const headers = {}, options = {}, urls = []; let method = null, data;
      for (let i = 0; i < ctx.args.length; i++) { const arg = ctx.args[i]; if (arg === '--') { urls.push(...ctx.args.slice(i + 1)); break; } if (arg === '--max-time') { const seconds = Number(ctx.args[++i]); if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) throw new Error('--max-time must be between 0 and 60 seconds'); options.timeout = seconds * 1000; } else if (['-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '-o', '--output'].includes(arg)) { const value = ctx.args[++i]; if (value === undefined) throw new Error(`${arg} requires a value`); if (arg === '-X' || arg === '--request') method = value; else if (arg === '-H' || arg === '--header') { const index = value.indexOf(':'); if (index < 1) throw new Error('header must use Name: value'); headers[value.slice(0, index).trim()] = value.slice(index + 1).trim(); } else if (arg === '-o' || arg === '--output') options.output = value; else data = value; } else if (/^-[iIfsSL]+$/.test(arg)) { for (const flag of arg.slice(1)) options[flag] = true; } else if (arg.startsWith('-')) unknown(arg); else urls.push(arg); }
      if (urls.length !== 1) throw new Error('specify one URL'); const url = new URL(urls[0], global.location ? global.location.href : undefined); if (!['https:', 'http:'].includes(url.protocol)) throw new Error('only HTTP and HTTPS URLs are allowed'); if (url.username || url.password) throw new Error('credentials in URLs are not supported');
      const networkFailure = (message, code) => options.s && !options.S ? ok('', code) : fail('curl', message, code);
      const controller = new AbortController(); const abort = () => controller.abort(); if (ctx.signal) ctx.signal.addEventListener('abort', abort, { once: true }); const timeout = setTimeout(abort, options.timeout || 15000); let response;
      try { if (ctx.signal && ctx.signal.aborted) controller.abort(); const requestMethod = options.I ? 'HEAD' : method || (data === undefined ? 'GET' : 'POST'); if (data !== undefined && ['GET', 'HEAD'].includes(requestMethod.toUpperCase())) throw new Error('GET/HEAD requests cannot include a body'); response = await global.fetch(url.href, { method: requestMethod, headers, body: data, signal: controller.signal, credentials: 'omit', redirect: 'follow' });
        if (options.f && !response.ok) return networkFailure(`HTTP ${response.status} ${response.statusText}`, 22);
        const headerText = `HTTP ${response.status} ${response.statusText}\n` + [...response.headers.entries()].map(([key, value]) => `${key}: ${value}`).join('\n') + '\n\n';
        const reader = response.body && response.body.getReader ? response.body.getReader() : null; let body = '';
        if (reader) { const decoder = new TextDecoder(); let size = 0; while (true) { checkSignal(ctx.signal); const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > MAX_OUTPUT) { await reader.cancel(); throw new Error('response exceeds 1 MiB'); } body += decoder.decode(part.value, { stream: true }); } body += decoder.decode(); } else { body = await response.text(); if (bytes(body) > MAX_OUTPUT) throw new Error('response exceeds 1 MiB'); }
        const output = (options.i || options.I ? headerText : '') + (options.I ? '' : body); if (options.output) { ctx.fs.writeFile(options.output, output, ctx.cwd); return ok(); } return ok(output);
      } catch (error) { if (error.name === 'AbortError') return networkFailure(ctx.signal && ctx.signal.aborted ? 'interrupted' : 'request timed out', ctx.signal && ctx.signal.aborted ? 130 : 28); if (error instanceof TypeError) return networkFailure('request failed. The server may block browser CORS requests, or the network is unavailable.', 7); throw error; } finally { clearTimeout(timeout); if (ctx.signal) ctx.signal.removeEventListener('abort', abort); }
    });
  }

  global.installTerminalCommands = installTerminalCommands;
  if (typeof module !== 'undefined' && module.exports) module.exports = installTerminalCommands;
})(typeof window !== 'undefined' ? window : globalThis);
