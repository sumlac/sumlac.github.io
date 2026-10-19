# Repository security checks

This repository runs two connected security pipelines against its own source and
an ephemeral site served on loopback. GitHub Actions runs them on pushes to
`main`, pull requests, manually, and every six hours at minute 17. Scheduled jobs
run from the default branch and GitHub may delay them. These are maintenance
checks for this website. The public factory essays describe a broader personal
vision, with illustrative walkthroughs; they do not display these CI results.
Workflow artifacts record what the repository checks actually executed.

## Run locally

Use Node 22 or newer, install the exact development dependency versions with
`npm ci --ignore-scripts`, and run `npm test` for the regression suite.

For the complete factory-page checks, install Chromium with
`npx playwright install chromium`, serve this checkout on loopback with
`python3 -m http.server 8000 --bind 127.0.0.1`, and use another terminal:

```sh
node scripts/factory-offense.cjs --browser --url http://127.0.0.1:8000 --output artifacts/factory/offense.json
node scripts/factory-defense.cjs --browser --offense-report artifacts/factory/offense.json --output artifacts/factory/defense.json
```

`npm run factory` runs the source checks followed by defense; it does not
include the browser checks. Browser mode blocks requests outside the local test
origin. It never probes sumlac.com or another public host. There are no model API
calls, API keys, or production credentials in this initial implementation.

## Offense and defense

Offense checks the public factory documents for broken local links, missing
assets, duplicate anchors, and script syntax errors. When requested, the browser
checks the homepage links and contact path, process-stage keyboard navigation,
all sample walkthroughs, their labeled JSON downloads, and hostile case-selection
query values. Each check records passed, failed, or inconclusive, including
reproduction details for failures. A failed check is evidence for that case;
a passing corpus is not a claim that the site has no vulnerabilities.

Defense consumes those results without changing their outcome, runs the full
Node regression suite, and parses the repository's HTML with source locations.
Its source checks currently cover explicit opener isolation on external
new-tab links and unencrypted remote executable scripts. HTTPS scripts without
an integrity pin are labeled review candidates and leave the result
inconclusive pending review; they are not presented as demonstrated exploits.
This static audit does not establish JavaScript data flow, server headers,
CSP enforcement, backend security, or model security.

Defense's only automatic proposal is the conservative addition of `noopener`
to external new-tab links that lack both `noopener` and `noreferrer`. This is an
explicit defense-in-depth property; modern browsers often imply `noopener`
already. The factory preserves existing link behavior and rel tokens, writes a
reviewable patch, checks and applies those exact artifact bytes with `git apply`
only to a temporary copy, and confirms the resulting file hashes. It marks the
proposal verified only after reparsing the copy, rerunning its full regression suite,
and rerunning offense with valid passing evidence. CI also repeats the browser
corpus in that copy. Failed or incomplete verification is labeled accordingly.

No arbitrary code repair is attempted. Findings without a supported repair stay
open. A clean run produces no patch proposals. Even a verified proposal leaves
the original finding open until a human reviews and merges the change. The
workflow never commits, opens a PR, changes production, or merges code.

## Evidence and review

The workflow has read-only repository permissions and uses commit-pinned
GitHub-maintained actions. It uploads evidence on failure as well as success.
Artifacts are retained for 30 days:

| Artifact | Contents |
| --- | --- |
| `offense-factory` | `offense.json`, the offense Markdown report, local server log |
| `defense-factory` | Upstream evidence, `defense.json`, `defense-manifest.json`, eligible `.patch` proposals |

JSON reports include the target, check outcomes, findings, timestamps, and a
summary. Defense proposals include file hashes and verification logs. Exit
codes are 0 for passed, 1 for failed, and 2 for inconclusive. Missing browser
dependencies, missing evidence, and malformed or contradictory reports are
never silently converted into a passing result.

Review a generated patch alongside its reproduction and verification evidence.
Apply it to a review branch with `git apply --check` followed by `git apply`,
rerun the corpus and regressions, and use the repository's normal human review
process before merging. The automation's scope is intentionally limited to
this repository; future model-driven analysis would require a separately
configured implementation and explicit scope.
