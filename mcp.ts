// Model Context Protocol at /mcp: JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28
// (server/discover, no handshake, no session) with the legacy initialize handshake as a
// fallback. Six tools act on the same store as REST: create_repo, get_repo, create_issue,
// list_issues, create_pull_request and merge_pull_request. Unknown tools answer -32602,
// missing arguments answer isError:true, a non-JSON body is HTTP 400 with -32700, and a
// call with no Authorization header is 401.

import type { Forge } from './store.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const REVISION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

type JsonRpcId = string | number | null;

interface RpcError {
  code: number;
  message: string;
}

function okResult(id: JsonRpcId, result: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`;
}

function errorResult(id: JsonRpcId, error: RpcError): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, error })}\n`;
}

function toolResult(value: unknown, isError = false): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const result: Record<string, unknown> = {
    content: [{ type: 'text', text }],
  };
  if (typeof value === 'object' && value !== null) result.structuredContent = value;
  if (isError) result.isError = true;
  return result;
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findTool(name: string): ToolDef | undefined {
  const wanted = normalizeName(name);
  for (const tool of TOOLS) {
    if (normalizeName(tool.name) === wanted) return tool;
  }
  for (const tool of TOOLS) {
    const normalized = normalizeName(tool.name);
    if (wanted.length > normalized.length && wanted.endsWith(normalized)) return tool;
  }
  return undefined;
}

function repoObject(forge: Forge, repo: { id: number; name: string; owner: string; description: string; private: boolean; defaultBranch: string }): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: repo.owner,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

/** Run one tool against the store; returns its result object or an error message. */
function callTool(forge: Forge, name: string, args: Record<string, unknown>): { result: Record<string, unknown> } | { error: string } {
  const tool = findTool(name);
  if (!tool) return { error: `unknown tool ${name}` };
  const missing = tool.inputSchema.required.filter((field) => args[field] === undefined || args[field] === null || args[field] === '');
  if (missing.length > 0) {
    return { result: toolResult(`Missing required argument(s): ${missing.join(', ')}`, true) };
  }
  switch (tool.name) {
    case 'create_repo': {
      const created = forge.createRepo(String(args.name), {
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      if ('error' in created) return { result: toolResult(`Failed to create repository: ${created.error}`, true) };
      return { result: toolResult(repoObject(forge, created)) };
    }
    case 'get_repo': {
      const owner = String(args.owner);
      const repoName = String(args.repo);
      if (owner !== forge.viewerLogin) return { result: toolResult(`Repository ${owner}/${repoName} not found`, true) };
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return { result: toolResult(`Repository ${owner}/${repoName} not found`, true) };
      return { result: toolResult(repoObject(forge, repo)) };
    }
    case 'create_issue': {
      const owner = String(args.owner);
      const repoName = String(args.repo);
      if (owner !== forge.viewerLogin) return { result: toolResult(`Repository ${owner}/${repoName} not found`, true) };
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return { result: toolResult(`Repository ${owner}/${repoName} not found`, true) };
      const issue = forge.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      return {
        result: toolResult({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: [],
        }),
      };
    }
    case 'list_issues': {
      const owner = String(args.owner);
      const repoName = String(args.repo);
      if (owner !== forge.viewerLogin) return { result: toolResult(`Repository ${owner}/${repoName} not found`, true) };
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return { result: toolResult(`Repository ${owner}/${repoName} not found`, true) };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .map((issue) => ({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
        }));
      return { result: toolResult({ issues }) };
    }
    case 'create_pull_request': {
      const owner = String(args.owner);
      const repoName = String(args.repo);
      if (owner !== forge.viewerLogin) return { result: toolResult(`Repository ${owner}/${repoName} not found`, true) };
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return { result: toolResult(`Repository ${owner}/${repoName} not found`, true) };
      const created = forge.createPull(
        repo,
        String(args.title),
        typeof args.body === 'string' ? args.body : '',
        String(args.head),
        String(args.base),
      );
      if ('error' in created) return { result: toolResult(`Failed to create pull request: ${created.error}`, true) };
      return {
        result: toolResult({
          id: created.id,
          number: created.number,
          title: created.title,
          body: created.body,
          state: created.state,
          head: created.headRef,
          base: created.baseRef,
          merged: created.merged,
        }),
      };
    }
    case 'merge_pull_request': {
      const owner = String(args.owner);
      const repoName = String(args.repo);
      if (owner !== forge.viewerLogin) return { result: toolResult(`Repository ${owner}/${repoName} not found`, true) };
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return { result: toolResult(`Repository ${owner}/${repoName} not found`, true) };
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (!pull) return { result: toolResult(`Pull request #${number} not found`, true) };
      const merged = forge.mergePull(repo, pull);
      if ('error' in merged) return { result: toolResult(`Failed to merge pull request: ${merged.error}`, true) };
      return {
        result: toolResult({
          number: pull.number,
          merged: true,
          state: pull.state,
          sha: merged.sha,
        }),
      };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

/**
 * Handle one POST /mcp request. Returns null when the path is not the MCP endpoint.
 * A notification (no id) is answered 202 with an empty body.
 */
export function handleMcp(
  forge: Forge,
  ctx: { pathname: string; method: string; body: Buffer },
  authorized: boolean,
): { status: number; headers?: Record<string, string>; body: string } | null {
  if (ctx.pathname !== '/mcp') return null;
  if (ctx.method === 'DELETE') return { status: 204, body: '' };
  if (ctx.method !== 'POST') return { status: 405, body: `${JSON.stringify({ message: 'Method Not Allowed' })}\n` };
  if (!authorized) {
    return { status: 401, body: `${JSON.stringify({ message: 'Requires authentication' })}\n` };
  }
  let request: unknown;
  try {
    request = JSON.parse(ctx.body.toString('utf8')) as unknown;
  } catch {
    return {
      status: 400,
      body: errorResult(null, { code: -32700, message: 'Parse error' }),
    };
  }
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return { status: 400, body: errorResult(null, { code: -32600, message: 'Invalid Request' }) };
  }
  const record = request as Record<string, unknown>;
  const id = (typeof record.id === 'string' || typeof record.id === 'number' ? record.id : null) as JsonRpcId;
  const method = typeof record.method === 'string' ? record.method : '';
  const params = (record.params ?? {}) as Record<string, unknown>;

  // A notification carries no id: acknowledge it and answer nothing.
  if (record.id === undefined) {
    return { status: 202, body: '' };
  }

  switch (method) {
    case 'server/discover': {
      return {
        status: 200,
        body: okResult(id, {
          supportedVersions: [REVISION],
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          capabilities: { tools: {} },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
        }),
      };
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : REVISION;
      return {
        status: 200,
        body: okResult(id, {
          protocolVersion: requested,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
      };
    }
    case 'tools/list': {
      return { status: 200, body: okResult(id, { tools: TOOLS }) };
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const outcome = callTool(forge, toolName, args);
      if ('error' in outcome) {
        return { status: 200, body: errorResult(id, { code: -32602, message: outcome.error }) };
      }
      return { status: 200, body: okResult(id, outcome.result) };
    }
    case 'ping': {
      return { status: 200, body: okResult(id, {}) };
    }
    default: {
      return { status: 200, body: errorResult(id, { code: -32601, message: `Method not found: ${method}` }) };
    }
  }
}
