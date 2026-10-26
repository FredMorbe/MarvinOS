// Adapter for `claude -p --output-format stream-json --verbose`.
// Turns the CLI's JSON lines into normalized events the runner understands.

export const INBOX_TOOL = 'mcp__aios__inbox_send';

export const SYSTEM_APPEND = [
  'You run unattended inside AIOS, a hub that schedules agents. The user is not watching this session.',
  `Report to the user only through the tool ${INBOX_TOOL}:`,
  '- type "result": when you are finished. Short title and a concise summary in body.',
  '- type "question": when you need a decision. Put 2-4 short answers in options if possible, then stop.',
  '- type "approval": before an action you are not allowed to perform. Describe exactly what you want to do and list the narrowest tool permission patterns it needs in permissions (for example "Write" or "Bash(npm install zod)"), then stop. Only those patterns are granted if the user approves.',
  '- type "warning": for non-fatal problems the user should know about.',
  'After sending a question or approval, end your turn immediately. The run resumes with the answer.',
].join('\n');

// Chat runs: the user is reading along, so the answer goes straight into the reply instead of the inbox.
export const CHAT_APPEND = [
  'You are in a live chat inside AIOS, a hub for agents. The user reads your replies directly: answer in plain text, ask questions in plain text.',
  `Use the tool ${INBOX_TOOL} only for type "approval": before an action you are not allowed to perform, describe it and list the narrowest tool permission patterns it needs in permissions (for example "Write" or "Bash(npm install zod)"), then end your turn. Only those patterns are granted if the user approves.`,
].join('\n');

export const MEMORY_APPEND = [
  'A knowledge graph of this project (code structure, calls, imports, communities) is available through the graphify tools',
  '(mcp__graphify__query_graph, get_node, get_neighbors, get_community, god_nodes, graph_stats, shortest_path).',
  'For structural questions such as "what calls X" or "where is Y used", ask the graph first and read only the files it points to.',
  'Edges marked INFERRED are deductions, not facts; verify them in the source before relying on them.',
].join('\n');

/** AIOS permission mode -> `claude --permission-mode`. Headless runs cannot answer a prompt, so "manual" is dontAsk: what is not allowed is denied and the agent asks in the inbox. */
export const PERMISSION_MODES = { manual: 'dontAsk', acceptEdits: 'acceptEdits', plan: 'plan', auto: 'auto' };

export function buildClaudeArgs({ agent, allowedTools, memory = false, chat = false, resumeSessionId, fork = false, mcpConfigFile }) {
  const cliMode = PERMISSION_MODES[agent.mode ?? 'manual'];
  if (!cliMode) throw new Error(`unknown permission mode "${agent.mode}"`);
  const base = chat ? CHAT_APPEND : SYSTEM_APPEND;
  const system = agent.role ? [base, 'Your role:', agent.role].join('\n\n') : base;
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', cliMode,
    '--strict-mcp-config',
    '--mcp-config', mcpConfigFile,
    '--append-system-prompt', memory ? `${system}\n${MEMORY_APPEND}` : system,
  ];
  if (cliMode !== 'dontAsk') args.push('--permission-prompts', 'none'); // anything that would still prompt is denied instead of waiting for nobody
  if (agent.model) args.push('--model', agent.model);
  if (agent.effort) args.push('--effort', agent.effort);
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  // a fork writes into its own session, so the session it came from stays clean when the run is cancelled and its message edited
  if (resumeSessionId && fork) args.push('--fork-session');
  // variadic flag: keep it last
  args.push('--allowedTools', [INBOX_TOOL, ...allowedTools].join(','));
  return args;
}

const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);
const textOf = content => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '');

// Claude Code wraps a subagent's report in a notice + indented block. Keep only the report; leave unknown shapes untouched.
const HANDBACK_MARKER = 'The report follows:\n';
const unwrapHandback = text => {
  const i = text.indexOf(HANDBACK_MARKER);
  return i < 0 ? text : text.slice(i + HANDBACK_MARKER.length).replace(/^ {2}/gm, '');
};

export class ClaudeStream {
  #subagents = new Set();
  #messageTokens = new Map(); // message id -> { owner, tokens }

  /** @returns {object[]} normalized events for one stdout JSON object */
  push(obj) {
    switch (obj.type) {
      case 'system':
        return obj.subtype === 'init'
          ? [{ kind: 'init', session_id: obj.session_id, model: obj.model, tools: obj.tools, mcp_servers: obj.mcp_servers }]
          : [{ kind: 'system', subtype: obj.subtype }];
      case 'assistant': return this.#assistant(obj);
      case 'user': return this.#user(obj);
      case 'rate_limit_event': return [{ kind: 'rate', info: obj.rate_limit_info }];
      case 'result':
        return [{
          kind: 'result', is_error: !!obj.is_error, subtype: obj.subtype, text: obj.result ?? '',
          session_id: obj.session_id, turns: obj.num_turns, duration_ms: obj.duration_ms, usage: obj.usage,
        }];
      default: return [{ kind: 'unknown', type: obj.type }];
    }
  }

  /** tokens per owner ('main' or a subagent tool_use_id), counting each message once */
  tokenTotals() {
    const totals = new Map();
    for (const { owner, tokens } of this.#messageTokens.values()) totals.set(owner, (totals.get(owner) ?? 0) + tokens);
    return totals;
  }

  #assistant(obj) {
    const out = [];
    const owner = obj.parent_tool_use_id ?? 'main';
    const msg = obj.message ?? {};
    for (const block of msg.content ?? []) {
      if (block.type === 'text' && block.text) out.push({ kind: 'text', owner, text: block.text });
      else if (block.type === 'tool_use' && SUBAGENT_TOOLS.has(block.name)) {
        this.#subagents.add(block.id);
        out.push({
          kind: 'subagent_start', tool_use_id: block.id, parent_tool_use_id: obj.parent_tool_use_id ?? null,
          type: block.input?.subagent_type ?? null, description: block.input?.description ?? null, prompt: block.input?.prompt ?? null,
        });
      } else if (block.type === 'tool_use') {
        out.push({ kind: 'tool', owner, name: block.name, tool_use_id: block.id, input: block.input });
      }
    }
    const u = msg.usage;
    if (msg.id && u) {
      // cache reads are re-billed context on every turn: leave them out of the "work done" count
      const tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
      this.#messageTokens.set(msg.id, { owner, tokens });
      out.push({ kind: 'usage', owner });
    }
    return out;
  }

  #user(obj) {
    const out = [];
    const content = obj.message?.content;
    if (!Array.isArray(content)) return out;
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      if (this.#subagents.has(block.tool_use_id)) {
        out.push({ kind: 'subagent_end', tool_use_id: block.tool_use_id, is_error: !!block.is_error, text: unwrapHandback(textOf(block.content)) });
      } else if (block.is_error) {
        out.push({ kind: 'tool_error', tool_use_id: block.tool_use_id, text: textOf(block.content).slice(0, 500) });
      }
    }
    return out;
  }
}
