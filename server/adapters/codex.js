import { readdirSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CODEX_EFFORTS, readCodexModels, resolveCodexSelection } from '../codex-models.js';

/** macii permission mode -> Codex sandbox. Plan additionally gets a read-only planning instruction. */
export const CODEX_MODES = { manual: 'read-only', plan: 'read-only', acceptEdits: 'workspace-write' };

const versionOf = name => name.split('_')[1]?.split('.').map(Number) ?? [];
const newer = (a, b) => { const x = versionOf(a), y = versionOf(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0); return 0; };

const isFile = path => { try { return statSync(path).isFile(); } catch { return false; } };
const directories = path => { try { return readdirSync(path, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; } };

// npm's Windows entry point is a .cmd shim, which cannot be spawned without a shell.
// Resolve the packaged native executable instead, so paths and prompts never enter cmd.exe.
function npmCodex(root, platform, arch) {
  const target = { 'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc', 'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl', 'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin' }[`${platform}-${arch}`];
  if (!target) return null;
  const exe = platform === 'win32' ? 'codex.exe' : 'codex';
  const scope = join(root, 'node_modules', '@openai');
  return [join(scope, 'codex', 'vendor'), join(scope, `codex-${platform}-${arch}`, 'vendor'), join(scope, 'codex', 'node_modules', '@openai', `codex-${platform}-${arch}`, 'vendor')]
    .map(p => join(p, target, 'codex', exe)).find(isFile) ?? null;
}
/**
 * Resolve the CLI on each launch: explicit override, PATH/npm, desktop runtime, then local/Store installs.
 * Do not cache a desktop path: updates replace its versioned installation directory.
 */
export function findCodex(env = process.env, { platform = process.platform, arch = process.arch } = {}) {
  if (env.AIOS_CODEX) {
    const path = resolve(env.AIOS_CODEX);
    if (!isFile(path)) throw new Error(`AIOS_CODEX points to ${path}, which does not exist or is not a file`);
    if (platform === 'win32' && /\.(cmd|bat|ps1|js)$/i.test(path)) {
      const native = npmCodex(dirname(path), platform, arch);
      if (native) return native;
      throw new Error('AIOS_CODEX must point to the native codex.exe, not a script or shell shim. Reinstall @openai/codex or select codex.exe from the desktop app.');
    }
    return path;
  }
  const exe = platform === 'win32' ? 'codex.exe' : 'codex';
  const pathValue = Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
  for (const entry of pathValue.split(platform === 'win32' ? ';' : delimiter).filter(Boolean)) {
    const dir = entry.replace(/^"|"$/g, '');
    if (!isAbsolute(dir)) continue;
    const p = join(dir, exe);
    if (isFile(p)) return p;
    const native = npmCodex(dir, platform, arch);
    if (native) return native;
  }
  if (env.CODEX_APP_RUNTIME_CLI_PATH && isFile(env.CODEX_APP_RUNTIME_CLI_PATH)) return env.CODEX_APP_RUNTIME_CLI_PATH;
  if (platform === 'win32') {
    if (env.LOCALAPPDATA) {
      const bins = join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
      const candidates = directories(bins).map(n => join(bins, n, exe)).filter(isFile).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      if (candidates.length) return candidates[0];
    }
    const apps = join(env.ProgramFiles ?? 'C:\\Program Files', 'WindowsApps');
    const names = directories(apps).filter(n => /^OpenAI\.Codex_/.test(n)).sort(newer);
    for (const n of names) {
      const p = join(apps, n, 'app', 'resources', 'codex.exe');
      if (isFile(p)) return p;
    }
  }
  throw new Error('Codex CLI not found. Install the Codex app or `npm i -g @openai/codex`, or set AIOS_CODEX to the codex executable.');
}

/** Preserve subscription login and proxy settings, but never inherit API billing credentials. */
export function codexEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'].includes(k.toUpperCase())));
}

