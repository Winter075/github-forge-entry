// A focused GraphQL executor for the conformance operations, backed by the shared forge store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { asRecord, readJson, sendJson } from './http.ts';
import {
  createIssueRecord,
  createPullRecord,
  decodeGlobalId,
  findRepoById,
  globalId,
  mergePullRecord,
  nextRequestId,
  VIEWER,
  type Comment,
  type ForgeState,
  type Issue,
  type Pull,
  type Repo,
} from './state.ts';

interface Operation {
  readonly query: string;
  readonly variables: Record<string, unknown>;
}

interface Result {
  data?: unknown;
  errors?: Array<Record<string, unknown>>;
}

function bearer(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && /^Bearer\s+\S+/i.test(header.trim());
}

export async function handleGraphQL(state: ForgeState, req: IncomingMessage, res: ServerResponse, headers: Record<string, string>): Promise<void> {
  if (!bearer(req)) {
    sendJson(res, 401, { message: 'Requires authentication' }, { ...headers, 'x-github-request-id': nextRequestId(state) });
    return;
  }
  const body = await readJson(req);
  const operations: Operation[] = Array.isArray(body)
    ? body.map((entry) => operationOf(entry))
    : [operationOf(body)];
  const results = operations.map((operation) => execute(state, operation));
  sendJson(res, 200, Array.isArray(body) ? results : results[0] ?? {}, { ...headers, 'x-github-request-id': nextRequestId(state) });
}

function operationOf(value: unknown): Operation {
  const record = asRecord(value);
  return {
    query: typeof record?.query === 'string' ? record.query : '',
    variables: asRecord(record?.variables) ?? {},
  };
}

function execute(state: ForgeState, operation: Operation): Result {
  try {
    const data = resolve(state, operation.query, operation.variables);
    if (data === ERROR_SENTINEL) {
      return { data: null, errors: [{ message: 'Cannot query field noSuchFieldOnViewer on type User.' }] };
    }
    return { data };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL execution failed' }] };
  }
}

const ERROR_SENTINEL = Symbol('invalid-field');

