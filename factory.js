/* The explorer is a local, illustrative walkthrough. It makes no network or model calls. */
(function () {
  'use strict';
  const page = document.querySelector('.factory-page[data-factory]');
  if (!page) return;
  const mode = page.dataset.factory === 'offense' ? 'offense' : 'defense';
  const phaseNames = mode === 'offense'
    ? ['Hypothesis', 'Probe', 'Minimize', 'Handoff']
    : ['Candidate', 'Reproduce', 'Control', 'Regression'];
  const sample = (lines) => 'SAMPLE / NOT A LIVE FINDING\n' + lines.join('\n');
  const step = (heading, text, lines) => ({ heading, text, evidence: sample(lines) });
  const cases = {
    injection: {
      id: 'retrieval-tool-authority',
      title: 'Untrusted document, unauthorized tool',
      summary: 'A retrieved document asks an assistant to export information. The document is evidence for an answer; it has no authority to grant a new tool capability.',
      boundary: 'Document content → tool authority',
      defense: [
        step('Capture the candidate', 'Keep the retrieved content and the requested operation together. The report needs to show the boundary that might have failed, without storing real user records or credentials.', ['case: retrieval-tool-authority', 'input: synthetic retrieved document', 'request: export private records', 'expected: no additional capabilities', 'state: candidate for reproduction']),
        step('Confirm the boundary violation', 'Replay the synthetic document with a caller who cannot export records. A tool request alone is not proof of data exposure. Record whether the authorization layer actually permits the operation.', ['caller: synthetic read-only user', 'document: requests an export action', 'tool request: observed in sample trace', 'authorization result: allowed (sample fault)', 'confirmed effect: policy boundary crossed']),
        step('Repair the execution boundary', 'Bind the export tool to the original caller’s permissions. Treat the model’s tool request as an untrusted proposal and enforce authorization before execution. Keep legitimate exports working for authorized callers.', ['control: caller-bound tool capability', 'read-only caller + injected request: denied', 'authorized caller + explicit request: allowed', 'retrieved content: cannot amend policy', 'patch state: proposed for review']),
        step('Retain a meaningful regression', 'Keep the minimal document fixture and assert that the read-only caller cannot export. Add an allowed-path test and variants that put the instruction in different content positions. A passing fixture is a bounded result.', ['regression: document-cannot-grant-export', 'required: read-only export denied', 'control: authorized export still works', 'retained: synthetic document + trace', 'next offense: indirect content variants']),
      ],
      offense: [
        step('Define the hypothesis', 'An attacker controls a synthetic retrieved document. The test asks whether content can create a tool capability that the original caller was never granted.', ['case: retrieval-tool-authority', 'attacker control: retrieved content', 'boundary: content → tool authority', 'expected: original caller policy wins', 'probe: local synthetic fixture only']),
        step('Inspect the actual effect', 'Present the synthetic content to the test system and inspect the tool decision. Distinguish a model proposing a tool call from the system executing an unauthorized export. The illustration assumes the latter to explain the handoff.', ['fixture: synthetic document instruction', 'caller: read-only test identity', 'proposed action: export', 'sample authorization result: allowed', 'effect under test: unauthorized operation']),
        step('Reduce the case', 'Remove unrelated document content and extra tool arguments. Keep only the caller permissions, the content instruction, and the observed policy decision. Rerun the reduced case in a fresh environment.', ['minimal setup: read-only caller', 'minimal input: one retrieved instruction', 'assertion: export remains unauthorized', 'sample observation: policy permits export', 'replay context: clean test workspace']),
        step('Hand off the boundary, not the rhetoric', 'Send the minimized fixture, caller context, and authorization trace to the tool owner. After a reviewed fix, replay this case and retain it before exploring new document arrangements.', ['handoff owner: export authorization', 'include: caller + fixture + tool decision', 'security property: content grants no tools', 'required retest: denied unauthorized export', 'next: retained regression + new variants']),
      ],
    },
    retrieval: {
      id: 'retrieval-tenant-boundary',
      title: 'Right question, wrong tenant',
      summary: 'A search result belongs to another tenant. A helpful answer can still disclose the wrong data if the retrieval layer does not enforce the caller’s scope.',
      boundary: 'Caller identity → retrieved records',
      defense: [
        step('Preserve the scope mismatch', 'Record the synthetic caller identity, the allowed tenant, and the provenance of the unexpected record. Do not preserve real customer content to make the report compelling; synthetic canary records are sufficient.', ['case: retrieval-tenant-boundary', 'caller tenant: sample-alpha', 'retrieved tenant: sample-beta', 'record: synthetic beta canary', 'expected: alpha records only']),
        step('Test retrieval before generation', 'Reproduce the query with two synthetic tenants and distinct canaries. Inspect raw retrieval results, not only the model’s final answer. A model declining to quote the record does not repair an overbroad search.', ['fixture: alpha + beta synthetic records', 'caller scope: alpha', 'sample raw result: beta canary present', 'failure: retrieval isolation', 'generation behavior: separate observation']),
        step('Enforce scope in the data access path', 'Build the tenant filter from authenticated server context. Apply it before fetching record bodies and reject requests that try to substitute a different tenant. Avoid making isolation depend on a model instruction.', ['control: authenticated tenant filter', 'tenant supplied by model: not authoritative', 'alpha caller → beta record: denied', 'alpha caller → alpha record: allowed', 'enforcement: retrieval data layer']),
        step('Keep isolation tests close to retrieval', 'Retain paired tenant fixtures and test both direct lookup and semantic search. Include an empty result and a permitted result so a blanket retrieval failure cannot masquerade as successful isolation.', ['regression: no-cross-tenant-results', 'beta canary for alpha caller: absent', 'alpha canary for alpha caller: present', 'empty query path: handled', 'next offense: cache and rerank scope']),
      ],
      offense: [
        step('Choose a testable isolation claim', 'Create two synthetic tenants with distinguishable canary records. The hypothesis is that a caller scoped to alpha can cause retrieval to return beta’s canary. Keep the test entirely inside a controlled fixture.', ['case: retrieval-tenant-boundary', 'tenants: sample-alpha / sample-beta', 'data: unique synthetic canaries', 'expected: caller scope constrains results', 'target: local retrieval fixture']),
        step('Probe the retrieval surface', 'Exercise direct lookups and search using the alpha identity. Observe result metadata before generation. The sample failure is a beta record appearing in an alpha-scoped result set.', ['caller: alpha test identity', 'operation: local search fixture', 'sample result provenance: beta', 'failure signal: beta canary returned', 'model answer: not required for proof']),
        step('Separate the failing component', 'Reduce to the smallest query and result that crosses the tenant boundary. Retain authentication context and filter behavior so the issue is attributable to retrieval rather than to an unrelated display problem.', ['minimal record: beta canary', 'minimal caller: alpha identity', 'missing control: caller-bound tenant filter', 'sample assertion: beta result returned', 'retained: query + result provenance']),
        step('Route to the data boundary owner', 'Give the retrieval owner the scope context and minimal query. Require a replay that blocks the cross-tenant result while preserving permitted retrieval. Then add variants around caches, reranking, and alternate lookup paths.', ['handoff owner: retrieval authorization', 'include: identity + query + provenance', 'fix check: beta absent for alpha', 'allowed check: alpha remains retrievable', 'next campaign: adjacent retrieval paths']),
      ],
    },
    tools: {
      id: 'tool-caller-permissions',
      title: 'A suggestion is not an authorization',
      summary: 'An agent prepares a write operation for a caller with read-only access. The tool layer must decide whether the operation is allowed, even when its arguments look reasonable.',
      boundary: 'Model proposal → authorized side effect',
      defense: [
        step('Identify the missing authority', 'Capture the proposed tool, arguments, caller permissions, and the side effect. Use a disposable synthetic record. A valid argument schema does not prove that the caller is allowed to make the change.', ['case: tool-caller-permissions', 'caller: read-only synthetic identity', 'tool: update_record', 'argument schema: valid', 'expected: no write capability']),
        step('Reproduce the policy decision', 'Invoke the tool path in a local fixture with the read-only caller. Inspect both the response and the record state. The sample failure is a real fixture state change after an operation that should have been denied.', ['target: disposable synthetic record', 'caller privilege: read-only', 'sample response: update accepted', 'sample record state: changed', 'failure: missing write authorization']),
        step('Put the check at execution time', 'Authorize the requested operation and object using the original caller context immediately before the side effect. The model cannot supply its own role, and a successful schema check cannot replace the authorization check.', ['control: object + operation authorization', 'identity source: authenticated caller', 'model-supplied role: ignored', 'read-only update: denied', 'permitted writer update: allowed']),
        step('Cover denial and permitted work', 'Retain the unauthorized operation as a regression and include a valid writer control. Add object-level ownership and stale-authorization cases so the next round challenges the actual execution boundary.', ['regression: readonly-tool-write-denied', 'side effect after denial: none', 'allowed writer: expected update succeeds', 'ownership mismatch: denied', 'next offense: stale permission context']),
      ],
      offense: [
        step('Challenge the tool’s authority model', 'The local caller is read-only, but the proposed operation writes to a synthetic record. The hypothesis asks whether the execution layer trusts a well-formed model request more than the caller’s actual permissions.', ['case: tool-caller-permissions', 'attacker control: proposed tool arguments', 'caller permission: read-only', 'expected: write denied at execution', 'fixture: disposable synthetic record']),
        step('Observe the side effect', 'Submit the operation inside the fixture and compare state before and after. A confident tool response is not enough; the test needs a denied operation or evidence that the protected record actually changed.', ['before: synthetic record unchanged', 'operation: update_record', 'sample result: accepted', 'after: synthetic record changed', 'failure signal: unauthorized side effect']),
        step('Keep one identity, one operation', 'Remove extra tools and irrelevant fields. Preserve the caller identity, the single protected record, and the state difference. This keeps the report focused on authority rather than on prompt wording.', ['minimal caller: read-only identity', 'minimal target: one synthetic record', 'minimal operation: one field update', 'proof: before / after state', 'security property: read-only cannot write']),
        step('Hand off a permission regression', 'Route the minimal test to the tool authorization owner. Retest the denied path after remediation, then verify that a legitimately authorized writer still succeeds. Evolve toward ownership and delayed execution checks.', ['handoff owner: tool execution policy', 'include: identity + operation + state diff', 'required: deny without state change', 'control: valid writer still succeeds', 'next campaign: ownership + stale context']),
      ],
    },
    output: {
      id: 'untrusted-output-rendering',
      title: 'An answer should stay an answer',
      summary: 'Text from a model, file, or tool response reaches the browser. If a renderer interprets that text as active markup, an output boundary becomes a code execution boundary.',
      boundary: 'Untrusted text → browser DOM',
      defense: [
        step('Capture the rendering context', 'Identify the source of the displayed string and the exact renderer that receives it. Use a local synthetic marker instead of external requests or real session data. Preserve the expected text rendering behavior.', ['case: untrusted-output-rendering', 'source: synthetic model or tool output', 'sink: browser output renderer', 'expected: inert displayed text', 'marker: local synthetic value only']),
        step('Prove the browser behavior', 'Render the fixture in the local test page and inspect the DOM and marker. A markup-like string in source code is only a candidate. The sample failure is the browser treating untrusted text as executable content.', ['environment: loopback browser fixture', 'input: synthetic markup-like string', 'sample marker: changed by active content', 'DOM: executable node created', 'finding scope: tested renderer only']),
        step('Use an inert rendering path', 'Render untrusted content through text nodes. If the product truly needs rich content, define a narrow allowlist and validate the resulting DOM. Keep intentional UI markup separate from data supplied by users or models.', ['control: text-only rendering sink', 'untrusted output: assigned as text', 'intentional UI: built separately', 'active nodes from fixture: none', 'plain text output: preserved']),
        step('Retain a browser regression', 'Replay the synthetic fixture in a real browser and assert both that no active node appears and that the displayed text remains useful. Retain cases for tool output, retrieved content, and other paths that share the renderer.', ['regression: untrusted-output-stays-inert', 'active node assertion: absent', 'execution marker: unchanged', 'text content: expected value visible', 'next offense: alternate rendering paths']),
      ],
      offense: [
        step('Name the rendering assumption', 'An attacker controls an output string in a local fixture. The test asks whether the UI treats that string only as text. The only effect under test is a synthetic marker in the disposable browser session.', ['case: untrusted-output-rendering', 'attacker control: displayed string', 'boundary: text → active browser content', 'expected: data remains inert', 'scope: local test page only']),
        step('Probe a real browser sink', 'Pass the synthetic fixture through the actual rendering path and inspect the DOM. Record whether active content appeared and whether the local marker changed. Do not infer execution from the string merely looking suspicious.', ['target: local output renderer', 'fixture: synthetic active-content string', 'sample DOM: active node created', 'sample marker: changed', 'normal text control: still displays']),
        step('Minimize to the responsible renderer', 'Reduce to one output source, one rendering call, and one local marker. Keep a normal text control so a broken or empty UI cannot count as a successful defensive result.', ['minimal source: one displayed string', 'minimal path: one output renderer', 'failure signal: local marker change', 'allowed control: ordinary text visible', 'no external requests or real data']),
        step('Provide a browser-replayable handoff', 'Send the renderer path, synthetic fixture, and DOM evidence to the UI owner. After a reviewed change, replay through the browser and confirm the text is still readable while active nodes remain absent.', ['handoff owner: browser output boundary', 'include: fixture + DOM + marker result', 'fix check: fixture stays inert', 'allowed check: ordinary text visible', 'next campaign: other output entry points']),
      ],
    },
    secrets: {
      id: 'secret-context-boundary',
      title: 'A secret cannot be recalled if it never entered',
      summary: 'A sensitive value is accidentally included in context, logs, or generated output. The strongest boundary keeps application secrets outside the model’s working data in the first place.',
      boundary: 'Privileged runtime → model context and output',
      defense: [
        step('Map the canary’s path', 'Use a synthetic sentinel that resembles no real credential. Record where it entered the system and which outputs could receive it. Keep context exposure, logging exposure, and external disclosure as separate observations.', ['case: secret-context-boundary', 'sentinel: SYNTHETIC_FACTORY_CANARY', 'source: privileged fixture configuration', 'expected: excluded from model context', 'data class: synthetic, not a credential']),
        step('Locate the first exposure', 'Trace the canary through context construction and local logs. The sample failure is that a privileged fixture value enters the model input. That is already a boundary issue even if one answer happens not to repeat it.', ['fixture: synthetic configuration canary', 'sample context: canary present', 'first failing boundary: context assembly', 'output disclosure: separate check', 'real credential material: never used']),
        step('Remove the secret from working context', 'Separate privileged configuration from task data. Use narrow tool capabilities instead of exposing credentials as text. Add filtering at known logging and serialization boundaries as defense in depth.', ['control: context allowlist', 'privileged config: excluded', 'tool authorization: capability-bound', 'logs: sensitive fields omitted', 'task data: still available']),
        step('Test context, logs, and output separately', 'Retain the synthetic canary fixture and assert that it is absent from each prohibited channel. Include normal task fields as controls, so deleting all context cannot pass as a useful fix.', ['regression: privileged-canary-excluded', 'model context: sentinel absent', 'local logs: sentinel absent', 'generated output: sentinel absent', 'allowed task fields: preserved']),
      ],
      offense: [
        step('Create a synthetic exposure test', 'Place a harmless sentinel in privileged fixture configuration. The hypothesis is that context assembly or logging crosses that boundary. Use a distinctive synthetic string and no real secrets.', ['case: secret-context-boundary', 'canary: SYNTHETIC_FACTORY_CANARY', 'location: privileged fixture config', 'expected: never in model working data', 'real credentials: excluded from test']),
        step('Inspect the data flow', 'Observe the assembled context and local logs in the fixture. A failed disclosure attempt does not prove the secret was isolated. The illustration assumes the canary is present in context and records that narrower finding.', ['inspection: fixture context assembly', 'sample observation: canary in context', 'confirmed issue: privileged data exposure', 'generated answer: independent observation', 'scope: synthetic local fixture']),
        step('Remove unrelated context', 'Reduce the case to one privileged field and one serialization path. Preserve the point at which the sentinel crosses into a prohibited channel. This makes the remediation target explicit.', ['minimal config: one synthetic sentinel', 'minimal path: context serializer', 'failure: sentinel enters model input', 'retained: input shape + output context', 'irrelevant task content: removed']),
        step('Route the exposure with exact scope', 'Hand the context owner the minimal path and the channel where the canary appeared. Retest context, logs, and outputs separately after remediation. Expand only to other explicitly scoped serialization paths.', ['handoff owner: context construction', 'include: sentinel path + sample context', 'fix check: canary absent in context', 'control: useful task fields preserved', 'next campaign: logs + alternate serializers']),
      ],
    },
  };

  // All authored examples are displayed as text, including markup-like inputs.
  const tabs = Array.from(page.querySelectorAll('.f-stage-tab'));
  function selectStage(index, moveFocus) {
    tabs.forEach((tab, i) => {
      const active = i === index;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      if (panel) panel.hidden = !active;
    });
    if (moveFocus) tabs[index].focus();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectStage(index, false));
    tab.addEventListener('keydown', (event) => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) {
        event.preventDefault();
        selectStage(next, true);
      }
    });
  });

  const byId = (id) => document.getElementById(id);
  const selector = byId('scenario-select');
  const walkButtons = Array.from(page.querySelectorAll('[data-walk-step]'));
  const previous = byId('walk-prev');
  const next = byId('walk-next');
  let selected = 'injection';
  let currentStep = 0;

  function render() {
    const currentCase = cases[selected];
    const current = currentCase[mode][currentStep];
    byId('scenario-heading').textContent = currentCase.title;
    byId('scenario-summary').textContent = currentCase.summary;
    byId('scenario-boundary').textContent = currentCase.boundary;
    byId('walk-heading').textContent = current.heading;
    byId('walk-text').textContent = current.text;
    byId('walk-evidence').textContent = current.evidence;
    byId('walk-counter').textContent = `STEP ${currentStep + 1} OF 4`;
    previous.disabled = currentStep === 0;
    next.disabled = currentStep === 3;
    walkButtons.forEach((button, index) => {
      button.textContent = `0${index + 1} / ${phaseNames[index]}`;
      if (index === currentStep) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    });
  }
  selector.addEventListener('change', () => {
    if (!Object.prototype.hasOwnProperty.call(cases, selector.value)) return;
    selected = selector.value;
    currentStep = 0;
    render();
    byId('walk-status').textContent = 'Sample changed. Walkthrough reset to step 1.';
  });
  function changeStep(index) {
    currentStep = Math.max(0, Math.min(3, index));
    byId('walk-status').textContent = '';
    render();
  }
  previous.addEventListener('click', () => changeStep(currentStep - 1));
  next.addEventListener('click', () => changeStep(currentStep + 1));
  byId('walk-reset').addEventListener('click', () => {
    changeStep(0);
    byId('walk-status').textContent = 'Sample reset to step 1.';
  });
  walkButtons.forEach((button, index) => {
    button.addEventListener('click', () => changeStep(index));
    button.addEventListener('keydown', (event) => {
      let target;
      if (event.key === 'ArrowRight') target = (index + 1) % 4;
      if (event.key === 'ArrowLeft') target = (index + 3) % 4;
      if (event.key === 'Home') target = 0;
      if (event.key === 'End') target = 3;
      if (target !== undefined) {
        event.preventDefault();
        changeStep(target);
        walkButtons[target].focus();
      }
    });
  });

  byId('walk-download').addEventListener('click', () => {
    const currentCase = cases[selected];
    const artifact = {
      schema: 'sumlac.factory.sample.v1',
      illustrative: true,
      live_finding: false,
      model_calls: false,
      factory: mode,
      case: currentCase.id,
      title: currentCase.title,
      boundary: currentCase.boundary,
      summary: currentCase.summary,
      steps: currentCase[mode].map((entry, index) => ({
        phase: phaseNames[index].toLowerCase(),
        heading: entry.heading,
        explanation: entry.text,
        evidence: entry.evidence,
      })),
    };
    let url;
    try {
      url = URL.createObjectURL(new Blob([JSON.stringify(artifact, null, 2) + '\n'], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `sumlac-${mode}-${currentCase.id}-SAMPLE.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      byId('walk-status').textContent = 'Sample JSON prepared for download. This is illustrative evidence, not an actual finding.';
    } catch (_) {
      byId('walk-status').textContent = 'This browser could not create the download. The complete sample evidence is displayed above.';
    } finally {
      if (url) window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  });

  // An optional shareable case selection never becomes HTML or a network request.
  try {
    const initialCase = new URLSearchParams(window.location.search).get('case');
    if (initialCase && Object.prototype.hasOwnProperty.call(cases, initialCase)) {
      selected = initialCase;
      selector.value = initialCase;
    }
  } catch (_) { /* The authored default remains usable in restricted environments. */ }
  render();
})();
