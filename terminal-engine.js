/* A small, stateful shell for the browser. It never executes host commands. */
(function (global) {
  'use strict';

  const LIMITS = Object.freeze({ nodes: 2048, bytes: 1024 * 1024, input: 32768, output: 256000, steps: 256, depth: 16 });
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const safeObject = (source) => Object.assign(Object.create(null), source || {});
  const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
  const error = (code, message) => Object.assign(new Error(message), { code });
  const abortError = () => Object.assign(new Error('Interrupted'), { name: 'AbortError', code: 'EINTR' });
  const checkAbort = (signal) => { if (signal && signal.aborted) throw abortError(); };
  const byteLength = (value) => typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(value).length : unescape(encodeURIComponent(value)).length;
  const basename = (path) => path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1);
  const dirname = (path) => path === '/' ? '/' : path.slice(0, path.lastIndexOf('/')) || '/';

  class VirtualFileSystem {
    constructor(onChange) {
      this.nodes = new Map();
      this.onChange = onChange || (() => {});
      this.nodes.set('/', this.node('dir'));
    }
    node(type, content = '', mode) {
      const now = Date.now();
      return { type, content: type === 'file' ? String(content) : undefined, mode: mode === undefined ? (type === 'dir' ? 0o755 : 0o644) : mode, ctime: now, mtime: now };
    }
    normalize(path, cwd = '/home/visitor') {
      path = String(path === undefined || path === '' ? '.' : path);
      if (path.includes('\0')) throw error('EINVAL', 'path contains a null byte');
      if (path.length > 2048) throw error('ENAMETOOLONG', 'path is too long');
      const absolute = path.startsWith('/') ? path : cwd + '/' + path;
      const parts = [];
      for (const part of absolute.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') parts.pop();
        else { if (part.length > 255) throw error('ENAMETOOLONG', 'filename exceeds 255 characters'); parts.push(part); }
      }
      return '/' + parts.join('/');
    }
    _get(path) {
      let parent = '/';
      for (const part of path.split('/').filter(Boolean).slice(0, -1)) {
        const ancestor = this.nodes.get(parent);
        if (!ancestor) throw error('ENOENT', parent + ': no such file or directory');
        if (ancestor.type !== 'dir') throw error('ENOTDIR', parent + ': not a directory');
        if (!(ancestor.mode & 0o100)) throw error('EACCES', parent + ': permission denied');
        parent = parent === '/' ? '/' + part : parent + '/' + part;
      }
      if (path !== '/') {
        const ancestor = this.nodes.get(parent);
        if (!ancestor) throw error('ENOENT', parent + ': no such file or directory');
        if (ancestor.type !== 'dir') throw error('ENOTDIR', parent + ': not a directory');
        if (!(ancestor.mode & 0o100)) throw error('EACCES', parent + ': permission denied');
      }
      const node = this.nodes.get(path);
      if (!node) throw error('ENOENT', path + ': no such file or directory');
      return node;
    }
    _directory(path, writable = false) {
      const node = this._get(path);
      if (node.type !== 'dir') throw error('ENOTDIR', path + ': not a directory');
      if (!(node.mode & 0o100) || (writable && !(node.mode & 0o200))) throw error('EACCES', path + ': permission denied');
      return node;
    }
    _capacity(nextNodes) {
      if (nextNodes.size > LIMITS.nodes) throw error('ENOSPC', 'virtual filesystem file limit reached');
      let bytes = 0;
      for (const [path, node] of nextNodes) bytes += byteLength(path) + (node.type === 'file' ? byteLength(node.content) : 0);
      if (bytes > LIMITS.bytes) throw error('ENOSPC', 'virtual filesystem is full (1 MiB limit)');
    }
    _commit(nextNodes) { this._capacity(nextNodes); this.nodes = nextNodes; this.onChange(); }
    exists(path, cwd) { try { this._get(this.normalize(path, cwd)); return true; } catch (_) { return false; } }
    stat(path, cwd) {
      path = this.normalize(path, cwd);
      const node = this._get(path);
      return { path, name: basename(path), type: node.type, mode: node.mode, size: node.type === 'file' ? byteLength(node.content) : 0, mtime: node.mtime, ctime: node.ctime };
    }
    list(path = '.', cwd) {
      path = this.normalize(path, cwd);
      this._directory(path);
      if (!(this._get(path).mode & 0o400)) throw error('EACCES', path + ': permission denied');
      const prefix = path === '/' ? '/' : path + '/';
      return Array.from(this.nodes.keys()).filter((entry) => entry !== path && entry.startsWith(prefix) && !entry.slice(prefix.length).includes('/')).sort().map((entry) => this.stat(entry));
    }
    readFile(path, cwd) {
      path = this.normalize(path, cwd);
      if (path === '/dev/null') return '';
      const node = this._get(path);
      if (node.type !== 'file') throw error('EISDIR', path + ': is a directory');
      if (!(node.mode & 0o400)) throw error('EACCES', path + ': permission denied');
      return node.content;
    }
    writeFile(path, content, cwd) {
      path = this.normalize(path, cwd);
      if (path === '/dev/null') return;
      content = String(content);
      this._directory(dirname(path), true);
      const previous = this.nodes.get(path);
      if (previous && previous.type === 'dir') throw error('EISDIR', path + ': is a directory');
      if (previous && !(previous.mode & 0o200)) throw error('EACCES', path + ': permission denied');
      const next = new Map(this.nodes);
      next.set(path, previous ? Object.assign({}, previous, { content, mtime: Date.now() }) : this.node('file', content));
      this._commit(next);
    }
    appendFile(path, content, cwd) {
      path = this.normalize(path, cwd);
      if (path === '/dev/null') return;
      const node = this.nodes.get(path);
      this.writeFile(path, (node && node.type === 'file' ? node.content : '') + String(content), '/');
    }
    mkdir(path, options = {}, cwd) {
      path = this.normalize(path, cwd);
      if (this.nodes.has(path)) {
        if (options.recursive && this._get(path).type === 'dir') return;
        throw error('EEXIST', path + ': file exists');
      }
      const next = new Map(this.nodes);
      let current = '';
      const parts = path.split('/').filter(Boolean);
      parts.forEach((part, index) => {
        const parent = current || '/';
        current += '/' + part;
        const parentNode = next.get(parent);
        if (!parentNode || parentNode.type !== 'dir') throw error('ENOTDIR', parent + ': not a directory');
        if (!(parentNode.mode & 0o100)) throw error('EACCES', parent + ': permission denied');
        const node = next.get(current);
        if (node) {
          if (node.type !== 'dir') throw error('ENOTDIR', current + ': not a directory');
          return;
        }
        if (!options.recursive && index !== parts.length - 1) throw error('ENOENT', current + ': no such file or directory');
        if (!(parentNode.mode & 0o200)) throw error('EACCES', parent + ': permission denied');
        next.set(current, this.node('dir'));
      });
      this._commit(next);
    }
    remove(path, options = {}, cwd) {
      path = this.normalize(path, cwd);
      if (path === '/' || path === '/dev' || path === '/dev/null') throw error('EBUSY', path + ': protected virtual path');
      if (!this.nodes.has(path)) {
        if (options.force) return;
        throw error('ENOENT', path + ': no such file or directory');
      }
      this._directory(dirname(path), true);
      const node = this.nodes.get(path);
      if (node.type === 'dir' && !options.recursive) throw error('EISDIR', path + ': is a directory (use -r)');
      const entries = Array.from(this.nodes.keys()).filter(entry => entry === path || entry.startsWith(path + '/'));
      for (const entry of entries) {
        const child = this._get(entry);
        this._directory(dirname(entry), true);
        if (child.type === 'dir' && entries.some(candidate => candidate.startsWith(entry + '/')) && !(child.mode & 0o400)) throw error('EACCES', entry + ': permission denied');
      }
      const next = new Map(this.nodes);
      for (const entry of entries) next.delete(entry);
      this._commit(next);
    }
    copy(source, destination, options = {}, cwd) {
      source = this.normalize(source, cwd); destination = this.normalize(destination, cwd);
      const src = this._get(source);
      if (this.nodes.has(destination) && this.nodes.get(destination).type === 'dir') destination = this.normalize(basename(source), destination);
      if (source === destination) throw error('EINVAL', source + ': source and destination are the same');
      if (src.type === 'dir' && !options.recursive) throw error('EISDIR', source + ': is a directory (use -r)');
      if (src.type === 'dir' && destination.startsWith(source + '/')) throw error('EINVAL', 'cannot copy a directory into itself');
      this._directory(dirname(destination), true);
      const existing = this.nodes.get(destination);
      if (existing && existing.type !== src.type) throw error(existing.type === 'dir' ? 'EISDIR' : 'ENOTDIR', destination + ': incompatible destination');
      if (existing && src.type === 'file' && !(existing.mode & 0o200)) throw error('EACCES', destination + ': permission denied');
      const next = new Map(this.nodes);
      const entries = Array.from(this.nodes).filter(([entry]) => entry === source || entry.startsWith(source + '/'));
      for (const [entry, node] of entries) {
        this._get(entry);
        if (!(node.mode & 0o400) || (node.type === 'dir' && !(node.mode & 0o100))) throw error('EACCES', entry + ': permission denied');
        const target = destination + entry.slice(source.length);
        const previous = this.nodes.get(target);
        if (previous && previous.type !== node.type) throw error(previous.type === 'dir' ? 'EISDIR' : 'ENOTDIR', target + ': incompatible destination');
        if (this.nodes.has(dirname(target))) this._directory(dirname(target), true);
        if (previous && node.type === 'dir') this._directory(target, true);
        if (previous && node.type === 'file' && !(previous.mode & 0o200)) throw error('EACCES', target + ': permission denied');
        next.set(target, Object.assign({}, node, { mtime: Date.now(), ctime: Date.now() }));
      }
      this._commit(next);
    }
    move(source, destination, cwd) {
      source = this.normalize(source, cwd); destination = this.normalize(destination, cwd);
      const src = this._get(source);
      if (source === '/' || source === '/dev' || source === '/dev/null') throw error('EBUSY', source + ': protected virtual path');
      if (this.nodes.has(destination) && this.nodes.get(destination).type === 'dir') destination = this.normalize(basename(source), destination);
      if (source === destination) return;
      if (destination.startsWith(source + '/')) throw error('EINVAL', 'cannot move a directory into itself');
      this._directory(dirname(source), true); this._directory(dirname(destination), true);
      const target = this.nodes.get(destination);
      if (target && target.type !== src.type) throw error('EINVAL', destination + ': incompatible destination');
      if (target && target.type === 'dir' && this.list(destination).length) throw error('ENOTEMPTY', destination + ': directory not empty');
      const next = new Map(this.nodes);
      for (const [entry, node] of this.nodes) {
        if (entry === source || entry.startsWith(source + '/')) {
          next.set(destination + entry.slice(source.length), Object.assign({}, node, { mtime: Date.now() }));
          next.delete(entry);
        }
      }
      this._commit(next);
    }
    chmod(path, mode, cwd) {
      path = this.normalize(path, cwd);
      mode = typeof mode === 'string' ? parseInt(mode, 8) : mode;
      if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw error('EINVAL', 'invalid mode');
      const next = new Map(this.nodes);
      next.set(path, Object.assign({}, this._get(path), { mode, mtime: Date.now() }));
      this._commit(next);
    }
    serialize() { return Array.from(this.nodes); }
    restore(entries) {
      if (!Array.isArray(entries) || entries.length > LIMITS.nodes) throw error('EINVAL', 'invalid saved filesystem');
      const next = new Map();
      for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length !== 2) throw error('EINVAL', 'invalid saved filesystem');
        const [path, node] = entry;
        if (typeof path !== 'string' || this.normalize(path, '/') !== path || !node || !['dir', 'file'].includes(node.type)) throw error('EINVAL', 'invalid saved filesystem');
        if (node.type === 'file' && typeof node.content !== 'string') throw error('EINVAL', 'invalid saved file');
        if (!Number.isInteger(node.mode) || node.mode < 0 || node.mode > 0o777) throw error('EINVAL', 'invalid saved permissions');
        next.set(path, { type: node.type, content: node.type === 'file' ? node.content : undefined, mode: node.mode, ctime: Number(node.ctime) || Date.now(), mtime: Number(node.mtime) || Date.now() });
      }
      if (!next.has('/') || next.get('/').type !== 'dir') throw error('EINVAL', 'saved filesystem has no root');
      for (const [path] of next) if (path !== '/' && (!next.has(dirname(path)) || next.get(dirname(path)).type !== 'dir')) throw error('EINVAL', 'saved filesystem has missing parent');
      this._capacity(next); this.nodes = next;
    }
  }

  class ShellSyntaxError extends Error {
    constructor(message, incomplete = false) { super(message); this.name = 'ShellSyntaxError'; this.incomplete = incomplete; }
  }
  const operatorAt = (source, index, numbered = true) => {
    const choices = numbered ? ['2>&1', '1>&2', '2>>', '1>>', '2>', '1>', '&&', '||', '>>', '>&', ';;', '|', ';', '>', '<', '&', '(', ')'] : ['&&', '||', '>>', '>&', ';;', '|', ';', '>', '<', '&', '(', ')'];
    return choices.find((op) => source.startsWith(op, index));
  };
  function tokenize(source) {
    const tokens = [];
    let index = 0;
    while (index < source.length) {
      if (source[index] === '\n') { tokens.push({ type: 'op', value: ';', newline: true, start: index, end: ++index }); continue; }
      if (/\s/.test(source[index])) { index++; continue; }
      if (source[index] === '#') { while (index < source.length && source[index] !== '\n') index++; continue; }
      const op = operatorAt(source, index);
      if (op) { tokens.push({ type: 'op', value: op, start: index, end: index + op.length }); index += op.length; continue; }
      const start = index;
      const parts = [];
      let plain = '';
      const flush = () => { if (plain) { parts.push({ text: plain, quote: 'none' }); plain = ''; } };
      while (index < source.length && !/\s/.test(source[index]) && !operatorAt(source, index, false)) {
        const char = source[index];
        if (char === '\\') {
          flush(); index++;
          if (index >= source.length) throw new ShellSyntaxError('unfinished line continuation', true);
          if (source[index] !== '\n') parts.push({ text: source[index], quote: 'escaped' });
          index++; continue;
        }
        if (char === "'" || char === '"') {
          flush(); const delimiter = char; const mode = char === "'" ? 'single' : 'double';
          index++; let value = ''; let closed = false;
          while (index < source.length) {
            if (source[index] === delimiter) { closed = true; index++; break; }
            if (mode === 'double' && source[index] === '\\' && ['$', '`', '"', '\\', '\n'].includes(source[index + 1])) {
              if (value) { parts.push({ text: value, quote: mode }); value = ''; }
              index++;
              if (source[index] !== '\n') parts.push({ text: source[index], quote: 'escaped' });
              index++; continue;
            }
            if (mode === 'double' && (source[index] === '`' || source.startsWith('$(', index))) throw new ShellSyntaxError('command substitution is not supported');
            value += source[index++];
          }
          if (!closed) throw new ShellSyntaxError('unclosed ' + (mode === 'single' ? 'single' : 'double') + ' quote', true);
          parts.push({ text: value, quote: mode }); continue;
        }
        if (char === '`' || source.startsWith('$(', index)) throw new ShellSyntaxError('command substitution is not supported');
        plain += char; index++;
      }
      flush();
      if (parts.length) tokens.push({ type: 'word', parts, start, end: index });
    }
    return tokens;
  }
  const redirects = new Set(['>', '>>', '1>', '1>>', '2>', '2>>', '<', '2>&1', '1>&2']);
  function parse(tokens) {
    const pipelines = [];
    let position = 0;
    let connector = ';';
    while (position < tokens.length) {
      while (tokens[position] && tokens[position].newline) position++;
      if (position >= tokens.length) break;
      const commands = [];
      while (true) {
        const command = { words: [], redirects: [] };
        while (position < tokens.length) {
          const token = tokens[position];
          if (token.type === 'word') { command.words.push(token); position++; continue; }
          if (redirects.has(token.value)) {
            position++;
            let target = null;
            if (!['2>&1', '1>&2'].includes(token.value)) {
              if (!tokens[position]) throw new ShellSyntaxError('expected a file after ' + token.value, true);
              if (tokens[position].type !== 'word') throw new ShellSyntaxError('expected a file after ' + token.value);
              target = tokens[position++];
            }
            command.redirects.push({ op: token.value, target }); continue;
          }
          if (![';', '|', '&&', '||'].includes(token.value)) throw new ShellSyntaxError('unsupported operator: ' + token.value);
          break;
        }
        if (!command.words.length && !command.redirects.length) throw new ShellSyntaxError('expected a command');
        commands.push(command);
        if (tokens[position] && tokens[position].value === '|') {
          position++;
          if (!tokens[position]) throw new ShellSyntaxError('expected a command after |', true);
          while (tokens[position] && tokens[position].newline) position++;
          if (!tokens[position]) throw new ShellSyntaxError('expected a command after |', true);
          continue;
        }
        break;
      }
      pipelines.push({ connector, commands });
      if (position < tokens.length) {
        connector = tokens[position++].value;
        if (connector === '&&' || connector === '||') {
          while (tokens[position] && tokens[position].newline) position++;
          if (!tokens[position]) throw new ShellSyntaxError('expected a command after ' + connector, true);
        }
      }
    }
    return pipelines;
  }

  function globMatcher(pattern) {
    const tokens = [];
    for (let i = 0; i < pattern.length; i++) {
      const char = pattern[i];
      if (char === '*') { if (tokens[tokens.length - 1] !== '*') tokens.push('*'); }
      else if (char === '?') tokens.push({ any: true });
      else if (char === '[') {
        let start = i + 1;
        if (['!', '^'].includes(pattern[start])) start++;
        if (pattern[start] === ']') start++;
        const close = pattern.indexOf(']', start);
        if (close === -1) tokens.push({ literal: '[' });
        else {
          let content = pattern.slice(i + 1, close);
          const negative = ['!', '^'].includes(content[0]);
          if (negative) content = content.slice(1);
          tokens.push({ characters: content, negative }); i = close;
        }
      } else tokens.push({ literal: char });
    }
    const matches = (token, char) => {
      if (token.any) return true;
      if (own(token, 'literal')) return token.literal === char;
      let found = false;
      for (let i = 0; i < token.characters.length; i++) {
        if (token.characters[i + 1] === '-' && i + 2 < token.characters.length) {
          found ||= char >= token.characters[i] && char <= token.characters[i + 2]; i += 2;
        } else found ||= token.characters[i] === char;
      }
      return token.negative ? !found : found;
    };
    // A single remembered star gives bounded greedy matching. Compiling a glob
    // into a regular expression can otherwise freeze the UI on '*a*a*a...'.
    return { test(value) {
      let input = 0, token = 0, star = -1, retry = 0;
      while (input < value.length) {
        if (tokens[token] === '*') { star = token++; retry = input; }
        else if (tokens[token] && matches(tokens[token], value[input])) { token++; input++; }
        else if (star !== -1) { token = star + 1; input = ++retry; }
        else return false;
      }
      while (tokens[token] === '*') token++;
      return token === tokens.length;
    } };
  }

  class SumlacShell {
    constructor(options = {}) {
      this.commands = new Map();
      this.cwd = '/home/visitor';
      this.env = safeObject({ USER: 'visitor', LOGNAME: 'visitor', HOME: '/home/visitor', PWD: '/home/visitor', OLDPWD: '/home/visitor', SHELL: '/usr/bin/sumlac-shell', TERM: 'sumlac', LANG: 'en_US.UTF-8', PATH: '/usr/bin' });
      this.aliases = safeObject();
      this.history = [];
      this.lastExit = 0;
      this.pipefail = false;
      this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
      this.storageKey = options.storageKey || 'sumlac-terminal-v3';
      this.persistenceError = '';
      this._ready = false;
      this._depth = 0;
      this._steps = 0;
      this._seed = options.seed || {};
      try { this.storage = own(options, 'storage') ? options.storage : global.localStorage || null; }
      catch (_) { this.storage = null; this.persistenceError = 'Browser storage is unavailable; files will last for this session.'; }
      this.fs = new VirtualFileSystem(() => { if (this._ready) this.persist(); });
      let restored = false;
      if (this.storage) {
        try {
          const saved = this.storage.getItem(this.storageKey);
          if (saved) {
            if (saved.length > LIMITS.bytes * 3) throw error('EINVAL', 'saved session is too large');
            const state = JSON.parse(saved);
            if (state.version !== 3) throw error('EINVAL', 'saved session version changed');
            this.fs.restore(state.nodes);
            this.cwd = this.fs.exists('/home/visitor') ? '/home/visitor' : '/';
            if (typeof state.cwd === 'string' && this.fs.exists(state.cwd) && this.fs.stat(state.cwd).type === 'dir') this.cwd = state.cwd;
            if (state.env && typeof state.env === 'object') for (const [key, value] of Object.entries(state.env)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string') this.env[key] = value.slice(0, LIMITS.input);
            if (state.aliases && typeof state.aliases === 'object') for (const [key, value] of Object.entries(state.aliases)) if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) && typeof value === 'string') this.aliases[key] = value.slice(0, LIMITS.input);
            if (Array.isArray(state.history)) this.history = state.history.filter((line) => typeof line === 'string' && line.length <= LIMITS.input).slice(-500);
            this.pipefail = !!state.pipefail;
            restored = true;
          }
        } catch (_) {
          this.fs = new VirtualFileSystem(() => { if (this._ready) this.persist(); });
          this.persistenceError = 'The saved shell session could not be loaded; a fresh session is available.';
        }
      }
      this._applySeed(restored);
      this._trimHistory();
      this.env.PWD = this.cwd;
      this._installBuiltins();
      if (typeof global.installTerminalCommands === 'function') global.installTerminalCommands(this);
      this._ready = true;
    }
    _applySeed(restored) {
      const ensureDirectory = (path) => {
        if (this.fs.exists(path)) return;
        const parts = this.fs.normalize(path, '/').split('/').filter(Boolean);
        let current = '';
        for (const part of parts) { current += '/' + part; if (!this.fs.nodes.has(current)) this.fs.nodes.set(current, this.fs.node('dir')); }
      };
      if (restored) return;
      for (const path of ['/home/visitor', '/tmp', '/usr/share/sumlac', '/dev']) ensureDirectory(path);
      if (!this.fs.exists('/dev/null')) this.fs.nodes.set('/dev/null', this.fs.node('file', ''));
      for (const [inputPath, value] of Object.entries(this._seed)) {
        const path = this.fs.normalize(inputPath, '/');
        const type = value && typeof value === 'object' && value.type === 'dir' ? 'dir' : 'file';
        ensureDirectory(dirname(path));
        this.fs.nodes.set(path, this.fs.node(type, value && typeof value === 'object' ? value.content || '' : value || ''));
      }
      this.fs._capacity(this.fs.nodes);
    }
    persist() {
      if (!this.storage || !this._ready) return false;
      try {
        this.storage.setItem(this.storageKey, JSON.stringify({ version: 3, nodes: this.fs.serialize(), cwd: this.cwd, env: this.env, aliases: this.aliases, history: this.history.slice(-500), pipefail: this.pipefail }));
        this.persistenceError = '';
        return true;
      } catch (_) { this.persistenceError = 'Browser storage is full or unavailable; current changes last for this session.'; return false; }
    }
    _trimHistory() {
      this.history = this.history.slice(-500);
      let size = 0;
      for (let index = this.history.length - 1; index >= 0; index--) {
        size += byteLength(this.history[index]);
        if (size > 128 * 1024) { this.history = this.history.slice(index + 1); break; }
      }
    }
    register(name, definition, metadata = {}) {
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name) && !['.', '['].includes(name)) throw error('EINVAL', 'invalid command name');
      if (typeof definition === 'function') definition = Object.assign({}, metadata, { run: definition });
      if (!definition || typeof definition.run !== 'function') throw error('EINVAL', 'command needs a run function');
      this.commands.set(name, Object.assign({ summary: '', usage: name }, definition));
      return this;
    }
    isIncomplete(line) {
      try { parse(tokenize(String(line))); return false; }
      catch (failure) { return !!failure.incomplete; }
    }
    glob(pattern, cwd = this.cwd) {
      pattern = String(pattern);
      const absolute = pattern.startsWith('/');
      const normalized = this.fs.normalize(pattern, cwd);
      const components = normalized.split('/').filter(Boolean);
      let candidates = ['/'];
      for (const component of components) {
        const next = [];
        const expression = globMatcher(component);
        for (const parent of candidates) {
          try {
            for (const entry of this.fs.list(parent)) if ((!entry.name.startsWith('.') || component.startsWith('.')) && expression.test(entry.name)) next.push(entry.path);
          } catch (_) { /* A file cannot be traversed as a directory. */ }
        }
        candidates = next;
        if (!candidates.length) break;
      }
      const relative = (path) => {
        if (absolute) return path;
        const from = cwd.split('/').filter(Boolean), to = path.split('/').filter(Boolean);
        while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift(); }
        return [...from.map(() => '..'), ...to].join('/') || '.';
      };
      return candidates.sort().map(relative);
    }
    _variable(text, env, positional = [], argv0 = 'sumlac-shell') {
      return text.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*|[?0-9#@*])/g, (match, braced, bare) => {
        const name = braced === undefined ? bare : braced;
        if (name === '?') return String(this.lastExit);
        if (name === '0') return argv0;
        if (name === '#') return String(positional.length);
        if (name === '@' || name === '*') return positional.join(' ');
        if (/^[1-9]$/.test(name)) return positional[Number(name) - 1] || '';
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new ShellSyntaxError('unsupported parameter expansion: ' + match);
        return own(env, name) ? String(env[name]) : '';
      });
    }
    _expandWord(token, env, positional = [], assignment = false, argv0 = 'sumlac-shell') {
      if (!assignment && token.parts.length === 1 && token.parts[0].quote === 'double' && ['$@', '${@}'].includes(token.parts[0].text)) return positional.slice();
      let variants = [{ text: '', pattern: '', forced: false }];
      let first = true;
      for (const part of token.parts) {
        let value = part.text;
        if (first && part.quote === 'none') value = value.replace(/^~(?=\/|$)/, env.HOME || '/home/visitor').replace(/^~visitor(?=\/|$)/, '/home/visitor');
        first = false;
        if (part.quote === 'none' || part.quote === 'double') value = this._variable(value, env, positional, argv0);
        const splittable = part.quote === 'none' && !assignment && /\$/.test(part.text);
        const pieces = splittable ? value.split(/([\t\n ]+)/) : [value];
        for (const piece of pieces) {
          if (splittable && /^[\t\n ]+$/.test(piece)) {
            const current = variants[variants.length - 1];
            if (current.text || current.forced) variants.push({ text: '', pattern: '', forced: false });
            continue;
          }
          const current = variants[variants.length - 1];
          current.text += piece;
          // Private-use sentinels keep quoted wildcard characters literal during matching.
          current.pattern += part.quote === 'none' ? piece : piece.replace(/[*?\[]/g, (char) => ({ '*': '\uE000', '?': '\uE001', '[': '\uE002' }[char]));
          if (part.quote !== 'none') current.forced = true;
        }
      }
      variants = variants.filter((variant) => variant.text || variant.forced || assignment);
      const output = [];
      for (const variant of variants) {
        if (!assignment && /[*?\[]/.test(variant.pattern)) {
          const escaped = variant.pattern.replace(/\uE000/g, '[*]').replace(/\uE001/g, '[?]').replace(/\uE002/g, '[[]');
          const matches = this.glob(escaped);
          output.push(...(matches.length ? matches : [variant.text]));
        } else output.push(variant.text);
      }
      return output;
    }
    async execute(line, options = {}) {
      line = String(line);
      if (this._executing) return { stdout: '', stderr: 'shell: a command is already running\n', code: 1, events: [] };
      if (line.length > LIMITS.input) return { stdout: '', stderr: 'shell: command exceeds the 32 KiB limit\n', code: 2, events: [] };
      const trimmed = line.trim();
      if (/^!(?:!|-?\d+|[^\s]+)$/.test(trimmed)) {
        let previous;
        if (trimmed === '!!') previous = this.history[this.history.length - 1];
        else if (/^!-\d+$/.test(trimmed)) previous = this.history[this.history.length - Number(trimmed.slice(2))];
        else if (/^!\d+$/.test(trimmed)) previous = this.history[Number(trimmed.slice(1)) - 1];
        else previous = [...this.history].reverse().find((entry) => entry.startsWith(trimmed.slice(1)));
        if (previous === undefined) { this.lastExit = 1; return { stdout: '', stderr: 'history: event not found: ' + trimmed + '\n', code: 1, events: [] }; }
        line = previous;
      }
      if (line.trim() && this.history[this.history.length - 1] !== line) this.history.push(line);
      this._trimHistory();
      this._executing = true;
      this._steps = 0;
      try { return await this.run(line, options); }
      finally { this._executing = false; this.persist(); }
    }
    async run(line, options = {}) {
      if (options.replaceEnv || options.isolated) {
        const previous = { env: this.env, cwd: this.cwd, aliases: this.aliases, pipefail: this.pipefail };
        this.env = safeObject(options.replaceEnv ? options.env : options.env || this.env);
        this.aliases = safeObject(this.aliases);
        try {
          return await this.run(line, Object.assign({}, options, { env: undefined, _scope: undefined, replaceEnv: false, isolated: false, suppressExit: true }));
        } finally { this.env = previous.env; this.cwd = previous.cwd; this.aliases = previous.aliases; this.pipefail = previous.pipefail; }
      }
      const top = this._depth === 0;
      if (top && !this._executing) this._steps = 0;
      // Keep temporary assignments separate from live shell variables. A sourced
      // script can then export a variable and use its new value on the next line.
      const scope = safeObject(options._scope);
      if (options.env) for (const [name, value] of Object.entries(options.env)) if (!own(this.env, name) || this.env[name] !== value) scope[name] = value;
      options = Object.assign({}, options, { _scope: scope });
      const events = [];
      let stdout = '', stderr = '', code = this.lastExit;
      let pendingOut = '', pendingErr = '', pendingEvents = [];
      const consumer = top ? (update) => {
        if (typeof options.onOutput === 'function') { try { options.onOutput(update); } catch (_) { /* Rendering cannot break commands. */ } }
        for (const event of update.events) { try { this.onEvent(event); } catch (_) { /* Rendering cannot break commands. */ } }
      } : options._stream;
      const stream = typeof consumer === 'function' ? (update) => consumer(options.suppressExit ? Object.assign({}, update, { events: update.events.filter((event) => event.type !== 'exit') }) : update) : null;
      const publish = () => {
        if (typeof stream !== 'function') return;
        if (pendingOut || pendingErr || pendingEvents.length) stream({ stdout: pendingOut, stderr: pendingErr, events: pendingEvents });
        pendingOut = ''; pendingErr = ''; pendingEvents = [];
      };
      this._depth++;
      try {
        checkAbort(options.signal);
        if (this._depth > LIMITS.depth) throw error('ELOOP', 'shell recursion limit reached');
        if (String(line).length > LIMITS.input) throw error('E2BIG', 'command exceeds the 32 KiB limit');
        const program = parse(tokenize(String(line)));
        for (const pipeline of program) {
          checkAbort(options.signal);
          if (pipeline.connector === '&&' && code !== 0) continue;
          if (pipeline.connector === '||' && code === 0) continue;
          let input = options.stdin || '';
          let finalStreamed = false;
          const statuses = [];
          for (let stage = 0; stage < pipeline.commands.length; stage++) {
            const command = pipeline.commands[stage];
            if (++this._steps > LIMITS.steps) throw error('ELOOP', 'command limit reached');
            checkAbort(options.signal);
            const hasStdin = stage > 0 || (own(options, 'hasStdin') ? !!options.hasStdin : own(options, 'stdin'));
            // A nested alias or sourced script can publish directly only when
            // its output is going to the display, rather than another pipe.
            const finalStage = stage === pipeline.commands.length - 1;
            const result = await this._simple(command, Object.assign({}, options, { stdin: input, hasStdin, pipedInput: stage > 0, interactive: !!options.interactive && finalStage, _stream: finalStage ? stream : null }));
            input = result.stdout;
            stderr += result.stderr;
            finalStreamed = !!result._streamed;
            if (!result._streamed) { pendingErr += result.stderr; pendingEvents.push(...result.events); }
            statuses.push(result.code);
            events.push(...result.events);
            this.lastExit = result.code;
            if (events.some((event) => event.type === 'exit' || event.type === 'reset')) break;
          }
          code = this.pipefail ? [...statuses].reverse().find((status) => status !== 0) || 0 : statuses[statuses.length - 1] || 0;
          this.lastExit = code;
          stdout += input;
          if (!finalStreamed) pendingOut += input;
          if (stdout.length + stderr.length > LIMITS.output) throw error('E2BIG', 'output limit reached (256 KiB)');
          publish();
          if (events.some((event) => event.type === 'exit' || event.type === 'reset')) break;
        }
      } catch (failure) {
        if (failure.name === 'AbortError' || (options.signal && options.signal.aborted)) code = 130;
        else { code = failure instanceof ShellSyntaxError ? 2 : 1; const message = 'shell: ' + failure.message + '\n'; stderr += message; pendingErr += message; }
      } finally { this._depth--; }
      this.lastExit = code;
      if (top) this.persist();
      // Reserve room for diagnostics when truncating a command's output.
      stderr = stderr.slice(0, LIMITS.output);
      stdout = stdout.slice(0, Math.max(0, LIMITS.output - stderr.length));
      pendingErr = pendingErr.slice(0, LIMITS.output);
      pendingOut = pendingOut.slice(0, Math.max(0, LIMITS.output - pendingErr.length));
      publish();
      const result = { stdout, stderr, code, events: options.suppressExit ? events.filter((event) => event.type !== 'exit') : events };
      if (!top && typeof stream === 'function') result._streamed = true;
      return result;
    }
    async _simple(command, options) {
      const baseEnv = Object.assign(safeObject(this.env), options._scope || {});
      const env = safeObject(baseEnv);
      const positional = options.positional || [];
      const args = [];
      const assignments = [];
      let assigning = true;
      for (const word of command.words) {
        const initial = word.parts[0];
        const assignment = assigning && initial && initial.quote === 'none' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(initial.text);
        const expanded = this._expandWord(word, assignment ? env : baseEnv, positional, assignment, options.argv0);
        if (assignment) {
          const [value = ''] = expanded;
          const equals = value.indexOf('=');
          env[value.slice(0, equals)] = value.slice(equals + 1);
          assignments.push([value.slice(0, equals), value.slice(equals + 1)]);
        } else { assigning = false; args.push(...expanded); }
      }
      let stdin = options.stdin || '';
      // Redirection targets are descriptors, so duplication follows left-to-right order.
      const output = { chunks: '' }, errors = { chunks: '' };
      const descriptors = { 1: output, 2: errors };
      const sinks = [];
      const events = [];
      try {
        for (const redirect of command.redirects) {
          if (redirect.op === '2>&1') { descriptors[2] = descriptors[1]; continue; }
          if (redirect.op === '1>&2') { descriptors[1] = descriptors[2]; continue; }
          const targets = this._expandWord(redirect.target, baseEnv, positional, false, options.argv0);
          if (targets.length !== 1) throw error('EINVAL', 'ambiguous redirect');
          const path = this.fs.normalize(targets[0], this.cwd);
          if (redirect.op === '<') { stdin = this.fs.readFile(path); continue; }
          const append = redirect.op.endsWith('>>');
          if (append) this.fs.appendFile(path, ''); else this.fs.writeFile(path, '');
          const sink = { path, chunks: '' };
          sinks.push(sink);
          descriptors[redirect.op.startsWith('2') ? 2 : 1] = sink;
        }
        let result = { stdout: '', stderr: '', code: 0 };
        const stream = descriptors[1] === output && descriptors[2] === errors ? options._stream : null;
        if (!args.length) {
          for (const [key, value] of assignments) {
            this.env[key] = value;
            if (own(options._scope, key)) options._scope[key] = value;
          }
        } else if (own(this.aliases, args[0]) && !options.noAlias) {
          result = await this.run(this.aliases[args[0]] + (args.length > 1 ? ' ' + args.slice(1).map(quote).join(' ') : ''), Object.assign({}, options, { env, stdin, _stream: stream, hasStdin: options.hasStdin || command.redirects.some((redirect) => redirect.op === '<') }));
        } else {
          const definition = this.commands.get(args[0]);
          if (!definition && args[0].includes('/')) {
            const scriptPath = this.fs.normalize(args[0], this.cwd);
            try {
              const stat = this.fs.stat(scriptPath);
              if (stat.type !== 'file' || !(stat.mode & 0o100)) throw error('EACCES', 'permission denied');
              const script = this.fs.readFile(scriptPath);
              result = await this.run(script, { signal: options.signal, stdin, hasStdin: options.hasStdin || command.redirects.some((redirect) => redirect.op === '<'), interactive: !!options.interactive && descriptors[1] === output, _stream: stream, env, isolated: true, positional: args.slice(1), argv0: args[0] });
            } catch (failure) { if (failure.name === 'AbortError') throw failure; result = { stderr: args[0] + ': ' + failure.message + '\n', code: failure.code === 'ENOENT' ? 127 : 126 }; }
          }
          else if (!definition) result = { stdout: '', stderr: args[0] + ': command not found. Type help for available commands.\n', code: 127 };
          else {
            const emit = (event) => { if (event && typeof event.type === 'string') events.push(event); };
            const stdoutTTY = !!options.interactive && descriptors[1] === output;
            const stdinTTY = !!options.interactive && !options.pipedInput && !command.redirects.some((redirect) => redirect.op === '<');
            const hasStdin = !!options.hasStdin || command.redirects.some((redirect) => redirect.op === '<');
            result = await definition.run({ args: args.slice(1), shell: this, stdin, signal: options.signal, env, fs: this.fs, cwd: this.cwd, emit, positional, argv0: options.argv0 || 'sumlac-shell', interactive: stdoutTTY, stdoutTTY, stdinTTY, hasStdin, scope: options._scope, stream }, args.slice(1));
            result = result || {};
          }
        }
        checkAbort(options.signal);
        descriptors[1].chunks += String(result.stdout || '');
        descriptors[2].chunks += String(result.stderr || '');
        if (result.events) events.push(...result.events);
        for (const sink of sinks) if (sink.chunks) { this.fs.appendFile(sink.path, sink.chunks); sink.flushed = true; }
        return { stdout: output.chunks, stderr: errors.chunks, code: Number.isInteger(result.code) ? result.code : 0, events, _streamed: !!result._streamed };
      } catch (failure) {
        if (failure.name === 'AbortError') throw failure;
        const message = (args[0] ? args[0] + ': ' : 'shell: ') + failure.message + '\n';
        descriptors[2].chunks += message;
        for (const sink of sinks) if (sink.chunks && !sink.flushed) { try { this.fs.appendFile(sink.path, sink.chunks); } catch (_) { errors.chunks += 'shell: failed to write redirected output\n'; } }
        return { stdout: output.chunks, stderr: errors.chunks, code: failure instanceof ShellSyntaxError ? 2 : 1, events };
      }
    }
    complete(line, cursor = String(line).length) {
      line = String(line); cursor = Math.max(0, Math.min(cursor, line.length));
      const before = line.slice(0, cursor);
      let tokens, openQuote = '';
      try { tokens = tokenize(before); }
      catch (failure) {
        if (failure.message === 'unclosed single quote') openQuote = "'";
        else if (failure.message === 'unclosed double quote') openQuote = '"';
        else return { line, cursor, candidates: [] };
        try {
          tokens = tokenize(before + openQuote);
          if (tokens.length) tokens[tokens.length - 1].end = cursor;
        } catch (_) { return { line, cursor, candidates: [] }; }
      }
      let token = tokens[tokens.length - 1];
      const hasWord = token && token.type === 'word' && token.end === cursor;
      const start = hasWord ? token.start : cursor;
      const raw = hasWord ? token.parts.map((part) => part.text).join('') : '';
      const previous = hasWord ? tokens.slice(0, -1) : tokens;
      const commandPosition = !previous.length || (previous[previous.length - 1].type === 'op' && [';', '|', '&&', '||'].includes(previous[previous.length - 1].value));
      let candidates = [];
      if (commandPosition && !raw.includes('/')) candidates.push(...Array.from(new Set([...this.commands.keys(), ...Object.keys(this.aliases)])).filter((name) => name.startsWith(raw)));
      if (!commandPosition || raw.includes('/') || raw.startsWith('.') || raw.startsWith('~')) {
        let expanded = raw;
        try { if (hasWord) expanded = this._expandWord(token, this.env, [], true)[0] || ''; }
        catch (_) { return { line, cursor, candidates: [] }; }
        const bareHome = hasWord && token.parts[0].quote === 'none' && ['~', '~visitor'].includes(raw);
        const slash = expanded.lastIndexOf('/');
        const parent = slash < 0 ? '.' : expanded.slice(0, slash + 1) || '/';
        const prefix = slash < 0 ? expanded : expanded.slice(slash + 1);
        const displayPath = raw.startsWith('~/') || raw.startsWith('~visitor/') || raw === expanded ? raw : expanded;
        const originalSlash = displayPath.lastIndexOf('/');
        const originalParent = originalSlash < 0 ? '' : displayPath.slice(0, originalSlash + 1);
        try {
          let commandStart = 0;
          previous.forEach((entry, index) => { if (entry.type === 'op' && [';', '|', '&&', '||'].includes(entry.value)) commandStart = index + 1; });
          const firstWord = previous.slice(commandStart).find((entry) => entry.type === 'word');
          const directoryOnly = firstWord && firstWord.parts.map((part) => part.text).join('') === 'cd';
          if (bareHome) { if (this.fs.stat(expanded, this.cwd).type === 'dir') candidates.push(raw + '/'); }
          else candidates.push(...this.fs.list(parent, this.cwd).filter((entry) => entry.name.startsWith(prefix) && (!entry.name.startsWith('.') || prefix.startsWith('.')) && (!directoryOnly || entry.type === 'dir')).map((entry) => originalParent + entry.name + (entry.type === 'dir' ? '/' : '')));
        } catch (_) { /* No path matches. */ }
      }
      candidates = Array.from(new Set(candidates)).sort();
      if (!candidates.length) return { line, cursor, candidates };
      let prefix = candidates[0];
      for (const candidate of candidates.slice(1)) while (prefix && !candidate.startsWith(prefix)) prefix = prefix.slice(0, -1);
      if (prefix.length < raw.length) return { line, cursor, candidates };
      const suffix = candidates.length === 1 && !prefix.endsWith('/') ? ' ' : '';
      let replacement;
      if (openQuote === '"') replacement = '"' + prefix.replace(/[\\"$`]/g, '\\$&') + (suffix ? '"' + suffix : '');
      else if (openQuote === "'") replacement = quote(prefix).slice(0, -1) + (suffix ? "'" + suffix : '');
      else replacement = prefix.replace(/([\s\\'"$`;&|<>()#])/g, '\\$1') + suffix;
      return { line: line.slice(0, start) + replacement + line.slice(cursor), cursor: start + replacement.length, candidates };
    }
    _installBuiltins() {
      const register = (name, summary, usage, run) => this.register(name, { summary, usage, run });
      register('help', 'List commands and shell features', 'help [command]', ({ args }) => {
        if (args.length) {
          const command = this.commands.get(args[0]);
          return command ? { stdout: command.usage + '\n' + command.summary + '\n' } : { stderr: 'help: no help for ' + args[0] + '\n', code: 1 };
        }
        const list = Array.from(this.commands).sort(([a], [b]) => a.localeCompare(b)).map(([name, command]) => name.padEnd(14) + command.summary).join('\n');
        return { stdout: 'Browser shell — files and settings are saved on this device.\n\n' + list + '\n\nShell: quotes, $VARIABLES, ~, globs, pipes |, ;, &&, ||, <, >, >>, 2>, 2>>, 2>&1.\nUse man <command> for usage. Tab completes commands and paths.\nThis shell runs browser commands; it does not access a host OS or execute native programs.\n' };
      });
      register('man', 'Show command usage', 'man <command>', ({ args }) => {
        if (!args.length) return { stderr: 'man: supply a command name\n', code: 2 };
        const command = this.commands.get(args[0]);
        return command ? { stdout: args[0].toUpperCase() + '\n\nUSAGE\n  ' + command.usage + '\n\n' + command.summary + (command.description ? '\n\n' + command.description : '') + '\n' } : { stderr: 'man: no manual entry for ' + args[0] + '\n', code: 1 };
      });
      register('pwd', 'Print current directory', 'pwd', () => ({ stdout: this.cwd + '\n' }));
      register('cd', 'Change working directory', 'cd [directory|-]', ({ args, env }) => {
        if (args.length > 1) return { stderr: 'cd: too many arguments\n', code: 2 };
        const path = this.fs.normalize(args[0] === '-' ? this.env.OLDPWD || env.HOME : args[0] || env.HOME || '/', this.cwd);
        this.fs._directory(path);
        const previous = this.cwd; this.cwd = path; this.env.PWD = path; this.env.OLDPWD = previous;
        return { stdout: args[0] === '-' ? path + '\n' : '' };
      });
      register('true', 'Return success', 'true', () => ({ code: 0 }));
      register('false', 'Return failure', 'false', () => ({ code: 1 }));
      const clearDisplay = ({ emit, interactive }) => { if (interactive) { emit({ type: 'clear' }); return {}; } return { stdout: '\x1b[H\x1b[2J' }; };
      register('clear', 'Clear the terminal display', 'clear', clearDisplay);
      register('exit', 'Close the terminal session', 'exit [status]', ({ args, emit }) => {
        if (args.length > 1 || (args.length && !/^-?\d+$/.test(args[0]))) return { stderr: 'exit: expected a numeric status\n', code: 2 };
        const code = args.length ? ((Number(args[0]) % 256) + 256) % 256 : this.lastExit;
        emit({ type: 'exit' }); return { code };
      });
      register('export', 'Set environment variables', 'export [NAME=value|NAME ...]', ({ args, env, scope }) => {
        if (!args.length) return { stdout: Object.keys(env).sort().map((name) => 'export ' + name + '=' + quote(env[name])).join('\n') + '\n' };
        let stderr = '';
        for (const assignment of args) {
          const equals = assignment.indexOf('=');
          const name = equals < 0 ? assignment : assignment.slice(0, equals);
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) { stderr += 'export: invalid identifier: ' + name + '\n'; continue; }
          this.env[name] = equals < 0 ? this.env[name] || '' : assignment.slice(equals + 1);
          if (own(scope, name)) scope[name] = this.env[name];
        }
        return { stderr, code: stderr ? 1 : 0 };
      });
      register('unset', 'Remove environment variables', 'unset NAME ...', ({ args, scope }) => { for (const name of args) { delete this.env[name]; delete scope[name]; } return {}; });
      register('set', 'Show variables or configure pipeline status', 'set [-o pipefail|+o pipefail]', ({ args }) => {
        if (!args.length) return { stdout: Object.keys(this.env).sort().map((key) => key + '=' + quote(this.env[key])).join('\n') + '\n' };
        if (args.length === 2 && ['-o', '+o'].includes(args[0]) && args[1] === 'pipefail') { this.pipefail = args[0] === '-o'; return {}; }
        return { stderr: 'set: supported option: -o pipefail or +o pipefail\n', code: 2 };
      });
      register('alias', 'Create or inspect command aliases', "alias [name='command' ...]", ({ args }) => {
        if (!args.length) return { stdout: Object.keys(this.aliases).sort().map((name) => 'alias ' + name + '=' + quote(this.aliases[name])).join('\n') + (Object.keys(this.aliases).length ? '\n' : '') };
        let stdout = '', stderr = '';
        for (const item of args) {
          const equals = item.indexOf('=');
          const name = equals < 0 ? item : item.slice(0, equals);
          if (equals < 0) {
            if (own(this.aliases, name)) stdout += 'alias ' + name + '=' + quote(this.aliases[name]) + '\n';
            else stderr += 'alias: ' + name + ': not found\n';
          } else if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) stderr += 'alias: invalid name: ' + name + '\n';
          else this.aliases[name] = item.slice(equals + 1);
        }
        return { stdout, stderr, code: stderr ? 1 : 0 };
      });
      register('unalias', 'Remove aliases', 'unalias [-a|name ...]', ({ args }) => {
        if (args[0] === '-a') this.aliases = safeObject();
        else for (const name of args) delete this.aliases[name];
        return {};
      });
      register('history', 'Show or clear command history', 'history [count|-c|-d number]', ({ args }) => {
        if (args[0] === '-c') { this.history = []; return {}; }
        if (args[0] === '-d') {
          const number = Number(args[1]);
          if (!Number.isInteger(number) || number < 1 || number > this.history.length) return { stderr: 'history: invalid history position\n', code: 1 };
          this.history.splice(number - 1, 1); return {};
        }
        const count = args.length ? Number(args[0]) : this.history.length;
        if (!Number.isInteger(count) || count < 0) return { stderr: 'history: expected a nonnegative count\n', code: 2 };
        const start = Math.max(0, this.history.length - count);
        return { stdout: this.history.slice(start).map((line, index) => String(start + index + 1).padStart(4) + '  ' + line).join('\n') + (this.history.length && count ? '\n' : '') };
      });
      const source = async ({ args, signal, stdin, env, interactive, hasStdin, stream, positional, argv0 }) => {
        if (!args.length) return { stderr: 'source: supply a script path\n', code: 2 };
        return this.run(this.fs.readFile(args[0], this.cwd), { signal, stdin, env, interactive, hasStdin, _stream: stream, positional: args.length > 1 ? args.slice(1) : positional, argv0 });
      };
      register('source', 'Run a file using the supported shell syntax', 'source <file> [args ...]', source);
      register('.', 'Run a file in this shell', '. <file> [args ...]', source);
      register('sh', 'Run the supported browser shell syntax in an isolated session', 'sh -c command [name [args ...]] | sh file [args ...]', async ({ args, signal, stdin, env, interactive, hasStdin, stream }) => {
        if (!args.length || (args[0] === '-c' && args.length < 2)) return { stderr: 'sh: supply a script file or -c command\n', code: 2 };
        const inline = args[0] === '-c';
        const script = inline ? args[1] : this.fs.readFile(args[0], this.cwd);
        return this.run(script, { signal, stdin, env, interactive, hasStdin, _stream: stream, isolated: true, positional: args.slice(inline ? 3 : 1), argv0: inline ? args[2] || 'sumlac-shell' : args[0] });
      });
      register('type', 'Describe commands or aliases', 'type <name> ...', ({ args }) => {
        let stdout = '', stderr = '';
        for (const name of args) {
          if (own(this.aliases, name)) stdout += name + ' is aliased to ' + quote(this.aliases[name]) + '\n';
          else if (this.commands.has(name)) stdout += name + ' is a browser shell command\n';
          else stderr += 'type: ' + name + ': not found\n';
        }
        return { stdout, stderr, code: stderr ? 1 : 0 };
      });
      register('command', 'Run a command without alias expansion', 'command <name> [args ...]', ({ args, signal, stdin, env, interactive, hasStdin, stream, positional, argv0 }) => this.run(args.map(quote).join(' '), { signal, stdin, env, interactive, hasStdin, _stream: stream, noAlias: true, positional, argv0 }));
      register('reset', 'Reset the terminal display', 'reset', clearDisplay);
      register('reset-files', 'Restore the initial browser filesystem and session', 'reset-files --yes', ({ args, emit }) => {
        if (args[0] !== '--yes' || args.length !== 1) return { stdout: 'This removes the files, history, aliases, and settings saved by this browser shell.\nRun reset-files --yes to restore the initial session.\n' };
        this.fs.nodes = new Map([['/', this.fs.node('dir')]]);
        this.cwd = '/home/visitor';
        this.env = safeObject({ USER: 'visitor', LOGNAME: 'visitor', HOME: this.cwd, PWD: this.cwd, OLDPWD: this.cwd, SHELL: '/usr/bin/sumlac-shell', TERM: 'sumlac', LANG: 'en_US.UTF-8', PATH: '/usr/bin' });
        this.aliases = safeObject(); this.history = []; this.pipefail = false; this._applySeed(false);
        emit({ type: 'reset' }); return { stdout: 'Browser shell reset.\n' };
      });
    }
  }
  SumlacShell.VirtualFileSystem = VirtualFileSystem;
  SumlacShell.LIMITS = LIMITS;
  SumlacShell.quote = quote;
  SumlacShell.tokenize = tokenize;
  global.SumlacShell = SumlacShell;
  if (typeof module !== 'undefined' && module.exports) module.exports = SumlacShell;
})(typeof globalThis !== 'undefined' ? globalThis : window);
