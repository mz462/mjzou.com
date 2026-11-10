/* WebMCP bridge (navigator.modelContext, W3C draft).
 *
 * Exposes the desk's engine-backed tools to the visitor's browser agent.
 * Tool schemas come from GET /api/tools (the same tools_core contract the
 * chat loop and MCP server use); every execute() round-trips through
 * POST /api/tools/call so each number the agent sees is engine-computed.
 * Each call is mirrored onto the page as a `desk:agent-tool` event so the
 * human watching sees the same inspectable cards a chat turn produces.
 */
(function () {
  const mc = typeof navigator !== 'undefined' ? navigator.modelContext : null;
  if (!mc || typeof mc.registerTool !== 'function') return;

  function pageModelId() {
    return new URL(window.location.href).searchParams.get('model_id') || null;
  }

  async function callTool(name, args) {
    const response = await fetch('/api/tools/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, arguments: args }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `Tool call failed (${response.status})`);
    }
    return payload;
  }

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : { results: value };
  }

  // Mirrors the SSE event mapping in server/app.py so demo.js renders agent
  // calls through its existing card renderers.
  function pageEvents(name, args, payload) {
    const results = payload.results;
    if (name === 'search_catalog') {
      return [{
        eventName: 'catalog_results',
        payload: {
          kind: args.kind,
          query: args.query || '',
          results: Array.isArray(results) ? results : [],
          error: Array.isArray(results) ? null : (results?.error ?? null),
        },
      }];
    }
    if (name === 'resolve_reference') {
      return [{
        eventName: 'reference_results',
        payload: { reference: args.reference || '', resolution: asObject(results) },
      }];
    }
    if (name === 'read_story') {
      // the same link card the desk shows when its own model retells the story
      const value = asObject(results);
      return [{
        eventName: 'story',
        payload: {
          url: value.url,
          parts: (value.parts || []).map((part) => ({ id: part.id, title: part.title, url: part.url })),
        },
      }];
    }
    if (['search_model_context', 'explain_metric', 'compare_metric_logic'].includes(name)) {
      return [{
        eventName: 'knowledge_results',
        payload: { tool: name, query: args.query || args.metric || '', results },
      }];
    }
    if (name === 'evaluate_scenarios') {
      return [
        { eventName: 'tool_call', payload: { name, scenarios: args.scenarios || [{}] } },
        {
          eventName: 'results',
          payload: {
            results: Array.isArray(results) ? results : [results],
            mock: payload.mock,
          },
        },
      ];
    }
    if (name === 'run_sensitivity') {
      return [{
        eventName: 'sensitivity_results',
        payload: { ...asObject(results), mock: payload.mock },
      }];
    }
    if (name === 'solve_scenarios') {
      return [{
        eventName: 'solver_results',
        payload: { ...asObject(results), mock: payload.mock },
      }];
    }
    if (name === 'validate_scenario_set' || name === 'save_scenario_set') {
      return [{
        eventName: 'scenario_set',
        payload: {
          draft: results?.draft || results,
          saved: results?.scenario_set || null,
        },
      }];
    }
    if (name === 'evaluate_scenario_set') {
      return [
        { eventName: 'tool_call', payload: { name, scenarios: [] } },
        {
          eventName: 'results',
          payload: { ...asObject(results), mock: payload.mock },
        },
      ];
    }
    return [];
  }

  function mirror(name, events) {
    document.dispatchEvent(new CustomEvent('desk:agent-tool', {
      detail: { label: `Agent · ${name}`, events },
    }));
  }

  // Page tools: teaching cards backed by precomputed evaluate_scenarios
  // grids (web/teach/*.json, cleanroom_senior_living). Every figure returned
  // is a stored engine run; this file only indexes and counts rows.
  const teachCache = {};
  async function teachData(kind) {
    if (!teachCache[kind]) {
      const response = await fetch(`/static/teach/${kind}.json`);
      if (!response.ok) throw new Error(`teaching data unavailable (${response.status})`);
      teachCache[kind] = await response.json();
    }
    return teachCache[kind];
  }

  function registerPageTools() {
    mc.registerTool({
      name: 'page_show_console',
      description: 'Show the interactive deal-console teaching card in the chat: five dials '
        + '(stabilized occupancy, interest rate, wage growth, exit cap, GP co-invest; staffing stays as underwritten) '
        + 'over a full-factorial grid of precomputed engine runs (Senior Living Sample Model). Pass '
        + 'detent indexes to preset the dials; returns the selected combination’s engine outputs.',
      inputSchema: {
        type: 'object',
        properties: {
          occupancy: { type: 'integer', description: 'stabilized occupancy: 0=96% … 4=88%' },
          rate: { type: 'integer', description: 'interest rate: 0=6.5% … 3=8%' },
          wage: { type: 'integer', description: 'wage growth: 0=2.5% … 3=4%' },
          exit_cap: { type: 'integer', description: 'exit cap: 0=6.0% … 4=8.0%' },
          gp_coinvest: { type: 'integer', description: 'GP co-invest: 0=5% … 3=20%' },
        },
      },
      async execute(args) {
        const data = await teachData('console');
        const detents = data.dials.map((dial) => {
          const value = Number.isInteger(args?.[dial.id]) ? args[dial.id] : dial.base;
          return Math.min(Math.max(value, 0), dial.detents.length - 1);
        });
        let index = 0;
        data.dials.forEach((dial, i) => { index = index * dial.detents.length + detents[i]; });
        const [gp, lp, deal, unlev, loan, dscr, flags, dgp] = data.rows[index];
        mirror('page_show_console', [{
          eventName: 'teach_visual',
          payload: { visual: 'console', detents },
        }]);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              model_id: data.model_id,
              engine_run: `${index + 1} of ${data.rows.length}`,
              dials: Object.fromEntries(data.dials.map((dial, i) => [dial.id, dial.detents[detents[i]]])),
              gp_irr: gp === null ? null : `${(gp / 100).toFixed(2)}%`,
              lp_irr: lp === null ? null : `${(lp / 100).toFixed(2)}%`,
              deal_irr: deal === null ? null : `${(deal / 100).toFixed(2)}%`,
              unlevered_irr: unlev === null ? null : `${(unlev / 100).toFixed(2)}%`,
              loan,
              dscr: dscr / 100,
              gp_delta_bps_vs_base: dgp,
              promote_lost: Boolean(flags & 1),
              leverage_inverted: Boolean(flags & 2),
              loan_resized: Boolean(flags & 4),
            }),
          }],
        };
      },
    });
    mc.registerTool({
      name: 'page_show_cloud',
      description: 'Show the scenario-cloud teaching card in the chat: precomputed engine runs '
        + '(Senior Living Sample Model) over nine assumptions — stabilized occupancy, rent growth, '
        + 'wage growth, non-labor opex growth, management fee, exit cap, '
        + 'interest rate, max loan-to-cost, GP co-invest — drawn as parallel coordinates colored '
        + 'by GP IRR. Optionally highlight a GP IRR band (percent, e.g. irr_min 15).',
      inputSchema: {
        type: 'object',
        properties: {
          irr_min: { type: 'number', description: 'lower GP IRR bound in percent' },
          irr_max: { type: 'number', description: 'upper GP IRR bound in percent' },
        },
      },
      async execute(args) {
        const data = await teachData('cloud');
        const irrIndex = data.dims.length;
        const lo = Number.isFinite(args?.irr_min) ? args.irr_min : -Infinity;
        const hi = Number.isFinite(args?.irr_max) ? args.irr_max : Infinity;
        const matched = data.rows.filter(
          (row) => row[irrIndex] !== null && row[irrIndex] >= lo && row[irrIndex] <= hi,
        ).length;
        mirror('page_show_cloud', [{
          eventName: 'teach_visual',
          payload: { visual: 'cloud', irr_min: args?.irr_min, irr_max: args?.irr_max },
        }]);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              model_id: data.model_id,
              total_runs: data.rows.length,
              matched_runs: matched,
              axes: data.dims.map((dim) => `${dim.label} (${dim.group})`),
              gp_irr_range_pct: [data.irr.lo, data.irr.hi],
              runs_without_gp_irr: data.no_irr,
              note: 'all rows are stored evaluate_scenarios results; nothing interpolated',
            }),
          }],
        };
      },
    });
  }

  async function init() {
    registerPageTools();
    let tools = [];
    try {
      const response = await fetch('/api/tools');
      if (!response.ok) return; // mock mode: no engine tools to expose
      tools = (await response.json()).tools || [];
    } catch (_) {
      return;
    }
    tools.forEach((tool) => {
      mc.registerTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.input_schema,
        async execute(args) {
          const merged = { ...(args || {}) };
          if (!merged.model_id && pageModelId() && tool.input_schema?.properties?.model_id) merged.model_id = pageModelId();
          try {
            const payload = await callTool(tool.name, merged);
            mirror(tool.name, pageEvents(tool.name, merged, payload));
            return {
              content: [{ type: 'text', text: JSON.stringify(payload.results) }],
            };
          } catch (error) {
            const message = String(error?.message || error);
            mirror(tool.name, [{ eventName: 'error', payload: { message } }]);
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
              isError: true,
            };
          }
        },
      });
    });
  }

  init();
}());
