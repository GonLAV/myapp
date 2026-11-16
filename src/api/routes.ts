import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { QAAgent } from '../agents/QAAgent';
import {
  getRun,
  getAllRuns,
  getScenariosByRun,
  getBugsByRun,
  getRiskSignalsByRun,
} from '../database/Repository';
import { buildDashboard, BugReporter } from '../reporters/BugReporter';
import { RegressionContractBuilder } from '../contracts/RegressionContractBuilder';
import { observability } from '../observability/Observability';
import { isHttpUrl } from '../agents/executionGuards';
import type { CreateRunResponse, TestRun } from '../types';

const router = Router();

// Schema validation
const CreateRunSchema = z.object({
  url: z.string().url('Must be a valid URL').refine(isHttpUrl, 'URL must use http or https'),
});

type RunHandler = (req: Request, res: Response, run: TestRun) => void;

// Load the run for :id (404 if missing) and turn unexpected failures into a JSON 500.
function withRun(handler: RunHandler) {
  return (req: Request, res: Response): void => {
    try {
      const run = getRun(req.params.id);
      if (!run) {
        res.status(404).json({ error: 'Run not found.' });
        return;
      }
      handler(req, res, run);
    } catch (err) {
      console.error('[API] Failed to load run data:', err);
      res.status(500).json({ error: 'Failed to load run data.' });
    }
  };
}

function loadRunData(run: TestRun) {
  return {
    scenarios: getScenariosByRun(run.id),
    bugs: getBugsByRun(run.id),
    risks: getRiskSignalsByRun(run.id),
  };
}

// Shared agent instance (singleton per process)
const agent = new QAAgent();

// ─── POST /api/runs ──────────────────────────────────────────────────────────
// Trigger a new QA test run for a given URL.
router.post('/runs', async (req: Request, res: Response): Promise<void> => {
  const parsed = CreateRunSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0].message });
    return;
  }

  const { url } = parsed.data;

  try {
    const runId = await agent.startRun(url);
    const body: CreateRunResponse = {
      runId,
      message: `QA run started. Poll GET /api/runs/${runId} for status.`,
    };
    res.status(202).json(body);
  } catch (err) {
    console.error('[API] Failed to start run:', err);
    res.status(500).json({ error: 'Failed to start QA run.' });
  }
});

// ─── GET /api/runs ────────────────────────────────────────────────────────────
// List all test runs.
router.get('/runs', (_req: Request, res: Response): void => {
  try {
    const runs = getAllRuns();
    res.json(runs);
  } catch (err) {
    console.error('[API] Failed to list runs:', err);
    res.status(500).json({ error: 'Failed to retrieve runs.' });
  }
});

// ─── GET /api/runs/:id ────────────────────────────────────────────────────────
// Get the status and summary of a specific test run.
router.get('/runs/:id', withRun((_req, res, run) => {
  res.json(run);
}));

// ─── GET /api/runs/:id/dashboard ─────────────────────────────────────────────
// Get the full structured dashboard (JSON) for a completed run.
router.get('/runs/:id/dashboard', withRun((_req, res, run) => {
  const { scenarios, bugs, risks } = loadRunData(run);
  const dashboard = buildDashboard(run, scenarios, bugs, risks);
  res.json(dashboard);
}));

// ─── GET /api/runs/:id/report ─────────────────────────────────────────────────
// Get the full Markdown report for a completed run.
router.get('/runs/:id/report', withRun((_req, res, run) => {
  const { scenarios, bugs, risks } = loadRunData(run);
  const dashboard = buildDashboard(run, scenarios, bugs, risks);
  const markdown = BugReporter.renderDashboard(dashboard);

  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.send(markdown);
}));

// ─── GET /api/runs/:id/bugs ───────────────────────────────────────────────────
// Get all bugs found in a specific run.
router.get('/runs/:id/bugs', withRun((_req, res, run) => {
  res.json(getBugsByRun(run.id));
}));

// ─── GET /api/runs/:id/scenarios ─────────────────────────────────────────────
// Get all test scenarios for a specific run.
router.get('/runs/:id/scenarios', withRun((_req, res, run) => {
  res.json(getScenariosByRun(run.id));
}));

// ─── GET /api/runs/:id/risks ────────────────────────────────────────────────
// Get all Product Risk Radar signals for a specific run.
router.get('/runs/:id/risks', withRun((_req, res, run) => {
  res.json(getRiskSignalsByRun(run.id));
}));

// ─── GET /api/runs/:id/regression-contract ─────────────────────────────────
// Generate a Playwright regression contract from bugs and risk signals.
router.get('/runs/:id/regression-contract', withRun((_req, res, run) => {
  const { scenarios, bugs, risks } = loadRunData(run);
  const contract = new RegressionContractBuilder().build(run, scenarios, bugs, risks);
  res.json(contract);
}));

// ─── GET /api/runs/:id/regression-spec ─────────────────────────────────────
// Download the generated Playwright spec directly for CI adoption.
router.get('/runs/:id/regression-spec', withRun((_req, res, run) => {
  const { scenarios, bugs, risks } = loadRunData(run);
  const contract = new RegressionContractBuilder().build(run, scenarios, bugs, risks);

  res.setHeader('Content-Type', 'text/typescript; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${contract.specFilename}"`);
  res.send(contract.spec);
}));

// ─── GET /api/metrics ───────────────────────────────────────────────────────
// Lightweight observability endpoint for local runs and CI smoke checks.
router.get('/metrics', (_req: Request, res: Response): void => {
  res.json(observability.metrics());
});

export default router;
