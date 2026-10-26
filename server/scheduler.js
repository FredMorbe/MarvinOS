import { Cron } from 'croner';

export function validateCron(expr) {
  new Cron(expr, { paused: true }); // throws on an invalid expression
}

const GRACE_MS = 10_000; // retry slightly after the window resets, not on the edge

export function createScheduler({ store, runner, bus, guard, graceMs = GRACE_MS, onChange = () => {} }) {
  const jobs = new Map();     // agentId -> Cron (the agent's schedule)
  const deferred = new Map(); // agentId -> { job: Cron, until: ms } (one-shot retry after a limit window resets)

  const warn = (agent, title, body) => bus.push('inbox', store.addInbox({ agent_id: agent.id, type: 'warning', title, body }));
  const clock = ts => new Date(ts).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

  /** one scheduled start: skip if still running, hold back if the limit guard says so, otherwise run */
  function fire(agentId) {
    const agent = store.getAgent(agentId);
    if (!agent || !agent.enabled) return { started: false, reason: 'agent missing or disabled' };
    if (store.listActiveRuns().some(r => r.agent_id === agent.id)) {
      warn(agent, `${agent.name}: routine skipped`, 'The previous run was still active when the schedule fired.');
      return { started: false, reason: 'previous run still active' };
    }
    const verdict = guard.check(agent);
    if (!verdict.ok) { defer(agent, verdict); return { started: false, reason: verdict.reason, until: verdict.until }; }
    runner.enqueue(agent.id, { trigger: 'schedule' });
    return { started: true };
  }

  function defer(agent, verdict) {
    const first = !deferred.has(agent.id);
    deferred.get(agent.id)?.job.stop();
    const at = verdict.until + graceMs;
    const job = new Cron(new Date(at), { name: `aios-defer-${agent.id}` }, () => { deferred.delete(agent.id); onChange(); fire(agent.id); });
    deferred.set(agent.id, { job, until: at });
    onChange();
    if (first) {
      warn(agent, `${agent.name}: run held back by the limit guard`,
        `${verdict.reason}. It will be tried again at ${clock(at)}, when the ${verdict.label} window resets. Start it manually to run it now.`);
    }
  }

  function sync() {
    for (const job of jobs.values()) job.stop();
    jobs.clear();
    for (const agent of store.listAgents()) {
      if (!agent.enabled || !agent.schedule) continue;
      jobs.set(agent.id, new Cron(agent.schedule, {
        name: `aios-${agent.id}`,
        catch: e => {
          console.error(`schedule ${agent.id}:`, e);
          const item = store.addInbox({ agent_id: agent.id, type: 'warning', title: `${agent.name}: scheduled run failed to start`, body: e.message });
          bus.push('inbox', item);
        },
      }, () => {
        // a firing while a retry is already pending would only repeat the same decision
        if (deferred.has(agent.id)) return;
        fire(agent.id);
      }));
    }
  }

  return {
    sync, fire,
    nextRun: agentId => jobs.get(agentId)?.nextRun()?.getTime() ?? null,
    upcoming: (agentId, until) => (jobs.get(agentId)?.nextRuns(48) ?? []).map(d => d.getTime()).filter(t => t <= until),
    deferredUntil: agentId => deferred.get(agentId)?.until ?? null,
  };
}
