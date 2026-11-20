// A compact GitHub-compatible forge: REST v3, Git smart HTTP, GraphQL v4 and MCP on one server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { asRecord, absoluteUrl, JsonParseError, JSON_TYPE, pathOf, queryOf, readBody, readJson, sendBuffer, sendJson, splitSegments } from './http.ts';
import { handleGit } from './git-http.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { hashObject } from './git.ts';
import {
  commitFiles,
  createRepo,
  createState,
  diffPaths,
  fileContentsOfRepo,
  issueObject,
  nextRequestId,
  pullObject,
  repoKey,
  repoObject,
  resolveCommit,
  squashFiles,
  STRANGER,
  VIEWER,
  type Repo,
} from './state.ts';

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const state = createState();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void dispatch(state, req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof JsonParseError) {
        sendJson(res, 400, { message: err.message }, responseHeaders(state));
        return;
      }
      sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' }, responseHeaders(state));
    });
  });
}

function responseHeaders(state: ForgeStateLike): Record<string, string> {
  return { 'x-github-request-id': nextRequestId(state) };
}

interface ForgeStateLike {
  requestSeq: number;
}

async function dispatch(state: ReturnType<typeof createState>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';
  const headers = responseHeaders(state);

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true }, headers);
    return;
  }

  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { ...headers, 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(res, 200, { installed_version: '1.0.0', sha: 'forge', connect_to_api: false }, headers);
    return;
  }

  if (path === '/api/graphql') {
    await handleGraphQL(state, req, res, headers);
    return;
  }
  if (path === '/mcp' || path.startsWith('/mcp/')) {
    await handleMcp(state, req, res, headers);
    return;
  }

  if (path.endsWith('/info/refs') || path.endsWith('/git-upload-pack') || path.endsWith('/git-receive-pack')) {
    await handleGit(state, req, res, path, method);
    return;
  }

  if (!path.startsWith('/api/v3/')) {
    sendJson(res, 404, { message: 'Not Found' }, headers);
    return;
  }

  const token = bearerToken(req);
  if (token === null) {
    sendJson(res, 401, { message: 'Requires authentication' }, headers);
    return;
  }

  const segments = splitSegments(path.slice('/api/v3/'.length));
  if (segments[0] === 'user' && segments[1] === 'repos') {
    await handleUserRepos(state, req, res, segments, method, headers);
    return;
  }
  if (segments[0] === 'user' && segments[1] === undefined && method === 'GET') {
    sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, type: 'User' }, headers);
    return;
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    await handleRepoRoutes(state, req, res, segments, method, headers);
    return;
  }
  sendJson(res, 404, { message: 'Not Found' }, headers);
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

async function handleUserRepos(
  state: ReturnType<typeof createState>,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  method: string,
  headers: Record<string, string>,
): Promise<void> {
  if (method === 'POST' && segments.length === 2) {
    const body = asRecord(await readJson(req));
    if (body === null || typeof body.name !== 'string' || body.name === '') {
      sendJson(res, 422, { message: 'Validation Failed: name is required' }, headers);
      return;
    }
    const name = body.name;
    if (state.repos.has(repoKey(VIEWER.login, name))) {
      sendJson(res, 422, { message: 'Validation Failed: name already exists' }, headers);
      return;
    }
    const repo = createRepo(state, VIEWER.login, name, typeof body.description === 'string' ? body.description : '', body.private === true);
    sendJson(res, 201, repoObject(repo), headers);
    return;
  }
  if (method === 'GET' && segments.length === 2) {
    const query = queryOf(req);
    const perPage = Math.max(1, Math.min(100, Number(query.get('per_page')) || 30));
    const page = Math.max(1, Number(query.get('page')) || 1);
    const all = [...state.repos.values()].filter((repo) => repo.owner === VIEWER.login);
    const start = (page - 1) * perPage;
    const items = all.slice(start, start + perPage).map(repoObject);
    const more = start + perPage < all.length;
    if (more) {
      const next = `/api/v3/user/repos?page=${page + 1}&per_page=${perPage}`;
      headers.link = `<${absoluteUrl(req, next)}>; rel="next"`;
    }
    sendJson(res, 200, items, headers);
    return;
  }
  sendJson(res, 404, { message: 'Not Found' }, headers);
}

