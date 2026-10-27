// MCP server (stdio) that gives an agent the tool `inbox_send`. Started by `claude` via --mcp-config.
// It does no work itself: it forwards to the hub, which owns the inbox.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const { AIOS_HUB_URL, AIOS_HUB_TOKEN, AIOS_RUN_ID } = process.env;
for (const [k, v] of Object.entries({ AIOS_HUB_URL, AIOS_HUB_TOKEN, AIOS_RUN_ID })) {
  if (!v) { console.error(`inbox-server: missing env ${k}`); process.exit(1); }
}

const server = new McpServer({ name: 'aios', version: '0.1.0' });

server.registerTool('inbox_send', {
  description: 'Send a message to the user\'s macii inbox. Use type "result" when done, "question" when you need a decision, "approval" before an action you may not perform, "warning" for non-fatal problems. After a question or approval, stop.',
  inputSchema: {
    type: z.enum(['result', 'question', 'approval', 'warning']),
    title: z.string().min(1).max(120).describe('One line'),
    body: z.string().min(1).describe('Details; Markdown allowed'),
    options: z.array(z.string().min(1).max(60)).max(4).optional().describe('Short answer choices for a question'),
    permissions: z.array(z.string().min(1).max(200)).max(5).optional().describe('Required for type approval: narrowest tool permission patterns the action needs, e.g. "Write" or "Bash(npm install zod)"'),
  },
}, async args => {
  const res = await fetch(`${AIOS_HUB_URL}/api/inbox`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aios-token': AIOS_HUB_TOKEN },
    body: JSON.stringify({ ...args, run_id: Number(AIOS_RUN_ID) }),
  });
  const text = await res.text();
  if (!res.ok) return { isError: true, content: [{ type: 'text', text: `macii hub rejected the message (${res.status}): ${text}` }] };
  return { content: [{ type: 'text', text: `Delivered to inbox (${args.type}).` }] };
});

await server.connect(new StdioServerTransport());
