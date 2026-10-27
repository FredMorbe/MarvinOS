import { existsSync, readdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** macii permission mode -> Codex sandbox. Codex has no "plan" mode and no auto mode that survives `exec resume`, so those are not offered. */
export const CODEX_MODES = { manual: 'read-only', plan: 'read-only', acceptEdits: 'workspace-write' };

const versionOf = name => name.split('_')[1]?.split('.').map(Number) ?? [];
const newer = (a, b) => { const x = versionOf(a), y = versionOf(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0); return 0; };

let found = null;
/**
 * The Codex CLI. Order: AIOS_CODEX, `codex.exe` on PATH, the executable bundled with the Microsoft Store app (its folder name
 * carries the app version, so it is looked up on every hub start instead of being written down).
 */
export function findCodex(env = process.env) {
  if (env.AIOS_CODEX) {
    if (!existsSync(env.AIOS_CODEX)) throw new Error(`AIOS_CODEX points to ${env.AIOS_CODEX}, which does not exist`);
    return env.AIOS_CODEX;
  }
  if (found && existsSync(found)) return found;
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const p = join(dir, exe);
    if (existsSync(p)) return (found = p);
  }
  if (process.platform === 'win32') {
    const apps = join(env.ProgramFiles ?? 'C:\\Program Files', 'WindowsApps');
    let names = [];
    try { names = readdirSync(apps).filter(n => /^OpenAI\.Codex_/.test(n)).sort(newer); } catch { /* not listable: treated as not installed below */ }
    for (const n of names) {
      const p = join(apps, n, 'app', 'resources', 'codex.exe');
      if (existsSync(p)) return (found = p);
    }
  }
  throw new Error('Codex CLI not found. Install the Codex app or `npm i -g @openai/codex`, or set AIOS_CODEX to the codex executable.');
}

/**
 * `codex exec resume` continues the thread in place and `exec` has no fork, so an edited message cannot be taken back out of the thread
 * (if the cancelled run had already recorded it). The replacement tells the model to disregard it.
 */
export const WITHDRAWN_NOTE = '[macii] The user withdrew their previous message before you answered it. Ignore it completely; it was never sent. Their message now is:\n\n';

/** arguments for `codex exec` (or `exec resume`); the prompt goes in on stdin, so it is not limited by the Windows command line length */
export function buildCodexArgs({ agent, resumeSessionId }) {
  const sandbox = CODEX_MODES[agent.mode ?? 'manual'];
  if (!sandbox) throw new Error(`permission mode "${agent.mode}" is not available for Codex agents`);
  const args = ['exec'];
  if (resumeSessionId) args.push('resume', resumeSessionId);
  // -s does not exist on `exec resume`, so everything goes through -c. The user's ~/.codex/config.toml is ignored on purpose: it loads the
  // desktop app's plugins and MCP servers (slow, and tools nobody gave this agent), asks for approvals nobody could answer in a headless
  // run, and its model made runs hang before the first answer. What is left of it that a run needs is set here.
  args.push('--json', '--skip-git-repo-check', '--ignore-user-config', '-c', `sandbox_mode=${JSON.stringify(sandbox)}`, '-c', 'approval_policy="never"');
  if (process.platform === 'win32') args.push('-c', 'windows.sandbox="elevated"'); // the sandbox the Codex app sets up; without it a run waits forever
  if (agent.model) args.push('-m', agent.model);
  const role = agent.mode === 'plan'
    ? [agent.role, 'You are in plan mode: only read and analyse. Do not change anything. Answer with a plan.'].filter(Boolean).join('\n\n')
    : agent.role;
  if (role) args.push('-c', `developer_instructions=${JSON.stringify(role)}`); // a JSON string is a valid TOML basic string
  args.push('-');
  return args;
}

const FILE_TOOL = { add: 'Write', update: 'Edit', delete: 'Edit' };

/** `codex exec --json` lines -> the same normalized events as ClaudeStream */
export class CodexStream {
  #tokens = 0;
  #thread = null;
  #lastText = '';

  push(obj) {
    switch (obj.type) {
      case 'thread.started':
        this.#thread = obj.thread_id;
        return [{ kind: 'init', session_id: obj.thread_id, model: null, tools: [], mcp_servers: [] }];
      case 'turn.started': return [];
      case 'item.started': return this.#started(obj.item ?? {});
      case 'item.completed': return this.#completed(obj.item ?? {});
      case 'turn.completed': {
        const u = obj.usage ?? {};
        // cache reads are re-billed context on every turn: leave them out, like the Claude count
        this.#tokens += Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0)) + (u.output_tokens ?? 0);
        return [{ kind: 'usage', owner: 'main' }, { kind: 'result', is_error: false, subtype: 'success', text: this.#lastText, session_id: this.#thread, turns: 1, usage: u }];
      }
      case 'turn.failed':
        return [{ kind: 'result', is_error: true, subtype: 'turn.failed', text: obj.error?.message ?? 'turn failed', session_id: this.#thread, turns: 1 }];
      default: return [{ kind: 'unknown', type: obj.type, message: obj.message }];
    }
  }

  tokenTotals() { return new Map([['main', this.#tokens]]); }

  #started(item) {
    switch (item.type) {
      case 'command_execution': return [{ kind: 'tool', owner: 'main', name: 'Bash', tool_use_id: item.id, input: { command: item.command } }];
      case 'file_change': return (item.changes ?? []).map(c => ({ kind: 'tool', owner: 'main', name: FILE_TOOL[c.kind] ?? 'Edit', tool_use_id: item.id, input: { file_path: c.path } }));
      case 'mcp_tool_call': return [{ kind: 'tool', owner: 'main', name: `${item.server}.${item.tool}`, tool_use_id: item.id, input: item.arguments ?? {} }];
      case 'web_search': return [{ kind: 'tool', owner: 'main', name: 'WebSearch', tool_use_id: item.id, input: { query: item.query } }];
      default: return [];
    }
  }

  #completed(item) {
    switch (item.type) {
      case 'agent_message':
        if (!item.text) return [];
        this.#lastText = item.text;
        return [{ kind: 'text', owner: 'main', text: item.text }];
      case 'command_execution':
        return item.exit_code ? [{ kind: 'tool_error', tool_use_id: item.id, text: `exit ${item.exit_code}: ${String(item.aggregated_output ?? '').slice(0, 400)}` }] : [];
      case 'error': return [{ kind: 'tool_error', tool_use_id: item.id, text: String(item.message ?? 'error').slice(0, 500) }];
      case 'reasoning': case 'todo_list': case 'file_change': case 'mcp_tool_call': case 'web_search': return [];
      default: return [{ kind: 'unknown', type: `item.${item.type}` }];
    }
  }
}