async function handleRepoRoutes(
  state: ReturnType<typeof createState>,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  method: string,
  headers: Record<string, string>,
): Promise<void> {
  const owner = segments[1] ?? '';
  const name = segments[2] ?? '';
  if (owner !== VIEWER.login && owner !== STRANGER.login) {
    sendJson(res, 404, { message: 'Not Found' }, headers);
    return;
  }
  const repo = state.repos.get(repoKey(owner, name));
  if (repo === undefined || repo.owner !== VIEWER.login) {
    sendJson(res, 404, { message: 'Not Found' }, headers);
    return;
  }
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoObject(repo), headers);
      return;
    }
    if (method === 'PATCH') {
      const body = asRecord(await readJson(req));
      if (body === null || typeof body.description !== 'string') {
        sendJson(res, 422, { message: 'Validation Failed: description is required' }, headers);
        return;
      }
      repo.description = body.description;
      sendJson(res, 200, repoObject(repo), headers);
      return;
    }
    if (method === 'DELETE') {
      state.repos.delete(repoKey(owner, name));
      sendJson(res, 204, undefined, headers);
      return;
    }
  }

  if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2 && method === 'POST') {
    const body = asRecord(await readJson(req));
    const ref = typeof body?.ref === 'string' ? body.ref : '';
    const sha = typeof body?.sha === 'string' ? body.sha : '';
    if (!/^refs\/heads\/.+$/.test(ref) || !/^[0-9a-f]{40}$/i.test(sha)) {
      sendJson(res, 422, { message: 'Validation Failed: ref and sha are required' }, headers);
      return;
    }
    if (repo.objects.get(sha.toLowerCase()) === undefined) {
      sendJson(res, 422, { message: 'Validation Failed: sha does not exist' }, headers);
      return;
    }
    repo.refs.set(ref, sha.toLowerCase());
    sendJson(res, 201, { ref, object: { sha: sha.toLowerCase(), type: 'commit' } }, headers);
    return;
  }

  if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref, oid]) => ref.startsWith('refs/heads/') && /^[0-9a-f]{40}$/.test(oid))
      .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }));
    sendJson(res, 200, branches, headers);
    return;
  }

  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const query = queryOf(req);
    const tip = resolveCommit(repo, query.get('sha') ?? undefined);
    if (tip === null) {
      sendJson(res, 404, { message: 'Not Found' }, headers);
      return;
    }
    const commits: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift();
      if (oid === undefined || seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      seen.add(oid);
      const raw = object.data.toString('utf8');
      const message = raw.slice(raw.indexOf('\n\n') + 2).trim();
      commits.push({
        sha: oid,
        commit: { message, author: { name: 'forge', email: 'forge@local' }, committer: { name: 'forge', email: 'forge@local' } },
        parents: [...raw.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((match) => ({ sha: match[1] })),
        html_url: `https://github.com/${owner}/${name}/commit/${oid}`,
      });
      for (const match of raw.matchAll(/^parent ([0-9a-f]{40})$/gm)) if (match[1] !== undefined) queue.push(match[1]);
    }
    sendJson(res, 200, commits, headers);
    return;
  }

  if (rest[0] === 'contents' && rest.length >= 2) {
    await handleContents(state, req, res, repo, rest.slice(1), method, headers);
    return;
  }
  if (rest[0] === 'labels' && rest.length === 1 && method === 'POST') {
    const body = asRecord(await readJson(req));
    if (body === null || typeof body.name !== 'string' || body.name === '') {
      sendJson(res, 422, { message: 'Validation Failed: label name is required' }, headers);
      return;
    }
    repo.labels.add(body.name);
    sendJson(res, 201, { name: body.name, color: typeof body.color === 'string' ? body.color : 'ededed' }, headers);
    return;
  }
  if (rest[0] === 'issues') {
    await handleIssues(state, req, res, repo, rest.slice(1), method, headers);
    return;
  }
  if (rest[0] === 'pulls') {
    await handlePulls(state, req, res, repo, rest.slice(1), method, headers);
    return;
  }
  sendJson(res, 404, { message: 'Not Found' }, headers);
}

