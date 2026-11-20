// In-memory forge state shared by the REST, Git, GraphQL and MCP surfaces.

import { createHash } from 'node:crypto';
import { fileContents, filesAt, hashObject, putObject, type GitStore, ZERO_OID, writeCommit, writeTree } from './git.ts';

export interface User {
  readonly login: string;
  readonly name: string;
  readonly id: number;
}

export const VIEWER: User = { login: 'adaiversen', name: 'Ada Iversen', id: 1 };
export const STRANGER: User = { login: 'olgabauer', name: 'Olga Bauer', id: 2 };

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
}

export interface Issue {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly createdAt: string;
  readonly comments: Comment[];
}

export interface PullFile {
  readonly filename: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

export interface Pull {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly changedPaths: string[];
  readonly createdAt: string;
}

export interface Repo {
  readonly owner: string;
  readonly name: string;
  description: string;
  readonly private: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  readonly id: number;
  readonly nodeId: string;
  objects: GitStore;
  readonly refs: Map<string, string>;
  readonly labels: Set<string>;
  readonly issues: Issue[];
  readonly pulls: Pull[];
  readonly comments: Map<number, Comment[]>;
  commitSeq: number;
  issueSeq: number;
  pullSeq: number;
  commentSeq: number;
  updatedAt: string;
  pushedAt: string;
}

export interface ForgeState {
  readonly repos: Map<string, Repo>;
  repoSeq: number;
  requestSeq: number;
}

export const FIXED_TIME = '2026-11-20T00:00:00Z';

export function createState(): ForgeState {
  return { repos: new Map(), repoSeq: 0, requestSeq: 0 };
}

export function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

export function findRepoById(state: ForgeState, id: number): Repo | null {
  for (const repo of state.repos.values()) if (repo.id === id) return repo;
  return null;
}

export function createIssueRecord(repo: Repo, title: string, body: string, labels: readonly string[] = []): Issue {
  repo.issueSeq += 1;
  const issue: Issue = {
    number: repo.issueSeq,
    title,
    body,
    state: 'open',
    labels: [...labels],
    createdAt: FIXED_TIME,
    comments: [],
  };
  repo.issues.push(issue);
  return issue;
}

export function createPullRecord(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | null {
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = resolveCommit(repo, baseRef);
  if (headSha === undefined || baseSha === null) return null;
  repo.pullSeq += 1;
  const pull: Pull = {
    number: repo.pullSeq,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef,
    headSha,
    baseRef,
    baseSha,
    changedPaths: diffPaths(repo, baseSha, headSha),
    createdAt: FIXED_TIME,
  };
  repo.pulls.push(pull);
  return pull;
}

/** Merge a pull request with a squash commit on the default branch. Null means a conflict. */
export function mergePullRecord(repo: Repo, pull: Pull): string | null {
  if (pull.merged) return 'already merged';
  const tipRef = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? pull.baseSha;
  const currentFiles = fileContentsOfRepo(repo, tipRef);
  const baseFiles = fileContentsOfRepo(repo, pull.baseSha);
  const conflict = pull.changedPaths.some((path) => {
    const current = currentFiles.get(path);
    const base = baseFiles.get(path);
    return (current === undefined) !== (base === undefined) || (current !== undefined && base !== undefined && !current.equals(base));
  });
  if (conflict) return null;
  const sha = squashFiles(repo, pull.baseSha, pull.headSha, pull.changedPaths, `${pull.title}\n`);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_TIME;
  pull.mergeCommitSha = sha;
  return sha;
}

export function nextRequestId(state: ForgeState): string {
  state.requestSeq += 1;
  return `req-${state.requestSeq.toString(16).padStart(8, '0')}`;
}

export function createRepo(state: ForgeState, owner: string, name: string, description: string, isPrivate: boolean): Repo {
  state.repoSeq += 1;
  const id = state.repoSeq;
  const nodeId = `R_${Buffer.from(`repo:${id}`).toString('base64url')}`;
  const repo: Repo = {
    owner,
    name,
    description,
    private: isPrivate,
    defaultBranch: 'main',
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    pushedAt: FIXED_TIME,
    id,
    nodeId,
    objects: new Map(),
    refs: new Map(),
    labels: new Set(),
    issues: [],
    pulls: [],
    comments: new Map(),
    commitSeq: 0,
    issueSeq: 0,
    pullSeq: 0,
    commentSeq: 0,
  };
  state.repos.set(repoKey(owner, name), repo);
  return repo;
}

/** Resolve a branch, tag or abbreviated/full object id to a commit id. */
export function resolveCommit(repo: Repo, ref: string | undefined | null): string | null {
  if (ref === undefined || ref === null || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/${ref}`];
  for (const candidate of candidates) {
    const oid = repo.refs.get(candidate);
    if (oid !== undefined) {
      let current = oid;
      const object = repo.objects.get(current);
      if (object?.type === 'tag') {
        const target = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'))?.[1];
        if (target !== undefined) current = target;
      }
      return current;
    }
  }
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    const object = repo.objects.get(ref.toLowerCase());
    if (object?.type === 'commit') return ref.toLowerCase();
  }
  return null;
}

/** Read a commit's tree into a flat path -> bytes map. */
export function fileContentsOfRepo(repo: Repo, commitOid: string): Map<string, Buffer> {
  return fileContents(repo.objects, commitOid);
}

/** Commit a flat file-map change to a branch and return the new commit sha. */
export function commitFiles(repo: Repo, branch: string, changes: ReadonlyMap<string, string | null>, message: string): string {
  const tip = repo.refs.get(`refs/heads/${branch}`) ?? ZERO_OID;
  const files = filesAt(repo.objects, tip);
  for (const [path, content] of changes) {
    if (content === null) files.delete(path);
    else files.set(path, putObject(repo.objects, 'blob', Buffer.from(content, 'utf8')));
  }
  const tree = writeTree(repo.objects, files);
  const parents = tip === ZERO_OID ? [] : [tip];
  repo.commitSeq += 1;
  const sha = writeCommit(repo.objects, tree, parents, message, repo.commitSeq);
  repo.refs.set(`refs/heads/${branch}`, sha);
  repo.updatedAt = FIXED_TIME;
  repo.pushedAt = FIXED_TIME;
  return sha;
}

/** Merge copied file contents from a head commit into the default branch. */
export function squashFiles(repo: Repo, baseCommit: string, headCommit: string, changedPaths: readonly string[], message: string): string {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  const files = filesAt(repo.objects, tip);
  const headOids = filesAt(repo.objects, headCommit);
  const baseOids = filesAt(repo.objects, baseCommit);
  for (const path of changedPaths) {
    if (headOids.has(path)) {
      const blob = repo.objects.get(headOids.get(path)!);
      if (blob !== undefined) files.set(path, putObject(repo.objects, 'blob', blob.data));
    } else if (baseOids.has(path)) {
      files.delete(path);
    }
  }
  const tree = writeTree(repo.objects, files);
  repo.commitSeq += 1;
  const sha = writeCommit(repo.objects, tree, tip === ZERO_OID ? [] : [tip], message, repo.commitSeq);
  repo.refs.set(`refs/heads/${repo.defaultBranch}`, sha);
  repo.updatedAt = FIXED_TIME;
  repo.pushedAt = FIXED_TIME;
  return sha;
}

/** Compare two commits' file contents and describe the changed paths. */
export function diffPaths(repo: Repo, baseCommit: string, headCommit: string): string[] {
  const base = fileContents(repo.objects, baseCommit);
  const head = fileContents(repo.objects, headCommit);
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  return [...paths].filter((path) => {
    const a = base.get(path);
    const b = head.get(path);
    return a === undefined || b === undefined || !a.equals(b);
  }).sort();
}

export function repoObject(repo: Repo): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: fullName,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : STRANGER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    size: 1,
    fork: false,
    archived: false,
    disabled: false,
    html_url: `https://github.com/${fullName}`,
    clone_url: `https://github.com/${fullName}.git`,
    url: `/api/v3/repos/${fullName}`,
    permissions: { admin: true, push: true, pull: true },
  };
}

export function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 100_000 + issue.number,
    node_id: `I_${Buffer.from(`${repo.id}:issue:${issue.number}`).toString('base64url')}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: 'ededed' })),
    user: { login: VIEWER.login },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.createdAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullObject(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: repo.id * 100_000 + pull.number,
    node_id: `PR_${Buffer.from(`${repo.id}:pull:${pull.number}`).toString('base64url')}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` } },
    base: { ref: pull.baseRef, sha: pull.baseSha, repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` } },
    user: { login: VIEWER.login },
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

export function globalId(kind: 'repository' | 'issue' | 'pull' | 'comment' | 'user', repo: Repo | null, number?: number): string {
  const payload = kind === 'repository' ? `repository:${repo?.id ?? 0}` : `${kind}:${repo?.id ?? 0}:${number ?? 0}`;
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; repoId: number; number: number } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, repoId, number] = text.split(':');
    return { kind: kind ?? '', repoId: Number(repoId ?? 0), number: Number(number ?? 0) };
  } catch {
    return null;
  }
}

export function deterministicSha(label: string): string {
  return createHash('sha1').update(label).digest('hex');
}