const execFileAsync = promisify(execFile);
let modelCache = null;
export async function getCodexModels({ env = process.env, refresh = false } = {}) {
  const executable = findCodex(env);
  const key = JSON.stringify([executable, statSync(executable).mtimeMs, env.CODEX_HOME ?? '']);
  if (refresh || !modelCache || modelCache.key !== key || modelCache.until <= Date.now()) {
    const entry = { key, until: Date.now() + 60000, promise: readCodexModels({ executable, env: codexEnv(env) }) };
    modelCache = entry;
    entry.promise.catch(() => { if (modelCache === entry) modelCache = null; });
  }
  return modelCache.promise;
}
/** Local checks only: no prompt is sent and no login/configuration is changed. */
export async function inspectCodex({ env = process.env, execute = execFileAsync } = {}) {
  let executable;
  try {
    executable = findCodex(env);
    const options = { env: codexEnv(env), timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true };
    const [version, help, login] = await Promise.all([
      execute(executable, ['--version'], options),
      execute(executable, ['exec', '--help'], options),
      execute(executable, ['login', 'status'], options).catch(e => ({ stdout: e.stdout ?? '', stderr: e.stderr ?? '', failed: true, error: e })),
    ]);
    const capabilities = { fork: /^\s+fork\s/m.test(help.stdout), ignoreUserConfig: help.stdout.includes('--ignore-user-config') };
    const auth = `${login.stdout}\n${login.stderr}`;
    const authMode = /Logged in using ChatGPT/i.test(auth) ? 'chatgpt' : /API key|access token/i.test(auth) ? 'api' : 'unknown';
    const loginIssue = login.error?.killed ? 'Codex login check timed out. Run `codex login status` in a terminal.'
      : login.failed && !/not logged in|not signed in/i.test(auth) ? 'Codex could not check its saved login. Run `codex login status` in a terminal and check access to CODEX_HOME.'
      : 'Codex is not signed in. Run `codex login` and sign in with ChatGPT, using the same CODEX_HOME as the hub.';
    const issue = !capabilities.ignoreUserConfig ? 'This Codex CLI is too old for isolated runs. Update Codex or set AIOS_CODEX to a current executable.'
      : login.failed || authMode === 'unknown' ? loginIssue
      : authMode !== 'chatgpt' ? 'Codex is signed in with API credentials. Run `codex login` and choose ChatGPT to use your subscription.' : null;
    return { ok: !issue, executable, version: version.stdout.trim(), authMode, capabilities, error: issue };
  } catch (e) {
    return { ok: false, executable: executable ?? null, error: e.killed ? 'Codex CLI check timed out. Check the executable and try again.' : `Codex connection failed: ${e.message}` };
  }
}

export async function prepareCodex(options) {
  const connection = await inspectCodex({ env: options.env });
  if (!connection.ok) throw new Error(connection.error);
  const selection = resolveCodexSelection(options.agent, await getCodexModels({ env: options.env }));
  return { executable: connection.executable, args: buildCodexArgs({ ...options, agent: { ...options.agent, ...selection }, capabilities: connection.capabilities }), forked: !!(options.resumeSessionId && options.fork && connection.capabilities.fork), ...selection };
}

/**
 * Compatibility fallback for CLIs without `exec fork`: an edited message may already be saved in the resumed thread.
 */
export const WITHDRAWN_NOTE = '[macii] The user withdrew their previous message before you answered it. Ignore it completely; it was never sent. Their message now is:\n\n';