async function handleContents(
  state: ReturnType<typeof createState>,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  parts: string[],
  method: string,
  headers: Record<string, string>,
): Promise<void> {
  void state;
  const path = parts.join('/');
  const query = queryOf(req);
  if (method === 'GET') {
    const tip = resolveCommit(repo, query.get('ref') ?? undefined);
    if (tip === null || repo.objects.get(tip) === undefined) {
      sendJson(res, 404, { message: 'Not Found' }, headers);
      return;
    }
    const files = fileContentsOfRepo(repo, tip);
    if (files.has(path)) {
      const data = files.get(path)!;
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: path.slice(path.lastIndexOf('/') + 1),
        path,
        sha: hashObject('blob', data),
        content: data.toString('base64'),
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      }, headers);
      return;
    }
    const prefix = `${path}/`;
    const children = [...files.keys()].filter((candidate) => candidate.startsWith(prefix));
    if (children.length > 0) {
      const entries: Array<Record<string, unknown>> = [];
      const dirs = new Set<string>();
      for (const candidate of children) {
        const rest = candidate.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash >= 0) dirs.add(rest.slice(0, slash));
        else {
          const data = files.get(candidate)!;
          entries.push({ type: 'file', name: rest, path: candidate, sha: hashObject('blob', data), size: data.length });
        }
      }
      for (const dir of dirs) {
        const childPath = `${path}/${dir}`;
        entries.push({ type: 'dir', name: dir, path: childPath, sha: hashObject('tree', Buffer.from(`tree:${childPath}`)), size: 0 });
      }
      entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      sendJson(res, 200, entries, headers);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' }, headers);
    return;
  }

  if (method === 'PUT' || method === 'DELETE') {
    const body = asRecord(await readJson(req));
    if (body === null || typeof body.message !== 'string' || body.message === '') {
      sendJson(res, 400, { message: 'Invalid JSON body' }, headers);
      return;
    }
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const tip = resolveCommit(repo, branch) ?? (repo.refs.get(`refs/heads/${branch}`) ?? undefined);
    const files = tip === undefined || tip === null ? new Map() : fileContentsOfRepo(repo, tip);
    const current = files.get(path);
    if (typeof body.sha === 'string' && (current === undefined || hashObject('blob', current) !== body.sha)) {
      sendJson(res, 409, { message: 'Conflict: sha does not match the current file' }, headers);
      return;
    }
    let data: Buffer | null = null;
    if (method === 'PUT') {
      if (typeof body.content !== 'string') {
        sendJson(res, 422, { message: 'Validation Failed: content is required' }, headers);
        return;
      }
      data = Buffer.from(body.content.replace(/[\r\n\t ]+/g, ''), 'base64');
    }
    const changes = new Map<string, string | null>([[path, data === null ? null : data.toString('utf8')]]);
    const sha = commitFiles(repo, branch, changes, body.message);
    const tipAfter = repo.refs.get(`refs/heads/${branch}`) ?? sha;
    const newData = fileContentsOfRepo(repo, tipAfter).get(path);
    sendJson(res, method === 'PUT' && current === undefined ? 201 : 200, {
      content: {
        name: path.slice(path.lastIndexOf('/') + 1),
        path,
        sha: newData === undefined ? null : hashObject('blob', newData),
        encoding: 'base64',
        content: newData === undefined ? null : newData.toString('base64'),
      },
      commit: { sha, message: body.message },
    }, headers);
    return;
  }
  sendJson(res, 404, { message: 'Not Found' }, headers);
}

async function handleIssues(
  state: ReturnType<typeof createState>,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  parts: string[],
  method: string,
  headers: Record<string, string>,
): Promise<void> {
  void state;
  if (parts.length === 0 && method === 'POST') {
    const body = asRecord(await readJson(req));
    if (body === null || typeof body.title !== 'string' || typeof body.body !== 'string') {
      sendJson(res, 422, { message: 'Validation Failed: title and body are required' }, headers);
      return;
    }
    const labels = Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
    const unknown = labels.find((label) => !repo.labels.has(label));
    if (unknown !== undefined) {
      sendJson(res, 422, { message: `Validation Failed: label ${unknown} does not exist` }, headers);
      return;
    }
    repo.issueSeq += 1;
    const issue = {
      number: repo.issueSeq,
      title: body.title,
      body: body.body,
      state: 'open' as const,
      labels,
      createdAt: '2026-11-20T00:00:00Z',
      comments: [] as Repo['issues'][number]['comments'],
    };
    repo.issues.push(issue);
    sendJson(res, 201, issueObject(repo, issue), headers);
    return;
  }
  if (parts.length === 0 && method === 'GET') {
    const query = queryOf(req);
    const wanted = query.get('state') ?? 'open';
    let issues = repo.issues.filter((issue) => wanted === 'all' || issue.state === wanted);
    const direction = query.get('direction');
    if (query.get('sort') === 'created' && direction === 'desc') issues = [...issues].reverse();
    const perPage = Number(query.get('per_page')) || 100;
    sendJson(res, 200, issues.slice(0, perPage).map((issue) => issueObject(repo, issue)), headers);
    return;
  }
  const number = Number(parts[0]);
  const issue = repo.issues.find((entry) => entry.number === number);
  if (parts.length === 1 && issue !== undefined) {
    if (method === 'GET') {
      sendJson(res, 200, issueObject(repo, issue), headers);
      return;
    }
    if (method === 'PATCH') {
      const body = asRecord(await readJson(req));
      if (body?.state === 'open' || body?.state === 'closed') issue.state = body.state;
      sendJson(res, 200, issueObject(repo, issue), headers);
      return;
    }
  }
  if (parts[1] === 'comments' && parts.length === 2 && issue !== undefined) {
    if (method === 'GET') {
      const comments = repo.comments.get(issue.number) ?? [];
      sendJson(res, 200, comments.map((comment) => ({ id: comment.id, body: comment.body, created_at: comment.createdAt })), headers);
      return;
    }
    if (method === 'POST') {
      const body = asRecord(await readJson(req));
      if (body === null || typeof body.body !== 'string') {
        sendJson(res, 422, { message: 'Validation Failed: body is required' }, headers);
        return;
      }
      repo.commentSeq += 1;
      const comment = { id: repo.commentSeq, body: body.body, createdAt: '2026-11-20T00:00:00Z' };
      const comments = repo.comments.get(issue.number) ?? [];
      comments.push(comment);
      repo.comments.set(issue.number, comments);
      issue.comments.push(comment);
      sendJson(res, 201, { id: comment.id, body: comment.body, created_at: comment.createdAt }, headers);
      return;
    }
  }
  sendJson(res, 404, { message: 'Not Found' }, headers);
}