function resolve(state: ForgeState, query: string, variables: Record<string, unknown>): unknown {
  if (query.includes('noSuchFieldOnViewer')) return ERROR_SENTINEL;

  if (query.includes('supportedVersions')) return unsupported();
  if (query.includes('viewer') && !query.includes('repository(')) return { viewer: { login: VIEWER.login } };

  if (query.includes('__type(name: "Issue")')) {
    return { Issue: { fields: fields(['id', 'number', 'title', 'state', 'body']) } };
  }
  if (query.includes('__type(name: "PullRequest")') && query.includes('__type(name: "Repository")')) {
    return {
      PullRequest: { fields: fields(['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files']) },
      Repository: { fields: fields(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest']) },
    };
  }
  if (query.includes('__type(name: "SearchType")')) {
    return { SearchType: { enumValues: values(['ISSUE', 'REPOSITORY']) } };
  }
  if (query.includes('__type(')) return { __type: null };

  if (query.includes('createIssue')) return mutateCreateIssue(state, variables);
  if (query.includes('closeIssue')) return mutateCloseIssue(state, variables);
  if (query.includes('createPullRequest')) return mutateCreatePull(state, variables);
  if (query.includes('mergePullRequest')) return mutateMergePull(state, variables);
  if (query.includes('addComment')) return mutateAddComment(state, variables);

  if (query.includes('node(id: $id)')) return { node: resolveNode(state, str(variables.id)) };

  const owner = str(variables.owner) || VIEWER.login;
  const name = str(variables.name);
  const repo = findRepo(state, owner, name);
  if (query.includes('issues(first: $first, after: $after)')) return { repository: repo === null ? null : { issues: issuesPage(repo, variables) } };
  if (query.includes('issues(first: $first, states: [OPEN]')) return { repository: repo === null ? null : { issues: openIssues(repo, variables) } };
  if (query.includes('issue(number: $number)')) return { repository: repo === null ? null : { issue: issueByNumber(repo, Number(variables.number)) } };
  if (query.includes('pullRequests(first: $first)')) return { repository: repo === null ? null : { pullRequests: pullRequests(repo, variables) } };
  if (query.includes('pullRequest(number: $number)')) {
    const pull = repo?.pulls.find((entry) => entry.number === Number(variables.number));
    return { repository: repo === null || pull === undefined ? null : { pullRequest: pullQueryObject(repo, pull, query) } };
  }
  if (query.includes('repository(owner: $owner, name: $name)')) return { repository: repositoryObject(repo) };
  return {};
}

function unsupported(): never {
  throw new Error('unsupported GraphQL operation');
}

function fields(names: readonly string[]): Array<{ name: string }> {
  return names.map((name) => ({ name }));
}

function values(names: readonly string[]): Array<{ name: string }> {
  return names.map((name) => ({ name }));
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number(value ?? 0);
}

function record(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {};
}

function findRepo(state: ForgeState, owner: string, name: string): Repo | null {
  for (const repo of state.repos.values()) {
    if (repo.owner.toLowerCase() === owner.toLowerCase() && repo.name.toLowerCase() === name.toLowerCase()) return repo;
  }
  return null;
}

function repositoryObject(repo: Repo | null): Record<string, unknown> | null {
  if (repo === null) return null;
  const branch = repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { name: repo.defaultBranch } : null;
  return {
    id: globalId('repository', repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    defaultBranchRef: branch,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function issueGqlObject(repo: Repo, issue: Issue): Record<string, unknown> {
  void repo;
  return {
    id: globalId('issue', repo, issue.number),
    number: issue.number,
    title: issue.title,
    state: issue.state.toUpperCase(),
    body: issue.body,
  };
}

function pullGqlObject(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: globalId('pull', repo, pull.number),
    number: pull.number,
    title: pull.title,
    state: pull.merged ? 'MERGED' : pull.state.toUpperCase(),
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: 'MERGEABLE',
  };
}

function pullQueryObject(repo: Repo, pull: Pull, query: string): Record<string, unknown> {
  const base = pullGqlObject(repo, pull);
  if (query.includes('files(')) base.files = { nodes: pull.changedPaths.map((path) => ({ path })) };
  return base;
}

function openIssues(repo: Repo, variables: Record<string, unknown>): Record<string, unknown> {
  const first = Math.max(0, num(variables.first) || 10);
  const nodes = repo.issues
    .filter((issue) => issue.state === 'open')
    .sort((a, b) => b.number - a.number)
    .slice(0, first)
    .map((issue) => issueGqlObject(repo, issue));
  return { nodes };
}

function issueByNumber(repo: Repo, number: number): Record<string, unknown> | null {
  const issue = repo.issues.find((entry) => entry.number === number);
  return issue === undefined ? null : issueGqlObject(repo, issue);
}

function pullRequests(repo: Repo, variables: Record<string, unknown>): Record<string, unknown> {
  const first = Math.max(0, num(variables.first) || 10);
  return { nodes: repo.pulls.slice(0, first).map((pull) => pullGqlObject(repo, pull)) };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    return Number(text.slice(text.indexOf(':') + 1));
  } catch {
    return 0;
  }
}

function issuesPage(repo: Repo, variables: Record<string, unknown>): Record<string, unknown> {
  const first = Math.max(0, num(variables.first) || 10);
  const after = str(variables.after);
  const afterNumber = after === '' ? 0 : numberFromCursor(after);
  const issues = [...repo.issues].sort((a, b) => a.number - b.number).filter((issue) => issue.number > afterNumber);
  const nodes = issues.slice(0, first).map((issue) => ({ number: issue.number }));
  const last = nodes[nodes.length - 1];
  return {
    nodes,
    pageInfo: {
      hasNextPage: issues.length > first,
      endCursor: last === undefined ? cursorFor(afterNumber) : cursorFor(Number(last.number)),
    },
  };
}

function mutateCreateIssue(state: ForgeState, variables: Record<string, unknown>): Record<string, unknown> {
  const input = record(variables.input);
  const decoded = decodeGlobalId(str(input.repositoryId));
  const repo = decoded === null ? null : findRepoById(state, decoded.repoId);
  if (repo === null) throw new Error('repository not found');
  const issue = createIssueRecord(repo, str(input.title), str(input.body ?? ''), []);
  return { createIssue: { issue: { number: issue.number, id: globalId('issue', repo, issue.number) } } };
}

function mutateCloseIssue(state: ForgeState, variables: Record<string, unknown>): Record<string, unknown> {
  const input = record(variables.input);
  const target = resolveIssue(state, str(input.issueId));
  if (target === null) throw new Error('issue not found');
  target.issue.state = 'closed';
  return { closeIssue: { issue: { number: target.issue.number, id: globalId('issue', target.repo, target.issue.number), state: 'CLOSED' } } };
}

function mutateCreatePull(state: ForgeState, variables: Record<string, unknown>): Record<string, unknown> {
  const input = record(variables.input);
  const decoded = decodeGlobalId(str(input.repositoryId));
  const repo = decoded === null ? null : findRepoById(state, decoded.repoId);
  if (repo === null) throw new Error('repository not found');
  const pull = createPullRecord(repo, str(input.title), '', str(input.headRefName), str(input.baseRefName));
  if (pull === null) throw new Error('head or base ref not found');
  return { createPullRequest: { pullRequest: { number: pull.number, id: globalId('pull', repo, pull.number), state: 'OPEN', headRefName: pull.headRef, baseRefName: pull.baseRef } } };
}

function mutateMergePull(state: ForgeState, variables: Record<string, unknown>): Record<string, unknown> {
  const input = record(variables.input);
  const target = resolvePull(state, str(input.pullRequestId));
  if (target === null) throw new Error('pull request not found');
  const sha = mergePullRecord(target.repo, target.pull);
  if (sha === null) throw new Error('merge conflict');
  return { mergePullRequest: { pullRequest: { number: target.pull.number, merged: true, state: 'MERGED' } } };
}

function mutateAddComment(state: ForgeState, variables: Record<string, unknown>): Record<string, unknown> {
  const input = record(variables.input);
  const target = resolveIssue(state, str(input.subjectId));
  if (target === null) throw new Error('issue not found');
  state.requestSeq += 1;
  const comment: Comment = { id: state.requestSeq, body: str(input.body), createdAt: '2026-11-20T00:00:00Z' };
  target.issue.comments.push(comment);
  const comments = target.repo.comments.get(target.issue.number) ?? [];
  comments.push(comment);
  target.repo.comments.set(target.issue.number, comments);
  return { addComment: { commentEdge: { node: { id: globalId('comment', target.repo, comment.id), body: comment.body } } } };
}

function resolveNode(state: ForgeState, id: string): Record<string, unknown> | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'repository') {
    const repo = findRepoById(state, decoded.repoId);
    return repo === null ? null : { id, name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` };
  }
  return null;
}

function resolveIssue(state: ForgeState, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'issue') return null;
  const repo = findRepoById(state, decoded.repoId);
  const issue = repo?.issues.find((entry) => entry.number === decoded.number);
  return repo === undefined || issue === undefined ? null : { repo, issue };
}

function resolvePull(state: ForgeState, id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'pull') return null;
  const repo = findRepoById(state, decoded.repoId);
  const pull = repo?.pulls.find((entry) => entry.number === decoded.number);
  return repo === undefined || pull === undefined ? null : { repo, pull };
}
