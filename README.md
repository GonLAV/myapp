# QA Copilot — Autonomous AI Testing Agent

An autonomous AI QA testing agent that explores web applications like a human QA engineer, generates test scenarios dynamically, executes them in a real browser, and produces structured bug reports — all without any hardcoded test cases.

---

## Architecture

```
qa-copilot/
├── src/
│   ├── agents/
│   │   ├── QAAgent.ts        # Main orchestrator (explore → generate → execute → report)
│   │   ├── LLMClient.ts      # OpenAI-compatible LLM wrapper + heuristic fallback
│   │   └── ProductRiskRadar.ts # Product risk signal engine
│   ├── api/
│   │   ├── routes.ts         # Express REST API endpoints
│   │   └── server.ts         # Express app factory
│   ├── browser/
│   │   ├── BrowserManager.ts # Playwright browser lifecycle
│   │   ├── PageExplorer.ts   # Page snapshot extraction
│   │   └── ScreenshotManager.ts # Screenshot capture
│   ├── contracts/
│   │   └── RegressionContractBuilder.ts # Converts findings into Playwright specs
│   ├── database/
│   │   ├── Database.ts       # SQLite adapter + schema
│   │   └── Repository.ts     # CRUD for runs, scenarios, bugs, risks
│   ├── config/
│   │   └── Config.ts         # Typed environment configuration
│   ├── observability/
│   │   └── Observability.ts  # In-process events and counters
│   ├── reporters/
│   │   └── BugReporter.ts    # Markdown report + dashboard builder
│   ├── types/
│   │   └── index.ts          # Shared TypeScript types
│   └── index.ts              # Entry point
├── .env.example
├── package.json
└── tsconfig.json
```

### Flow

```
POST /api/runs { url }
       │
       ▼
  1. Explore app → ExplorationMap
       │   (same-origin pages, controls, forms, links, headings, screenshots)
       ▼
  2. LLM or dynamic heuristic engine generates TestScenarios
       │
       ▼
  3. Execute each scenario in isolated Playwright context
       │   (click, fill, navigate, assert_visible, screenshots, action observations)
       ▼
  4. Detect failures and silent product risks
       │   (exceptions, console errors, HTTP 4xx/5xx, dead interactions, accessibility gaps)
       │
       ▼
  5. LLM classifies each failure → BugReport
       │   (title, severity, reproduction steps, expected vs actual)
       ▼
  6. Persist to SQLite; return Dashboard + Product Risk Radar score
```

### Production Design Notes

- **Dynamic behavior by default:** scenarios are inferred from discovered page structure. If `OPENAI_API_KEY` is unavailable, QA Copilot uses a deterministic generator based on live forms, buttons, and links instead of canned tests.
- **Runtime-resilient SQLite:** Node.js 22+ uses built-in `node:sqlite`; older Node runtimes can use optional `better-sqlite3` when native build tools are available.
- **Small, testable boundaries:** browser exploration, LLM reasoning, risk analysis, regression contracts, persistence, reporting, config, and observability each live behind separate modules.
- **CI/CD-ready observability:** run, scenario, bug, and risk events are exposed through `/api/metrics`. This can later be bridged to OpenTelemetry without rewriting the agent.

### Next-Level Feature: Product Risk Radar

Product Risk Radar is a product-intelligence layer for issues normal automation often misses: controls that click but produce no observable result, forms with inaccessible fields, authentication-like flows without obvious submit actions, placeholder navigation, and initial runtime/network instability.

Why it matters: SaaS quality failures are not only exceptions. Many revenue-impacting defects are silent UX failures: a primary CTA does nothing, a signup form lacks accessible labels, or a placeholder link ships in production. QA Copilot converts those signals into a risk score and actionable recommendations, giving product, QA, and engineering teams a triage-ready view instead of a raw automation log.

### Next-Level Feature: Bug-to-Regression Contracts

Bug-to-Regression Contracts turn autonomous findings into durable engineering assets. For every bug and product risk signal, QA Copilot can generate a Playwright spec that replays the discovered scenario, embeds the observed evidence as comments, and is ready to drop into CI.

Why it matters: most QA automation tools stop at a report. Real teams need a way to prevent the same defect from returning. This feature closes the loop from exploration to prevention: AI discovers the issue, QA Copilot writes the regression contract, and engineering can promote it into the test suite with minimal translation work.

---

## Quick Start

### Prerequisites

- Node.js 22+ (built-in `node:sqlite`), or an older Node with the optional `better-sqlite3` module (needs native build tools)
- Optional: an OpenAI API key (or any OpenAI-compatible endpoint). Without it, scenario generation falls back to a deterministic heuristic and bug classification uses default values.

### Install

```bash
npm install
npx playwright install chromium
```

### Configure

```bash
cp .env.example .env
# Edit .env — optionally set OPENAI_API_KEY (without it, heuristic scenario generation is used)
```

### Start the server

```bash
npm run build
npm start
# Server starts on http://localhost:3000
```

### Trigger a QA run