/** arguments for `codex exec` (or `exec resume`); the prompt goes in on stdin, so it is not limited by the Windows command line length */
export function buildCodexArgs({ agent, resumeSessionId, images = [], fork = false, capabilities = { fork: true } }) {
  const sandbox = CODEX_MODES[agent.mode ?? 'manual'];
  if (!sandbox) throw new Error(`permission mode "${agent.mode}" is not available for Codex agents`);
  const args = ['exec'];
  if (resumeSessionId) args.push(fork && capabilities.fork ? 'fork' : 'resume', resumeSessionId);
  // -s does not exist on `exec resume`, so everything goes through -c. The user's ~/.codex/config.toml is ignored on purpose: it loads the
  // desktop app's plugins and MCP servers (slow, and tools nobody gave this agent), asks for approvals nobody could answer in a headless
  // run, and its model made runs hang before the first answer. What is left of it that a run needs is set here.
  args.push('--json', '--skip-git-repo-check', '--ignore-user-config', '-c', `sandbox_mode=${JSON.stringify(sandbox)}`, '-c', 'approval_policy="never"', '-c', 'forced_login_method="chatgpt"');
  if (process.platform === 'win32') args.push('-c', 'windows.sandbox="elevated"'); // the sandbox the Codex app sets up; without it a run waits forever
  if (agent.model) args.push('-m', agent.model);
  if (agent.effort) {
    if (!CODEX_EFFORTS.includes(agent.effort)) throw new Error(`unknown Codex Intelligence "${agent.effort}"`);
    args.push('-c', `model_reasoning_effort=${JSON.stringify(agent.effort)}`);
  }
  for (const file of images) args.push('--image', file); // one flag per file: the option is variadic and would swallow the arguments after it
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
  #thread;
  #model;
  #lastText = '';
  #tools = new Set();

  constructor(sessionId = null, model = null) { this.#thread = sessionId; this.#model = model; }

  push(obj) {
    switch (obj.type) {
      case 'thread.started':
        this.#thread = obj.thread_id;
        return [{ kind: 'init', session_id: obj.thread_id, model: this.#model, tools: [], mcp_servers: [] }];
      case 'turn.started': this.#lastText = ''; return [];
      case 'item.started': return this.#started(obj.item ?? {});
      case 'item.updated': return this.#started(obj.item ?? {});
      case 'item.completed': return this.#completed(obj.item ?? {});
      case 'turn.completed': {
        const u = obj.usage ?? {};
        // cache reads are re-billed context on every turn: leave them out, like the Claude count
        this.#tokens += Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0)) + (u.output_tokens ?? 0);
        return [{ kind: 'usage', owner: 'main' }, { kind: 'result', is_error: false, subtype: 'success', text: this.#lastText, session_id: this.#thread, turns: 1, usage: u }];
      }
      case 'turn.failed':
        return [{ kind: 'result', is_error: true, subtype: 'turn.failed', text: errorText(obj.error, 'Codex turn failed'), session_id: this.#thread, turns: 1 }];
      // A reconnect warning can be followed by success. Preserve it for a failed exit without ending a live turn.
      case 'error': return [{ kind: 'error', text: errorText(obj, 'Codex connection failed') }];
      default: return [{ kind: 'unknown', type: obj.type, message: obj.message }];
    }
  }

  tokenTotals() { return new Map([['main', this.#tokens]]); }

  #started(item) {
    let events;
    switch (item.type) {
      case 'command_execution': events = [{ kind: 'tool', owner: 'main', name: 'Bash', tool_use_id: item.id, input: { command: item.command } }]; break;
      case 'file_change': events = (item.changes ?? []).map(c => ({ kind: 'tool', owner: 'main', name: FILE_TOOL[c.kind] ?? 'Edit', tool_use_id: item.id, input: { file_path: c.path } })); break;
      case 'mcp_tool_call': events = [{ kind: 'tool', owner: 'main', name: `${item.server}.${item.tool}`, tool_use_id: item.id, input: item.arguments ?? {} }]; break;
      case 'web_search': events = [{ kind: 'tool', owner: 'main', name: 'WebSearch', tool_use_id: item.id, input: { query: item.query } }]; break;
      default: events = [];
    }
    return events.filter(ev => {
      const key = `${item.id}:${ev.name}:${ev.input.file_path ?? ''}`;
      if (this.#tools.has(key)) return false;
      this.#tools.add(key); return true;
    });
  }

  #completed(item) {
    switch (item.type) {
      case 'agent_message':
        if (!item.text) return [];
        this.#lastText = item.text;
        return [{ kind: 'text', owner: 'main', text: item.text }];
      case 'command_execution':
        return [...this.#started(item), ...(item.exit_code || item.status === 'failed' ? [{ kind: 'tool_error', tool_use_id: item.id, text: `exit ${item.exit_code ?? 'unknown'}: ${String(item.aggregated_output ?? '').slice(0, 400)}` }] : [])];
      case 'error': return [{ kind: 'tool_error', tool_use_id: item.id, text: String(item.message ?? 'error').slice(0, 500) }];
      case 'file_change': case 'mcp_tool_call':
        return [...this.#started(item), ...(item.status === 'failed' || item.error ? [{ kind: 'tool_error', tool_use_id: item.id, text: errorText(item.error, `${item.type} failed`) }] : [])];
      case 'web_search': return this.#started(item);
      case 'reasoning': case 'todo_list': return [];
      default: return [{ kind: 'unknown', type: `item.${item.type}` }];
    }
  }
}

const errorText = (error, fallback) => typeof error === 'string' ? error : error?.message ?? error?.error?.message ?? fallback;