async function handlePulls(
  state: ReturnType<typeof createState>,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  parts: string[],
  method: string,
  headers: Record<string, string>,
): Promise<void> {
  void state;
  if (parts.length === 0 && method === 'POST') {
    const body = asRecord(await readJson(req));
    const head = typeof body?.head === 'string' ? body.head : '';
    const base = typeof body?.base === 'string' ? body.base : repo.defaultBranch;
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = resolveCommit(repo, base);
    if (body === null || typeof body.title !== 'string' || headSha === undefined || baseSha === null) {
      sendJson(res, 422, { message: 'Validation Failed: head, base and title are required' }, headers);
      return;
    }
    repo.pullSeq += 1;
    const changedPaths = diffPaths(repo, baseSha, headSha);
    const pull = {
      number: repo.pullSeq,
      title: body.title,
      body: typeof body.body === 'string' ? body.body : '',
      state: 'open' as const,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      headSha,
      baseRef: base,
      baseSha,
      changedPaths,
      createdAt: '2026-11-20T00:00:00Z',
    };
    repo.pulls.push(pull);
    sendJson(res, 201, pullObject(repo, pull), headers);
    return;
  }
  if (parts.length === 0 && method === 'GET') {
    const wanted = queryOf(req).get('state') ?? 'open';
    const pulls = repo.pulls.filter((pull) => wanted === 'all' || pull.state === wanted);
    sendJson(res, 200, pulls.map((pull) => pullObject(repo, pull)), headers);
    return;
  }
  const number = Number(parts[0]);
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (pull === undefined) {
    sendJson(res, 404, { message: 'Not Found' }, headers);
    return;
  }
  if (parts.length === 1 && method === 'GET') {
    sendJson(res, 200, pullObject(repo, pull), headers);
    return;
  }
  if (parts[1] === 'files' && parts.length === 2 && method === 'GET') {
    const headFiles = fileContentsOfRepo(repo, pull.headSha);
    const baseFiles = fileContentsOfRepo(repo, pull.baseSha);
    const files = pull.changedPaths.map((path) => {
      const head = headFiles.get(path);
      const base = baseFiles.get(path);
      const additions = head === undefined ? 0 : head.toString('utf8').split('\n').length;
      const deletions = base === undefined ? 0 : base.toString('utf8').split('\n').length;
      return {
        filename: path,
        status: base === undefined ? 'added' : head === undefined ? 'removed' : 'modified',
        additions: Math.max(1, additions),
        deletions,
        changes: Math.max(1, additions + deletions),
      };
    });
    sendJson(res, 200, files, headers);
    return;
  }
  if (parts[1] === 'merge' && parts.length === 2 && method === 'PUT') {
    if (pull.merged) {
      sendJson(res, 405, { message: 'Pull request is already merged' }, headers);
      return;
    }
    const currentFiles = fileContentsOfRepo(repo, repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? pull.baseSha);
    const baseFiles = fileContentsOfRepo(repo, pull.baseSha);
    const conflict = pull.changedPaths.some((path) => {
      const current = currentFiles.get(path);
      const base = baseFiles.get(path);
      return current === undefined !== (base === undefined) || (current !== undefined && base !== undefined && !current.equals(base));
    });
    if (conflict) {
      sendJson(res, 405, { message: 'Merge conflict' }, headers);
      return;
    }
    const sha = squashFiles(repo, pull.baseSha, pull.headSha, pull.changedPaths, `${pull.title}\n`);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = '2026-11-20T00:00:00Z';
    pull.mergeCommitSha = sha;
    sendJson(res, 200, { sha, merged: true, message: 'Squashed and merged' }, headers);
    return;
  }
  sendJson(res, 404, { message: 'Not Found' }, headers);
}
