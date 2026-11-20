// Streamable-HTTP MCP surface: modern server/discover plus the six GitHub tools.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { asRecord, readBody, sendJson } from './http.ts';
import {
  createIssueRecord,
  createPullRecord,
  createRepo,
  globalId,
  issueObject,
  mergePullRecord,
  pullObject,
  repoKey,
  repoObject,
  VIEWER,
  type ForgeState,
} from './state.ts';

const SERVER_INFO = { name: 'makefun-github-forge', version: '1.0.0' } as const;
const SUPPORTED_VERSIONS = ['2026-07-28'] as const;

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['owner', 'name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title', 'body'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch.' },
        base: { type: 'string', description: 'Base branch.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'number', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

type JsonRpcId = string | number | null;

export async function handleMcp(state: ForgeState, req: IncomingMessage, res: ServerResponse, headers: Record<string, string>): Promise<void> {
  if (req.method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' }, headers);
    return;
  }
  if (!hasBearer(req)) {
    sendJson(res, 401, { message: 'Requires authentication' }, headers);
    return;
  }
  const raw = await readBody(req, 8 * 1024 * 1024);
  let message: Record<string, unknown> | null;
  let parseId: JsonRpcId = null;
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    message = asRecord(parsed);
    if (message !== null && (typeof message.id === 'string' || typeof message.id === 'number')) parseId = message.id;
  } catch {
    const match = /"id"\s*:\s*("[^"]+"|-?\d+)/.exec(raw.toString('utf8'));
    if (match?.[1] !== undefined) {
      parseId = match[1].startsWith('"') ? match[1].slice(1, -1) : Number(match[1]);
    }
    sendJson(res, 400, rpcError(parseId, -32700, 'Parse error'), headers);
    return;
  }
  if (message === null) {
    sendJson(res, 400, rpcError(parseId, -32600, 'Invalid Request'), headers);
    return;
  }
  const id = (typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null) as JsonRpcId;
  const method = typeof message.method === 'string' ? message.method : '';
  if (method === 'notifications/initialized') {
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end('{}');
    return;
  }
  const params = asRecord(message.params) ?? {};
  let result: Record<string, unknown> | null = null;
  let error: Record<string, unknown> | null = null;

  switch (method) {
    case 'server/discover':
      result = {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...SERVER_INFO },
      };
      break;
    case 'initialize':
      result = {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...SERVER_INFO },
      };
      break;
    case 'tools/list':
      result = { tools: TOOLS };
      break;
    case 'tools/call':
      try {
        result = callTool(state, params);
      } catch (err) {
        error = {
          code: err instanceof ToolError ? -32602 : -32601,
          message: err instanceof Error ? err.message : 'Tool call failed',
        };
      }
      break;
    default:
      error = { code: -32601, message: 'Method not found' };
  }
  const response: Record<string, unknown> = { jsonrpc: '2.0', id };
  if (error !== null) response.error = error;
  else response.result = result ?? {};
  sendJson(res, 200, response, headers);
}

function hasBearer(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && /^Bearer\s+\S+/i.test(header.trim());
}

function rpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

class ToolError extends Error {}

function callTool(state: ForgeState, params: Record<string, unknown>): Record<string, unknown> {
  const name = typeof params.name === 'string' ? params.name : '';
  const args = asRecord(params.arguments) ?? {};
  const canonical = canonicalTool(name);
  if (canonical === null) throw new ToolError(`Unknown tool: ${name}`);
  let payload: Record<string, unknown>;
  switch (canonical) {
    case 'create_repo':
      payload = toolCreateRepo(state, args);
      break;
    case 'get_repo':
      payload = repoObject(toolRepo(state, args));
      break;
    case 'create_issue':
      payload = toolCreateIssue(state, args);
      break;
    case 'list_issues':
      payload = toolListIssues(state, args);
      break;
    case 'create_pull_request':
      payload = toolCreatePull(state, args);
      break;
    case 'merge_pull_request':
      payload = toolMergePull(state, args);
      break;
    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}

function canonicalTool(name: string): string | null {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const entries: ReadonlyArray<[string, readonly string[]]> = [
    ['create_repo', ['createrepo', 'createrepository', 'repocreate', 'reposcreate', 'repositorycreate']],
    ['get_repo', ['getrepo', 'getrepository', 'repoget', 'reposget', 'repositoryget']],
    ['create_issue', ['createissue', 'issuecreate', 'issuescreate']],
    ['list_issues', ['listissues', 'issueslist', 'issuelist']],
    ['create_pull_request', ['createpullrequest', 'pullrequestcreate', 'pullscreate', 'createpr', 'prcreate']],
    ['merge_pull_request', ['mergepullrequest', 'pullrequestmerge', 'pullsmerge', 'mergepr', 'prmerge']],
  ];
  for (const [canonical, aliases] of entries) {
    if (aliases.some((alias) => normalized === alias || normalized.endsWith(alias))) return canonical;
  }
  return null;
}

function required(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') throw new ToolError(`Missing required argument: ${key}`);
  return value;
}

function toolRepo(state: ForgeState, args: Record<string, unknown>) {
  const owner = required(args, 'owner');
  const name = required(args, 'repo');
  const repo = state.repos.get(repoKey(owner, name));
  if (repo === undefined) throw new ToolError(`Repository not found: ${owner}/${name}`);
  return repo;
}

function toolCreateRepo(state: ForgeState, args: Record<string, unknown>): Record<string, unknown> {
  const name = required(args, 'name');
  required(args, 'owner');
  const existing = state.repos.get(repoKey(VIEWER.login, name));
  if (existing !== undefined) return repoObject(existing);
  const description = typeof args.description === 'string' ? args.description : '';
  const repo = createRepo(state, VIEWER.login, name, description, args.private === true);
  return repoObject(repo);
}

function toolCreateIssue(state: ForgeState, args: Record<string, unknown>): Record<string, unknown> {
  const repo = toolRepo(state, args);
  const title = required(args, 'title');
  const body = required(args, 'body');
  const issue = createIssueRecord(repo, title, body, []);
  return issueObject(repo, issue);
}

function toolListIssues(state: ForgeState, args: Record<string, unknown>): Record<string, unknown> {
  const repo = toolRepo(state, args);
  const stateFilter = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
  const issues = repo.issues
    .filter((issue) => stateFilter === 'all' || issue.state === stateFilter)
    .map((issue) => issueObject(repo, issue));
  return { issues, total_count: issues.length };
}

function toolCreatePull(state: ForgeState, args: Record<string, unknown>): Record<string, unknown> {
  const repo = toolRepo(state, args);
  const title = required(args, 'title');
  const head = required(args, 'head');
  const base = required(args, 'base');
  const body = typeof args.body === 'string' ? args.body : '';
  const pull = createPullRecord(repo, title, body, head, base);
  if (pull === null) throw new ToolError('head or base ref not found');
  return pullObject(repo, pull);
}

function toolMergePull(state: ForgeState, args: Record<string, unknown>): Record<string, unknown> {
  const repo = toolRepo(state, args);
  const number = Number(args.pull_number);
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (pull === undefined) throw new ToolError('Pull request not found');
  const sha = mergePullRecord(repo, pull);
  if (sha === null) throw new ToolError('Merge conflict');
  return { number: pull.number, merged: true, state: 'closed', sha, id: globalId('pull', repo, pull.number) };
}