```bash
curl -X POST http://localhost:3000/api/runs \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-app.example.com"}'
# → {"runId":"<uuid>","message":"QA run started. Poll GET /api/runs/<uuid> for status."}
```

### Poll for status

```bash
curl http://localhost:3000/api/runs/<runId>
```

### Get the full Markdown report

```bash
curl http://localhost:3000/api/runs/<runId>/report
```

### Get the structured JSON dashboard

```bash
curl http://localhost:3000/api/runs/<runId>/dashboard
```

---

## REST API Reference

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/runs` | Start a new QA run. `url` must be `http` or `https`; any other value returns `400` |
| `GET` | `/api/runs` | List all runs |
| `GET` | `/api/runs/:id` | Get run status |
| `GET` | `/api/runs/:id/dashboard` | Full JSON dashboard |
| `GET` | `/api/runs/:id/report` | Markdown report |
| `GET` | `/api/runs/:id/bugs` | All bugs for a run |
| `GET` | `/api/runs/:id/scenarios` | All test scenarios for a run |
| `GET` | `/api/runs/:id/risks` | Product Risk Radar signals for a run |
| `GET` | `/api/runs/:id/regression-contract` | JSON metadata plus generated Playwright regression spec |
| `GET` | `/api/runs/:id/regression-spec` | Raw downloadable Playwright spec |
| `GET` | `/api/metrics` | In-process counters and recent QA events |
| `GET` | `/health` | Health check |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | _(optional)_ | OpenAI API key. Without it, scenario generation uses a deterministic heuristic and bug classification uses default values |
| `OPENAI_BASE_URL` | OpenAI default | Override for Azure / Ollama / LM Studio |
| `OPENAI_MODEL` | `gpt-4o-mini` | Model for test generation |
| `PORT` | `3000` | HTTP server port |
| `DATABASE_PATH` | `./qa_copilot.db` | SQLite file path |
| `SCREENSHOTS_DIR` | `./screenshots` | Directory for screenshots |
| `HEADLESS` | `true` | Set to `false` (also `0`, `no`, `off`) for a visible browser; any other or missing value runs headless |
| `BROWSER_WIDTH` | `1280` | Viewport width |
| `BROWSER_HEIGHT` | `800` | Viewport height |
| `STEP_TIMEOUT_MS` | `10000` | Per-action Playwright timeout for scenario steps, and also the ceiling for `wait` steps. Page discovery uses a fixed 15-second navigation timeout |
| `DISCOVERY_PAGE_LIMIT` | `4` | Maximum same-origin pages explored before scenario generation (max `10`) |
| `MAX_SCENARIOS` | `12` | Maximum number of scenarios per run (1-50) |

---

## Bug Report Format

Each detected bug includes:

- **Title** — concise, actionable
- **Severity** — `critical` / `high` / `medium` / `low`
- **Description** — full narrative
- **Reproduction Steps** — numbered list
- **Expected vs Actual Behaviour**
- **Screenshot** — full-page PNG, captured when a scenario step throws an error
- **Console Errors** — captured from the browser
- **Network Errors** — HTTP 4xx/5xx and failed requests

Errors that were observed while the pages were being explored do not fail a scenario. They appear in the `technical_reliability` Product Risk Radar signal of the page that was scanned, with each unique error listed once per signal; an error seen on several pages can appear in several signals. The signals are available at `GET /api/runs/:id/risks`, in the dashboard JSON and in the Markdown report. Any other error fails the scenario and produces a bug: an intermittent error on the scenario's own page load, an error on a page that was not scanned, an error caused by an interaction (a click, fill or navigation step), and a favicon failure that was not observed during the scan. URLs inside error messages are compared without their query string and fragment, so a cache-buster does not make a known error look new; on the other hand, two requests to the same endpoint that differ only in their parameters count as the same error.

Each Product Risk Radar signal includes:

- **Type** — `dead_interaction`, `accessibility_gap`, `conversion_friction`, `navigation_risk`, `technical_reliability`, or `coverage_gap`
- **Severity** — `critical` / `high` / `medium` / `low`
- **Evidence** — browser-observed proof for the signal
- **Recommendation** — product/engineering action to reduce the risk
- **Risk Score** — 0-100 run-level score shown in dashboards and reports

---

## Development

```bash
# Type-check
npx tsc --noEmit

# Run tests
npm test

# Lint
npm run lint

# Dev mode (ts-node, no build step)
npm run dev
```

---

## CI/CD Integration

The REST API is designed to be called from CI pipelines:

```yaml
# Example GitHub Actions step
- name: Run QA Copilot
  run: |
    RUN_ID=$(curl -s -X POST $QA_COPILOT_URL/api/runs \
      -H "Content-Type: application/json" \
      -d "{\"url\": \"$DEPLOY_URL\"}" | jq -r .runId)
    
    # Wait for completion
    while true; do
      STATUS=$(curl -s $QA_COPILOT_URL/api/runs/$RUN_ID | jq -r .status)
      [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ] && break
      sleep 10
    done
    
    # Download report
    curl -s $QA_COPILOT_URL/api/runs/$RUN_ID/report > qa-report.md
```

