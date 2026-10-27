// Claude accounts: each one is its own CLAUDE_CONFIG_DIR, so it has its own login, sessions and rate limits.
// "default" is the CLI's own login (~/.claude, or whatever CLAUDE_CONFIG_DIR the hub was started with); it needs no folder of ours.
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { codexEnv } from './adapters/codex.js';
import { slug } from './util.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_ACCOUNT = 'default';
/** key of an account's usage windows in the limits table; the default account keeps the old key "claude" */
export const limitKeyFor = account => (!account || account === DEFAULT_ACCOUNT ? 'claude' : `claude:${account}`);

const fail = (code, message) => Object.assign(new Error(message), { code }); // NOT_FOUND | BAD | CONFLICT | BUSY

export function createAccounts({ store, dataDir, execute = execFileAsync }) {
  const root = resolve(dataDir, 'accounts');

  function read() {
    const s = store.getSetting('accounts') ?? {};
    const list = Array.isArray(s.list) ? s.list : [];
    const builtin = list.find(a => a.id === DEFAULT_ACCOUNT) ?? { id: DEFAULT_ACCOUNT, name: 'Default' };
    const all = [builtin, ...list.filter(a => a.id !== DEFAULT_ACCOUNT)];
    return { list: all, default: all.some(a => a.id === s.default) ? s.default : DEFAULT_ACCOUNT };
  }
  const write = s => store.setSetting('accounts', s);
  const dir = id => (id === DEFAULT_ACCOUNT ? null : join(root, id));
  const find = id => read().list.find(a => a.id === id);
  const named = name => {
    const n = typeof name === 'string' ? name.trim() : '';
    if (!n || n.length > 40) throw fail('BAD', 'name is required (max 40 characters)');
    return n;
  };

  return {
    view() {
      const s = read();
      return { default: s.default, list: s.list.map(a => ({ ...a, builtin: a.id === DEFAULT_ACCOUNT, dir: dir(a.id) })) };
    },
    dir: id => (id && find(id) ? dir(id) : null),
    /** account a run of this agent uses: its own choice, else the default account. Only Claude agents have one. */
    resolve(agent) {
      if (agent.type !== 'claude') return null;
      if (!agent.account) return read().default;
      if (!find(agent.account)) throw new Error(`account "${agent.account}" of agent "${agent.name}" no longer exists; choose another one in the agent's settings`);
      return agent.account;
    },
    has: id => !!find(id),
    add(name) {
      const n = named(name), id = slug(n);
      if (!id) throw fail('BAD', 'name must contain letters or digits');
      const s = read();
      if (s.list.some(a => a.id === id)) throw fail('CONFLICT', `an account with id "${id}" already exists`);
      mkdirSync(dir(id), { recursive: true });
      write({ ...s, list: [...s.list, { id, name: n }] });
      return id;
    },
    rename(id, name) {
      const n = named(name), s = read();
      if (!s.list.some(a => a.id === id)) throw fail('NOT_FOUND', 'account not found');
      write({ ...s, list: s.list.map(a => (a.id === id ? { ...a, name: n } : a)) });
    },
    setDefault(id) {
      const s = read();
      if (!s.list.some(a => a.id === id)) throw fail('NOT_FOUND', 'account not found');
      write({ ...s, default: id });
    },
    /** forgets the account; its folder (login, sessions) stays on disk */
    remove(id) {
      const s = read();
      if (id === DEFAULT_ACCOUNT) throw fail('BAD', 'the default login of the CLI cannot be removed');
      if (!s.list.some(a => a.id === id)) throw fail('NOT_FOUND', 'account not found');
      if (s.default === id) throw fail('BUSY', 'this is the default account; make another one the default first');
      const users = store.listAgents().filter(a => a.account === id).map(a => a.name);
      if (users.length) throw fail('BUSY', `used by ${users.join(', ')}; switch these agents to another account first`);
      write({ ...s, list: s.list.filter(a => a.id !== id) });
      return dir(id);
    },
    /** environment of a `claude` process of this account (no API keys, so the run stays on the subscription) */
    env(id) {
      const d = this.dir(id);
      return d ? { ...codexEnv(), CLAUDE_CONFIG_DIR: d } : codexEnv();
    },
    /** who is logged in, from `claude auth status` of that account */
    async status(id) {
      if (!find(id)) throw fail('NOT_FOUND', 'account not found');
      let out;
      try {
        out = (await execute('claude', ['auth', 'status'], { env: this.env(id), timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 })).stdout;
      } catch (e) {
        out = e.stdout; // a logged-out CLI may exit non-zero and still print its status
        if (!out) return { error: `could not run claude: ${e.message}` };
      }
      let s;
      try { s = JSON.parse(out); } catch { return { error: `unexpected output from \`claude auth status\`: ${String(out).slice(0, 200)}` }; }
      return { logged_in: s.loggedIn === true, email: s.email ?? null, subscription: s.subscriptionType ?? null, method: s.authMethod ?? null };
    },
  };
}
