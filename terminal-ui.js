/* Browser terminal UI. The shell and filesystem live in terminal-engine.js. */
(() => {
  'use strict';
  const input = document.getElementById('terminal-input');
  if (!input || !window.SumlacShell) return;
  const terminal = document.getElementById('terminal-window');
  const body = document.getElementById('terminal-body');
  const output = document.getElementById('terminal-output');
  const form = document.getElementById('terminal-form');
  const modePanel = document.getElementById('terminal-mode');
  const stateLabel = document.getElementById('terminal-state');
  const cwdLabel = document.getElementById('terminal-cwd');
  const stop = document.getElementById('terminal-stop');
  const expand = document.getElementById('terminal-expand');
  const runButton = document.getElementById('terminal-run');
  let busy = false;
  let controller = null;
  let mode = null;
  let historyPosition = 0;
  let draft = '';
  let reverseSearch = null;
  let expanded = false;
  let exited = false;
  let externalFocus = false;

  const node = (tag, className, text) => {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  };
  const button = (text, action, className = '') => {
    const result = node('button', className, text);
    result.type = 'button';
    result.addEventListener('click', action);
    return result;
  };
  const readText = selector => document.querySelector(selector)?.textContent.trim() || '';
  const home = '/home/visitor';
  const about = `${readText('#hero-name')}\n${readText('#hero-title')}\n\n${readText('.hero-description')}\n`;
  const career = [...document.querySelectorAll('.timeline-item')].map(item =>
    ['.timeline-date', '.timeline-role', '.timeline-company', '.timeline-desc'].map(selector => item.querySelector(selector)?.textContent.trim()).filter(Boolean).join('\n')
  ).join('\n\n') + '\n';
  const skills = [...document.querySelectorAll('#skills > div')].map(item =>
    item.classList.contains('skill-category') ? `\n[${item.textContent.trim()}]` : `  ${item.textContent.trim()}`
  ).join('\n').trim() + '\n';
  const stack = [...document.querySelectorAll('.arsenal-lab .lab-line')].map(item =>
    `${item.querySelector('.lab-key').textContent.trim().replace(/\s+/g, '_').toUpperCase()}=${item.querySelector('.lab-val').textContent.trim()}`
  ).join('\n') + '\n';
  const references = [...document.querySelectorAll('.reference-links a')].map(a => `${a.textContent.replace('↗', '').trim()}\n${a.href}`).join('\n\n') + '\n';
  const threatmodel = [
    'THREAT MODEL / RETRIEVAL-AUGMENTED AGENT', '',
    'INPUT  User request, retrieved documents, and tool results.',
    '       External content is data, not authority.',
    'MODEL  Plans actions and produces untrusted output.',
    '       Validate outputs before rendering or execution.',
    'TOOLS  Authorize every action outside the model.',
    '       Bind approval to exact arguments, scope, and destination.',
    'DATA   Enforce tenant and document permissions at retrieval.',
    '       Keep credentials outside model context.', '',
    'TEST   Exfiltration, cross-tenant access, unauthorized actions,',
    '       output handling, resource limits, and legitimate workflows.', ''
  ].join('\n');
  const defense = [
    'DEFENSE FACTORY / MY THESIS', '',
    'I want every meaningful failure to make the system harder to break.',
    'Reproduce -> prioritize -> prepare a patch -> verify -> retain the test.',
    'Reproducible findings from offense feed the same evidence loop.', '',
    'HOW I WOULD BUILD IT',
    '  Evidence first: a minimal case, expected behavior, and actual impact.',
    '  Fix the boundary: permissions, retrieval, tools, or output handling.',
    '  Verify independently: block the failure and preserve legitimate work.',
    '  Keep the lesson: a regression that offense can challenge again.',
    '  Measure the loop: time to verified fix, cost, and recurrence.', '',
    'The public page develops this vision with illustrative walkthroughs.', '',
    'Page: https://sumlac.com/defense-factory/',
    'Try: open defense', ''
  ].join('\n');
  const offense = [
    'OFFENSE FACTORY / MY THESIS', '',
    'I want red teaming to keep pace with every change to the system.',
    'Scope -> hypothesize -> probe -> reproduce -> hand off -> evolve.', '',
    'HOW I WOULD BUILD IT',
    '  Scope the target: explicit authorization and isolated test fixtures.',
    '  Challenge the whole system: model, retrieval, tools, and identity.',
    '  Prove impact: a reproducible boundary failure, not a scary answer.',
    '  Hand off evidence: the smallest case a defender can replay.',
    '  Evolve the corpus: retest repairs and explore adjacent failure modes.', '',
    'The public page develops this vision with illustrative walkthroughs.', '',
    'Page: https://sumlac.com/offense-factory/',
    'Try: open offense', ''
  ].join('\n');
  const readme = [
    'SUMLAC / VISITOR WORKSPACE', '',
    'This shell runs in your browser. Its files are local to this device.',
    'It cannot access the website server or your computer\'s files.', '',
    'EXPLORE',
    '  about                 Justin Calmus',
    '  ai                    Current stack and focus',
    '  factories             Continuous offense and defense',
    '  cat resume.txt        Career',
    '  ls arsenal/           Security tools',
    '  threatmodel           AI application trust boundaries',
    '  lab                   Open the interactive security lab', '',
    'BUILD',
    '  mkdir -p work/notes && cd work',
    '  printf "agents\\nmodels\\nagents\\n" > ideas.txt',
    '  sort ideas.txt | uniq -c',
    '  grep -n agents ideas.txt',
    '  nano notes.txt        Edit and save a file',
    '  less ~/resume.txt     Page through a document',
    '  download notes.txt    Save a copy to your computer', '',
    'SHELL',
    '  help                  List supported commands',
    '  man command           Usage and supported options',
    '  Tab                   Complete commands and paths',
    '  Up / Down             Navigate command history',
    '  Ctrl+R                Search command history',
    '  Ctrl+C                Cancel input or a running command',
    '  Ctrl+L                Clear the screen',
    '  Shift+Enter           Insert a new line', '',
    'Files and history persist in this browser when storage is available.',
    'Pipes, redirects, quotes, variables, aliases, and && / || are supported.',
    'Use help and man for the exact supported shell syntax and commands.', ''
  ].join('\n');
  const docs = {
    'README.md': readme, 'about.txt': about, 'resume.txt': career,
    'skills.dat': skills, 'contact.txt': 'Justin Calmus\njustin@sumlac.com\nhttps://www.linkedin.com/in/jcalmus\n',
    'ai-stack.conf': stack, 'threatmodel.txt': threatmodel, 'references.txt': references,
    'defense-factory.txt': defense, 'offense-factory.txt': offense
  };
  const seed = { [`${home}/work`]: { type: 'dir' } };
  for (const [name, content] of Object.entries(docs)) {
    seed[`${home}/${name}`] = content;
    seed[`/usr/share/sumlac/${name}`] = content;
  }
  for (const card of document.querySelectorAll('.arsenal-card')) {
    const name = card.querySelector('.arsenal-name').textContent.trim().replace(/[^\w.-]/g, '-');
    const text = `${card.querySelector('.arsenal-name').textContent.trim()}\n${card.querySelector('.arsenal-desc').textContent.trim()}\n${card.href}\n`;
    seed[`${home}/arsenal/${name}.txt`] = text;
  }

  const shell = new window.SumlacShell({ seed, onEvent: handleEvent });
  // Refresh published references without overwriting the visitor's own copies.
  for (const [name, content] of Object.entries(docs)) {
    const path = `/usr/share/sumlac/${name}`;
    try {
      if (shell.fs.exists(path)) shell.fs.chmod(path, 0o644);
      shell.fs.writeFile(path, content);
      shell.fs.chmod(path, 0o444);
    } catch (_) { /* A full workspace can still be used without refreshing references. */ }
  }
  historyPosition = shell.history.length;
  const register = (name, summary, usage, handler) => shell.register(name, { summary, usage, run: handler });
  const ok = stdout => ({ stdout, stderr: '', code: 0 });
  const fail = (name, message) => ({ stdout: '', stderr: `${name}: ${message}\n`, code: 1 });
  const resolve = path => shell.fs.normalize(path, shell.cwd);
  const file = path => shell.fs.readFile(resolve(path));
  const uiEvent = (ctx, event) => {
    if (!ctx.interactive) return false;
    ctx.emit(event);
    return true;
  };

  register('about', 'About Justin Calmus', 'about', () => ok(about));
  register('ai', 'Current AI stack and security focus', 'ai', () => ok(
    'AI SECURITY / ADVERSARIAL SYSTEMS\n\n' + stack + '\nA prompt is not a security boundary.\nTry: factories | threatmodel | references | lab\n'
  ));
  register('factories', 'Read my offense and defense factory vision', 'factories\nUse defense or offense for my thinking. open defense / open offense opens the public pages.', () => ok(
    'MY SECURITY FACTORY VISION / TWO LOOPS, SHARED EVIDENCE\n\n' +
    '  Defense Factory: reproduce, repair, verify, retain.\n' +
    '  Offense Factory: hypothesize, probe, reproduce, evolve.\n\n' +
    '  Read: defense | offense\n' +
    '  Browse: open defense | open offense\n'
  ));
  register('defense', 'Read my Defense Factory thesis', 'defense', () => ok(defense));
  register('offense', 'Read my Offense Factory thesis', 'offense', () => ok(offense));
  register('threatmodel', 'Explore an AI agent attack surface', 'threatmodel', () => ok(threatmodel));
  register('references', 'Primary AI security references', 'references', () => ok(references));
  register('lab', 'Open an interactive AI security game', 'lab [attack|defend]', ctx => {
    if (ctx.args[0] && !['attack', 'defend'].includes(ctx.args[0])) return fail('lab', 'choose attack or defend');
    if (!uiEvent(ctx, { type: 'lab', mode: ctx.args[0] || 'attack' })) return fail('lab', 'requires an interactive terminal');
    return ok('Opening the AI security lab.\n');
  });
  register('neofetch', 'Show actual browser shell capabilities', 'neofetch', () => ok([
    'sumlac / browser shell', '',
    'User:       visitor',
    `Directory:  ${shell.cwd}`,
    `Platform:   ${navigator.platform || 'browser'}`,
    'Runtime:    JavaScript in this browser',
    'Filesystem: persistent virtual workspace',
    'AI stack:   GLM-5.3 / Mythos / Daybreak',
    'Goal:       lowest possible end-to-end latency', ''
  ].join('\n')));
  for (const name of ['nano', 'edit', 'vi', 'vim']) {
    register(name, name === 'vi' || name === 'vim' ? 'Basic modal file editor' : 'Edit a workspace file', `${name} FILE\nSave: Ctrl+S. Close: Ctrl+X. vi/vim: i to insert, Esc, then :w / :q / :wq / :q!.`, ctx => {
      if (ctx.args.length !== 1) return fail(name, `usage: ${name} FILE`);
      if (!ctx.interactive || ctx.stdinTTY === false) return fail(name, 'requires an interactive terminal');
      try {
        const path = resolve(ctx.args[0]);
        let content = '';
        if (shell.fs.exists(path)) content = shell.fs.readFile(path);
        else if (!shell.fs.exists(resolve(path.slice(0, path.lastIndexOf('/')) || '/'))) return fail(name, 'parent directory does not exist');
        ctx.emit({ type: 'editor', path, content, modal: ['vi', 'vim'].includes(name) });
        return ok('');
      } catch (error) { return fail(name, error.message); }
    });
  }
  for (const name of ['less', 'more']) {
    register(name, 'Page through text or piped input', `${name} [FILE ...]\nq / Esc: close. Space / PageDown: advance. b / PageUp: back. /: search. n / N: next / previous match.`, ctx => {
      try {
        const text = ctx.args.length ? ctx.args.map(file).join('\n') : ctx.stdin;
        if (!ctx.args.length && !text && ctx.interactive) return fail(name, 'provide a file or pipe text into the pager');
        if (!uiEvent(ctx, { type: 'pager', text, title: ctx.args.join(', ') || 'standard input' })) return ok(text);
        return ok('');
      } catch (error) { return fail(name, error.message); }
    });
  }
  register('open', 'Open a web link in a new tab', 'open https://example.com\nopen linkedin | defense | offense', ctx => {
    if (ctx.args.length !== 1) return fail('open', 'provide one HTTP or HTTPS URL');
    try {
      const destinations = { linkedin: 'https://www.linkedin.com/in/jcalmus', defense: location.origin + '/defense-factory/', offense: location.origin + '/offense-factory/' };
      const destination = Object.prototype.hasOwnProperty.call(destinations, ctx.args[0]) ? destinations[ctx.args[0]] : ctx.args[0];
      const url = new URL(destination);
      if (!['https:', 'http:'].includes(url.protocol)) return fail('open', 'only HTTP and HTTPS links are supported');
      if (!uiEvent(ctx, { type: 'open', url: url.href })) return fail('open', 'requires an interactive terminal');
      return ok(`Open: ${url.href}\n`);
    } catch { return fail('open', 'invalid URL'); }
  });
  register('download', 'Download a workspace file', 'download FILE', ctx => {
    if (ctx.args.length !== 1) return fail('download', 'provide one file');
    try {
      const path = resolve(ctx.args[0]);
      if (!uiEvent(ctx, { type: 'download', path, content: file(path) })) return fail('download', 'requires an interactive terminal');
      return ok(`Downloaded ${path}\n`);
    } catch (error) { return fail('download', error.message); }
  });
  register('fullscreen', 'Expand or restore the terminal', 'fullscreen', ctx => {
    if (!uiEvent(ctx, { type: 'fullscreen' })) return fail('fullscreen', 'requires an interactive terminal');
    return ok('');
  });
  register('matrix', 'The original terminal easter egg', 'matrix', ctx => {
    if (!uiEvent(ctx, { type: 'matrix' })) return fail('matrix', 'requires an interactive terminal');
    return ok('');
  });

  function refresh() {
    cwdLabel.textContent = shell.cwd === home ? '~' : shell.cwd.startsWith(home + '/') ? '~' + shell.cwd.slice(home.length) : shell.cwd;
    stateLabel.textContent = busy ? 'Running…' : !shell.storage || shell.persistenceError ? 'Session only · storage unavailable' : `Browser files · exit ${shell.lastExit}`;
    stop.hidden = !busy;
    input.readOnly = busy;
    runButton.disabled = busy;
  }

  function resizeInput() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }
  function scrollBottom() { body.scrollTop = body.scrollHeight; }
  function focusInput() { if (!mode) input.focus({ preventScroll: true }); }

  // Construct styled text nodes for a small, useful ANSI SGR subset. Output is
  // never interpreted as HTML, including file contents and HTTP responses.
  function ansiText(parent, text) {
    const colors = ['#171f19', '#ff827b', '#77e792', '#ead081', '#8cb8ff', '#d7a0f1', '#83d5d4', '#dce8df'];
    let bold = parent.ansiState?.bold || false;
    let color = parent.ansiState?.color || '';
    const pattern = /\x1b\[([0-9;]*)m/g;
    let offset = 0;
    let match;
    const append = value => {
      if (!value) return;
      const span = node('span', '', value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''));
      if (bold) span.style.fontWeight = 'bold';
      if (color) span.style.color = color;
      parent.append(span);
    };
    while ((match = pattern.exec(text))) {
      append(text.slice(offset, match.index));
      for (const code of (match[1] || '0').split(';').map(Number)) {
        if (code === 0) { bold = false; color = ''; }
        else if (code === 1) bold = true;
        else if (code === 22) bold = false;
        else if (code === 39) color = '';
        else if (code >= 30 && code <= 37) color = colors[code - 30];
        else if (code >= 90 && code <= 97) color = colors[code - 90];
      }
      offset = pattern.lastIndex;
    }
    append(text.slice(offset));
    parent.ansiState = { bold, color };
  }

  function print(text, kind = 'stdout') {
    if (!text) return;
    text = String(text);
    if (text.includes('\x1b[2J')) { output.replaceChildren(); text = text.slice(text.lastIndexOf('\x1b[2J') + 4); }
    const last = output.lastElementChild;
    const appendToLast = last?.classList.contains('shell-output') && last.classList.contains('shell-' + kind) && last.textContent.length + text.length < 180000;
    const block = appendToLast ? last : node('pre', 'shell-output shell-' + kind);
    ansiText(block, text.slice(0, 180000));
    if (text.length > 180000) block.append(document.createTextNode('\n[Output truncated. Redirect to a file to keep the full result.]\n'));
    if (!appendToLast) output.append(block);
    trimScrollback();
    scrollBottom();
  }
  function echoCommand(raw, cancelled = false) {
    const block = node('pre', 'shell-command');
    block.append(node('span', 'prompt', 'visitor › '), document.createTextNode(raw + (cancelled ? '^C' : '')));
    output.append(block);
    trimScrollback();
  }
  function trimScrollback() {
    let size = output.textContent.length;
    while (output.childElementCount > 1 && (output.childElementCount > 300 || size > 600000)) {
      size -= output.firstElementChild.textContent.length;
      output.firstElementChild.remove();
    }
  }

  async function submit() {
    if (busy || mode || exited) return;
    if (reverseSearch) endSearch(true);
    const raw = input.value;
    if (!raw.trim()) { input.value = ''; resizeInput(); return; }
    if (typeof shell.isIncomplete === 'function' && shell.isIncomplete(raw)) {
      input.value += '\n';
      resizeInput();
      print('Continue the command, or press Ctrl+C to cancel.\n', 'hint');
      return;
    }
    echoCommand(raw);
    input.value = '';
    resizeInput();
    busy = true;
    externalFocus = false;
    controller = new AbortController();
    refresh();
    scrollBottom();
    try {
      let streamed = false;
      const result = await shell.execute(raw, {
        signal: controller.signal,
        interactive: true,
        onOutput: chunk => { streamed = true; print(chunk.stdout, 'stdout'); print(chunk.stderr, 'stderr'); }
      });
      if (!streamed) { print(result.stdout, 'stdout'); print(result.stderr, 'stderr'); }
      if (controller.signal.aborted) print('^C\n', 'stderr');
    } catch (error) {
      print(controller.signal.aborted ? '^C\n' : `shell: ${error.message}\n`, 'stderr');
    } finally {
      busy = false;
      controller = null;
      historyPosition = shell.history.length;
      draft = '';
      refresh();
      if (!mode && !exited && !externalFocus) focusInput();
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); submit(); });
  input.addEventListener('input', () => { resizeInput(); if (reverseSearch) searchHistory(); });

  function cancel() {
    if (controller) { controller.abort(); return; }
    if (reverseSearch) { endSearch(false); return; }
    echoCommand(input.value, true);
    input.value = '';
    shell.lastExit = 130;
    historyPosition = shell.history.length;
    draft = '';
    resizeInput();
    refresh();
    scrollBottom();
  }
  stop.addEventListener('click', cancel);

  function navigateHistory(direction) {
    if (historyPosition === shell.history.length) draft = input.value;
    historyPosition = Math.max(0, Math.min(shell.history.length, historyPosition + direction));
    input.value = historyPosition === shell.history.length ? draft : shell.history[historyPosition];
    input.setSelectionRange(input.value.length, input.value.length);
    resizeInput();
  }
  function searchHistory(advance = false) {
    const query = input.value;
    if (!advance || query !== reverseSearch.query) reverseSearch.index = shell.history.length;
    reverseSearch.query = query;
    let found = -1;
    for (let i = reverseSearch.index - 1; i >= 0; i--) {
      if (shell.history[i].includes(query)) { found = i; break; }
    }
    reverseSearch.index = found >= 0 ? found : shell.history.length;
    reverseSearch.match = found >= 0 ? shell.history[found] : '';
    reverseSearch.preview.textContent = found >= 0 ? `(reverse search) ${reverseSearch.match}` : '(reverse search) no matching command';
  }
  function startSearch() {
    if (reverseSearch) { searchHistory(true); return; }
    const preview = node('div', 'shell-search');
    preview.setAttribute('role', 'status');
    form.before(preview);
    reverseSearch = { original: input.value, query: '', index: shell.history.length, match: '', preview };
    input.value = '';
    searchHistory();
  }
  function endSearch(accept) {
    if (!reverseSearch) return;
    input.value = accept && reverseSearch.match ? reverseSearch.match : reverseSearch.original;
    reverseSearch.preview.remove();
    reverseSearch = null;
    input.setSelectionRange(input.value.length, input.value.length);
    resizeInput();
  }
  function replaceSelection(start, end, replacement = '') {
    input.setRangeText(replacement, start, end, 'end');
    resizeInput();
  }
  input.addEventListener('keydown', event => {
    const control = event.ctrlKey && !event.metaKey;
    if (control && event.key.toLowerCase() === 'c' && input.selectionStart === input.selectionEnd && !window.getSelection()?.toString()) { event.preventDefault(); cancel(); return; }
    if (busy) return;
    if (event.isComposing) return;
    if (control && event.key.toLowerCase() === 'r') { event.preventDefault(); startSearch(); return; }
    if (reverseSearch && event.key === 'Escape') { event.preventDefault(); endSearch(false); return; }
    if (reverseSearch && event.key === 'Enter') { event.preventDefault(); endSearch(true); submit(); return; }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); return; }
    if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault();
      const completion = shell.complete(input.value, input.selectionStart);
      input.value = completion.line;
      input.setSelectionRange(completion.cursor, completion.cursor);
      if (completion.candidates.length > 1) print(completion.candidates.join('  ') + '\n', 'completion');
      resizeInput();
      return;
    }
    if (event.key === 'ArrowUp' && !input.value.slice(0, input.selectionStart).includes('\n')) { event.preventDefault(); navigateHistory(-1); return; }
    if (event.key === 'ArrowDown' && !input.value.slice(input.selectionEnd).includes('\n')) { event.preventDefault(); navigateHistory(1); return; }
    const start = input.selectionStart;
    const end = input.selectionEnd;
    if (control) {
      const key = event.key.toLowerCase();
      if (key === 'l') { event.preventDefault(); output.replaceChildren(); }
      else if (key === 'a') { event.preventDefault(); input.setSelectionRange(0, 0); }
      else if (key === 'e') { event.preventDefault(); input.setSelectionRange(input.value.length, input.value.length); }
      else if (key === 'u') { event.preventDefault(); replaceSelection(0, end); }
      else if (key === 'k') { event.preventDefault(); replaceSelection(start, input.value.length); }
      else if (key === 'w') { event.preventDefault(); replaceSelection(input.value.slice(0, start).replace(/\s*\S+\s*$/, '').length, end); }
      else if (key === 'd') {
        event.preventDefault();
        if (!input.value) submitExit();
        else replaceSelection(start, end > start ? end : start + 1);
      }
    } else if (event.altKey && !event.metaKey) {
      const key = event.key.toLowerCase();
      if (key === 'b') { event.preventDefault(); const pos = input.value.slice(0, start).replace(/\s*\S+\s*$/, '').length; input.setSelectionRange(pos, pos); }
      if (key === 'f') { event.preventDefault(); const pos = start + (input.value.slice(start).match(/^\s*\S+\s*/)?.[0].length || 0); input.setSelectionRange(pos, pos); }
      if (key === 'd') { event.preventDefault(); replaceSelection(start, start + (input.value.slice(start).match(/^\s*\S+\s*/)?.[0].length || 0)); }
    }
  });
  function submitExit() { input.value = 'exit'; submit(); }

  function toggleExpanded() {
    expanded = !expanded;
    terminal.classList.toggle('is-expanded', expanded);
    document.body.classList.toggle('has-expanded-terminal', expanded);
    expand.setAttribute('aria-pressed', String(expanded));
    expand.setAttribute('aria-label', expanded ? 'Restore terminal size' : 'Expand terminal');
    expand.textContent = expanded ? 'Restore' : 'Expand';
    terminal.setAttribute('role', expanded ? 'dialog' : 'region');
    terminal.setAttribute('aria-label', 'Visitor browser shell');
    if (expanded) terminal.setAttribute('aria-modal', 'true');
    else terminal.removeAttribute('aria-modal');
    if (mode) mode.focus?.(); else focusInput();
  }
  expand.addEventListener('click', toggleExpanded);
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented) return;
    if (event.key === 'Tab' && expanded) {
      const controls = [...terminal.querySelectorAll('button,textarea,input,a[href],[tabindex="0"]')].filter(item => !item.disabled && item.getClientRects().length);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    if (event.key === 'Escape' && expanded && !mode && !reverseSearch) { event.preventDefault(); toggleExpanded(); }
  });
  document.getElementById('terminal-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(output.innerText);
      stateLabel.textContent = 'Output copied';
    } catch { stateLabel.textContent = 'Select output to copy'; }
  });
  body.addEventListener('click', event => {
    if (event.target.closest('button,a,textarea') || window.getSelection()?.toString()) return;
    focusInput();
  });

  function handleEvent(event) {
    if (event.type === 'clear') output.replaceChildren();
    else if (event.type === 'editor') showEditor(event);
    else if (event.type === 'pager') showPager(event);
    else if (event.type === 'lab') { externalFocus = true; window.dispatchEvent(new CustomEvent('sumlac:open-lab', { detail: event })); }
    else if (event.type === 'matrix') window.dispatchEvent(new CustomEvent('sumlac:matrix'));
    else if (event.type === 'fullscreen') toggleExpanded();
    else if (event.type === 'exit') {
      exited = true;
      form.hidden = true;
      print('Session ended. Your files are retained.\n', 'hint');
      const restart = button('Start a new shell session', () => {
        exited = false;
        restart.remove();
        form.hidden = false;
        print('\nNew visitor session. Type help for commands.\n', 'welcome');
        refresh(); focusInput();
      }, 'shell-restart');
      output.append(restart);
      restart.focus({ preventScroll: true });
    } else if (event.type === 'reset') {
      output.replaceChildren();
    } else if (event.type === 'open') {
      const anchor = node('a', 'shell-link', event.url);
      anchor.href = event.url;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      output.append(anchor);
      anchor.click();
    } else if (event.type === 'download') {
      const url = URL.createObjectURL(new Blob([event.content], { type: 'text/plain;charset=utf-8' }));
      const anchor = node('a');
      anchor.href = url;
      anchor.download = event.path.split('/').pop();
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
  function openMode() {
    body.hidden = true;
    modePanel.hidden = false;
    modePanel.replaceChildren();
  }
  function closeMode() {
    mode = null;
    modePanel.hidden = true;
    modePanel.replaceChildren();
    body.hidden = false;
    refresh();
    focusInput();
    scrollBottom();
  }

  function showEditor(event) {
    openMode();
    let path = event.path;
    let saved = event.content;
    let inserting = !event.modal;
    let closing = false;
    const top = node('div', 'shell-mode-bar');
    const name = node('span', '', path);
    const actions = node('div', 'shell-mode-actions');
    const message = node('div', 'shell-editor-message');
    message.setAttribute('role', 'status');
    const editor = node('textarea', 'shell-editor');
    editor.setAttribute('aria-label', 'Edit ' + path);
    editor.spellcheck = false;
    editor.autocapitalize = 'off';
    editor.value = event.content;
    editor.readOnly = !inserting;
    const help = node('div', 'shell-mode-help');
    const confirmation = node('div', 'shell-editor-confirm');
    confirmation.hidden = true;
    const command = node('input', 'shell-vi-command');
    command.setAttribute('aria-label', 'vi command');
    command.hidden = true;
    const dirty = () => editor.value !== saved;
    const update = () => {
      name.textContent = path + (dirty() ? ' [+]' : '');
      help.textContent = event.modal ? (inserting ? 'INSERT · Esc: normal mode · Ctrl+S: save · Ctrl+X: close' : 'NORMAL · i / a / o: insert · :w save · :q quit · :wq save & quit · :q! discard') : 'Ctrl+S / Ctrl+O: save · Ctrl+X / Esc: close · Tab: indent';
    };
    function save(newPath) {
      try {
        const destination = newPath ? resolve(newPath) : path;
        shell.fs.writeFile(destination, editor.value);
        path = destination;
        if (typeof shell.save === 'function') shell.save();
        saved = editor.value;
        message.textContent = `Saved ${path} (${new TextEncoder().encode(saved).length} bytes)`;
        confirmation.hidden = true;
        update();
        return true;
      } catch (error) { message.textContent = 'Save failed: ' + error.message; return false; }
    }
    function requestClose() {
      if (!dirty()) { closeMode(); return; }
      if (closing) { confirmation.hidden = false; return; }
      closing = true;
      confirmation.hidden = false;
      confirmation.append(node('span', '', 'Save your changes?'), button('Save and close', () => { if (save()) closeMode(); }), button('Discard', closeMode), button('Keep editing', () => { confirmation.hidden = true; closing = false; editor.focus(); }));
      confirmation.querySelector('button').focus();
    }
    actions.append(button('Save', () => save()), button('Close', requestClose));
    top.append(name, actions);
    modePanel.append(top, message, confirmation, editor, command, help);
    mode = { focus: () => editor.focus(), type: 'editor' };
    editor.addEventListener('input', update);
    editor.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && ['s', 'o'].includes(e.key.toLowerCase())) { e.preventDefault(); save(); return; }
      if (e.ctrlKey && e.key.toLowerCase() === 'x') { e.preventDefault(); requestClose(); return; }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (event.modal) { inserting = false; editor.readOnly = true; update(); }
        else requestClose();
        return;
      }
      if (e.key === 'Tab' && inserting && !e.shiftKey) { e.preventDefault(); editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end'); update(); return; }
      if (!event.modal || inserting || e.ctrlKey || e.metaKey || e.altKey) return;
      if (['i', 'a', 'o'].includes(e.key)) {
        e.preventDefault();
        if (e.key === 'a') editor.setSelectionRange(Math.min(editor.value.length, editor.selectionStart + 1), Math.min(editor.value.length, editor.selectionStart + 1));
        if (e.key === 'o') { const next = editor.value.indexOf('\n', editor.selectionStart); const pos = next < 0 ? editor.value.length : next; editor.setRangeText('\n', pos, pos, 'end'); }
        inserting = true; editor.readOnly = false; update();
      } else if (e.key === ':') { e.preventDefault(); command.hidden = false; command.value = ':'; command.focus(); }
      else if (e.key === 'h' || e.key === 'l') { e.preventDefault(); const pos = Math.max(0, Math.min(editor.value.length, editor.selectionStart + (e.key === 'h' ? -1 : 1))); editor.setSelectionRange(pos, pos); }
    });
    command.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); command.hidden = true; editor.focus(); }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const value = command.value.replace(/^:/, '').trim();
      command.hidden = true;
      if (value === 'q!') closeMode();
      else if (value === 'q') requestClose();
      else if (value === 'wq' || value === 'x') { if (save()) closeMode(); }
      else if (value === 'w' || value.startsWith('w ')) { save(value.slice(2).trim()); editor.focus(); }
      else { message.textContent = 'Supported commands: :w [file], :q, :q!, :wq, :x'; editor.focus(); }
    });
    update();
    editor.focus({ preventScroll: true });
  }

  function showPager(event) {
    openMode();
    const top = node('div', 'shell-mode-bar');
    const position = node('span');
    top.append(node('span', '', event.title), button('Close [q]', closeMode));
    const text = node('pre', 'shell-pager-content', event.text);
    text.tabIndex = 0;
    text.setAttribute('aria-label', 'Document pager');
    const search = node('input', 'shell-pager-search');
    search.hidden = true;
    search.setAttribute('aria-label', 'Search document');
    const help = node('div', 'shell-mode-help');
    help.append(position, document.createTextNode(' · Space: next page · b: back · /: search · n/N: next/previous · q: close'));
    modePanel.append(top, text, search, help);
    mode = { focus: () => text.focus(), type: 'pager' };
    let query = '';
    let matches = [];
    let match = -1;
    const update = () => { position.textContent = `${Math.min(100, Math.round((text.scrollTop + text.clientHeight) / Math.max(text.scrollHeight, 1) * 100))}% of ${event.text.split('\n').length} lines`; };
    const find = direction => {
      if (!matches.length) { position.textContent = 'No matches'; return; }
      match = (match + direction + matches.length) % matches.length;
      const line = event.text.slice(0, matches[match]).split('\n').length - 1;
      const lineHeight = parseFloat(getComputedStyle(text).lineHeight) || 22;
      text.scrollTop = line * lineHeight;
      position.textContent = `Match ${match + 1}/${matches.length}: ${query}`;
    };
    search.addEventListener('keydown', e => {
      if (e.key === 'Escape') { search.hidden = true; text.focus(); }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      query = search.value;
      matches = [];
      let index = 0;
      if (query) while ((index = event.text.toLowerCase().indexOf(query.toLowerCase(), index)) >= 0 && matches.length < 5000) { matches.push(index); index += Math.max(query.length, 1); }
      match = -1;
      search.hidden = true;
      text.focus();
      find(1);
    });
    text.addEventListener('scroll', update);
    text.addEventListener('keydown', e => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const amount = Math.max(text.clientHeight - 30, 50);
      if (e.key === 'q' || e.key === 'Escape') { e.preventDefault(); closeMode(); }
      else if (e.key === ' ' || e.key === 'PageDown' || e.key === 'f') { e.preventDefault(); text.scrollTop += amount; }
      else if (e.key === 'b' || e.key === 'PageUp') { e.preventDefault(); text.scrollTop -= amount; }
      else if (e.key === 'j') { e.preventDefault(); text.scrollTop += 24; }
      else if (e.key === 'k') { e.preventDefault(); text.scrollTop -= 24; }
      else if (e.key === 'g') { e.preventDefault(); text.scrollTop = 0; }
      else if (e.key === 'G') { e.preventDefault(); text.scrollTop = text.scrollHeight; }
      else if (e.key === '/') { e.preventDefault(); search.hidden = false; search.focus(); }
      else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); find(e.key === 'n' ? 1 : -1); }
      update();
    });
    text.focus({ preventScroll: true });
    update();
  }

  print('sumlac / visitor workspace\nA browser-local shell with persistent files, pipes, and an editor.\nType help for commands or cat README.md for a quick tour.\n\n', 'welcome');
  refresh();
  resizeInput();
})();
