// rest.ts — the GitHub REST v3 surface under /api/v3: repositories, branches, commits,
// contents, labels, issues, comments and pull requests (with squash merges onto the
// store's real git objects, so the REST, GraphQL, MCP and git views never disagree).
//
// Every reply is JSON with an X-GitHub-Request-Id header; errors are {message} bodies.
// Repositories live under the token owner's login: the first owner segment that names
// an existing repository teaches the forge that login, and any other owner is a 404.

import {
  Store,
  ZERO_OID,
  parseCommit,
  parseTree,
  peelToCommit,
  type Issue,
  type Pull,
  type Repo,
} from './core.ts';

export interface RestReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  rawText?: string;
}

const NOT_FOUND: RestReply = { status: 404, body: { message: 'Not Found' } };

function err(status: number, message: string): RestReply {
  return { status, body: { message } };
}

export interface RestRequest {
  method: string;
  /** path segments after /api/v3, decoded */
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  bodyMalformed: boolean;
  baseUrl: string;
}

function repoJson(repo: Repo, owner: string): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.priv,
    description: repo.description,
    default_branch: repo.headRef.replace('refs/heads/', ''),
    owner: { login: owner },
    html_url: `/${owner}/${repo.name}`,
    created_at: repo.createdAt,
  };
}

function labelJson(name: string, color: string): Record<string, unknown> {
  return { name, color };
}

function issueJson(issue: Issue, repo: Repo, owner: string): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(name, repo.labels.get(name)?.color ?? 'ededed')),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.createdAt,
    user: { login: owner },
  };
}

function pullJson(store: Store, pull: Pull, repo: Repo, owner: string): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? ZERO_OID;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? ZERO_OID;
  return {
    id: repo.id * 1_000_000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${owner}:${pull.baseRef}` },
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
    user: { login: owner },
  };
}

function paginate<T>(items: T[], query: URLSearchParams, url: string): { page: T[]; headers: Record<string, string> } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const next = new URL(url);
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    headers.link = `<${next.toString()}>; rel="next"`;
  }
  return { page: slice, headers };
}

/** Resolve /repos/{owner}/{name}: teaches the viewer login, 404s foreign owners. */
export function resolveRepo(store: Store, owner: string, name: string): Repo | null {
  const repo = store.repos.get(name);
  if (!repo) return null;
  if (store.viewerLogin === null) store.learnViewer(owner);
  if (owner !== store.viewerLogin) return null;
  return repo;
}

function defaultBranch(repo: Repo): string {
  return repo.headRef.replace('refs/heads/', '');
}

function authorLine(store: Store): string {
  const login = store.viewerLogin ?? 'forge';
  return `${login} <${login}@example.invalid> ${store.nowEpoch()} +0000`;
}

// ---------------------------------------------------------------------------
// contents + commits on top of the git store

interface ContentsResult {
  commitSha: string;
  contentSha: string;
}

/** Create or replace one file on a branch with a real commit. */
function putFile(
  store: Store,
  repo: Repo,
  branchRef: string,
  path: string,
  data: Buffer,
  message: string,
): ContentsResult {
  const parent = repo.refs.get(branchRef) ?? null;
  const files = parent !== null ? store.filesOfCommit(parent) : new Map<string, Buffer>();
  files.set(path, data);
  const commitSha = store.commitFiles(parent, files, message, authorLine(store));
  repo.refs.set(branchRef, commitSha);
  repo.packCache.clear();
  const blobSha = store.hashOfBlob(data);
  return { commitSha, contentSha: blobSha };
}

function deleteFile(
  store: Store,
  repo: Repo,
  branchRef: string,
  path: string,
  message: string,
): string | null {
  const parent = repo.refs.get(branchRef) ?? null;
  if (parent === null) return null;
  const files = store.filesOfCommit(parent);
  if (!files.has(path)) return null;
  files.delete(path);
  const commitSha = store.commitFiles(parent, files, message, authorLine(store));
  repo.refs.set(branchRef, commitSha);
  repo.packCache.clear();
  return commitSha;
}

// ---------------------------------------------------------------------------
// pull request diff + squash merge

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function countLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  return text.split('\n');
}

/** A small LCS line diff: enough for additions/deletions counts. */
function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const a = oldData === null ? [] : countLines(oldData);
  const b = newData === null ? [] : countLines(newData);
  if (oldData === null) return { additions: b.length, deletions: 0 };
  if (newData === null) return { additions: 0, deletions: a.length };
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const common = dp[0]![0]!;
  return { additions: b.length - common, deletions: a.length - common };
}

/** Files changed between a pull request's merge base and its head tip. */
export function pullFiles(store: Store, repo: Repo, pull: Pull): FileChange[] {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headSha === undefined || baseSha === undefined) return [];
  const base = store.mergeBase(baseSha, headSha) ?? baseSha;
  const baseFiles = store.filesOfCommit(base);
  const headFiles = store.filesOfCommit(headSha);
  const changes: FileChange[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before !== undefined && after !== undefined && before.equals(after)) continue;
    const diff = lineDiff(before ?? null, after ?? null);
    changes.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions: diff.additions,
      deletions: diff.deletions,
      changes: diff.additions + diff.deletions,
    });
  }
  return changes;
}

/** Whether merging head into base would conflict (both sides changed a path). */
export function pullConflict(store: Store, repo: Repo, pull: Pull): boolean {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headSha === undefined || baseSha === undefined) return true;
  const base = store.mergeBase(baseSha, headSha);
  if (base === null) return true;
  if (base === baseSha) return false; // base has not moved: clean fast-forward state
  const atBase = store.filesOfCommit(base);
  const atTip = store.filesOfCommit(baseSha);
  const atHead = store.filesOfCommit(headSha);
  const paths = new Set([...atBase.keys(), ...atTip.keys(), ...atHead.keys()]);
  for (const path of paths) {
    const inBase = atBase.get(path);
    const inTip = atTip.get(path);
    const inHead = atHead.get(path);
    const tipChanged = !buffersEqual(inBase, inTip);
    const headChanged = !buffersEqual(inBase, inHead);
    if (tipChanged && headChanged && !buffersEqual(inTip, inHead)) return true;
  }
  return false;
}

function buffersEqual(a: Buffer | undefined, b: Buffer | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.equals(b);
}

/** Squash-merge a pull request onto its base branch; returns the new commit sha. */
export function squashMerge(store: Store, repo: Repo, pull: Pull): string {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`)!;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`)!;
  const headFiles = store.filesOfCommit(headSha);
  const tree = store.treeFromFiles(headFiles);
  const stamp = authorLine(store);
  const lines = [`tree ${tree}`, `parent ${baseSha}`, `author ${stamp}`, `committer ${stamp}`];
  const message = `${pull.title}\n\nSquash merge of #${pull.number} from ${pull.headRef}`;
  const data = Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
  const commitSha = store.putObject('commit', data);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
  repo.packCache.clear();
  return commitSha;
}

// ---------------------------------------------------------------------------
// the router

export function handleRest(store: Store, req: RestRequest): RestReply {
  const { method, segments, query } = req;
  const owner = store.viewerLogin ?? 'forge';

  // /api/v3/ and /api/v3/meta
  if (segments.length === 0) {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    return {
      status: 200,
      body: {
        current_user_url: `${req.baseUrl}/api/v3/user`,
        repository_url: `${req.baseUrl}/api/v3/repos/{owner}/{repo}`,
        issue_url: `${req.baseUrl}/api/v3/repos/{owner}/{repo}/issues`,
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    return { status: 200, body: { installed_version: '1.0.0', verifiable_password_authentication: false } };
  }
  if (segments.length === 1 && segments[0] === 'user' && method === 'GET') {
    if (store.viewerLogin === null) return NOT_FOUND;
    return { status: 200, body: { login: store.viewerLogin, id: 1000, type: 'User' } };
  }
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') return createRepo(store, req);
    if (method === 'GET') {
      const all = [...store.repos.values()].map((repo) => repoJson(repo, owner));
      const { page, headers } = paginate(all, query, `${req.baseUrl}/api/v3/user/repos`);
      return { status: 200, body: page, headers };
    }
    return err(405, 'Method Not Allowed');
  }

  if (segments[0] === 'repos' && segments.length >= 3) {
    const repoOwner = segments[1]!;
    const repoName = segments[2]!;
    const repo = resolveRepo(store, repoOwner, repoName);
    if (repo === null) return NOT_FOUND;
    const rest = segments.slice(3);
    return handleRepo(store, req, repo, repoOwner, rest);
  }

  return NOT_FOUND;
}

function createRepo(store: Store, req: RestRequest): RestReply {
  if (req.bodyMalformed) return err(400, 'Problems parsing JSON');
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') return err(422, 'Validation Failed: name is required');
  if (store.repos.has(name)) return err(422, 'Validation Failed: name already exists on this account');
  const repo = store.createRepo(
    name,
    typeof body.description === 'string' ? body.description : '',
    typeof body.private === 'boolean' ? body.private : false,
  );
  const owner = store.viewerLogin ?? 'forge';
  return { status: 201, body: repoJson(repo, owner) };
}

function handleRepo(store: Store, req: RestRequest, repo: Repo, owner: string, rest: string[]): RestReply {
  const { method, query } = req;
  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(repo, owner) };
    if (method === 'PATCH') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.priv = body.private;
      if (typeof body.name === 'string' && body.name !== repo.name) {
        store.repos.delete(repo.name);
        repo.name = body.name;
        store.repos.set(repo.name, repo);
      }
      return { status: 200, body: repoJson(repo, owner) };
    }
    if (method === 'DELETE') {
      store.repos.delete(repo.name);
      return { status: 204, body: null, rawText: '' };
    }
    return err(405, 'Method Not Allowed');
  }

  // branches
  if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.replace('refs/heads/', ''), commit: { sha } }));
    return { status: 200, body: branches };
  }
  if (rest[0] === 'branches' && rest.length >= 2 && method === 'GET') {
    const branchName = rest.slice(1).join('/');
    const sha = repo.refs.get(`refs/heads/${branchName}`);
    if (sha === undefined) return NOT_FOUND;
    return { status: 200, body: { name: branchName, commit: { sha } } };
  }

  // git refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !store.objects.has(sha)) return err(422, 'Validation Failed');
      repo.refs.set(ref, sha);
      repo.packCache.clear();
      return { status: 201, body: { ref, object: { sha, type: 'commit' } } };
    }
    if (rest.length >= 3 && method === 'GET') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return NOT_FOUND;
      return { status: 200, body: { ref, object: { sha, type: 'commit' } } };
    }
  }

  // commits
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const shaParam = query.get('sha');
    let tip: string | undefined;
    if (shaParam === null || shaParam === '') tip = repo.refs.get(repo.headRef);
    else if (/^[0-9a-f]{40}$/i.test(shaParam)) tip = shaParam;
    else tip = repo.refs.get(`refs/heads/${shaParam}`) ?? repo.refs.get(shaParam);
    if (tip === undefined || !store.objects.has(tip)) return { status: 200, body: [] };
    const commitOid = peelToCommit(store, tip);
    if (commitOid === null) return { status: 200, body: [] };
    const ordered: string[] = [];
    const seen = new Set<string>();
    const queue = [commitOid];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      ordered.push(oid);
      const object = store.objects.get(oid);
      if (object && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
    }
    const commits = ordered.map((oid) => {
      const view = parseCommit(store.objects.get(oid)!.data);
      return {
        sha: oid,
        commit: {
          message: view.message.replace(/\n$/, ''),
          author: { name: view.author.replace(/ <.*$/, ''), email: /<([^>]*)>/.exec(view.author)?.[1] ?? '' },
          tree: { sha: view.tree },
        },
        parents: view.parents.map((parent) => ({ sha: parent })),
      };
    });
    const { page, headers } = paginate(commits, query, `${req.baseUrl}/api/v3/repos/${owner}/${repo.name}/commits`);
    return { status: 200, body: page, headers };
  }

  // contents
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    return handleContents(store, req, repo, owner, path);
  }

  // labels
  if (rest[0] === 'labels' && rest.length === 1) {
    if (method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return err(422, 'Validation Failed: name is required');
      const color = typeof body.color === 'string' ? body.color : 'ededed';
      if (!repo.labels.has(name)) repo.labels.set(name, { name, color });
      return { status: 201, body: labelJson(name, repo.labels.get(name)!.color) };
    }
    if (method === 'GET') return { status: 200, body: [...repo.labels.values()].map((label) => labelJson(label.name, label.color)) };
  }

  // issues + comments
  if (rest[0] === 'issues') return handleIssues(store, req, repo, owner, rest);

  // pulls
  if (rest[0] === 'pulls') return handlePulls(store, req, repo, owner, rest);

  return NOT_FOUND;
}

function handleContents(store: Store, req: RestRequest, repo: Repo, owner: string, path: string): RestReply {
  const { method, query } = req;
  const branchOf = (body: Record<string, unknown>): string => {
    const named = typeof body.branch === 'string' ? body.branch : query.get('ref') ?? undefined;
    return `refs/heads/${named ?? defaultBranch(repo)}`;
  };
  if (method === 'PUT') {
    if (req.bodyMalformed) return err(400, 'Problems parsing JSON');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const branchRef = branchOf(body);
    const message = typeof body.message === 'string' ? body.message : 'Update file';
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    const data = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
    const tip = repo.refs.get(branchRef);
    let existingSha: string | null = null;
    if (tip !== undefined) {
      const files = store.filesOfCommit(tip);
      const existing = files.get(path);
      if (existing !== undefined) existingSha = store.hashOfBlob(existing);
    }
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (existingSha !== null && givenSha !== undefined && givenSha !== existingSha) {
      return err(409, 'Conflict: the file has changed since the given sha');
    }
    const result = putFile(store, repo, branchRef, path, data, message);
    const status = existingSha === null ? 201 : 200;
    return {
      status,
      body: {
        content: { name: path.split('/').pop(), path, sha: result.contentSha, size: data.length, encoding: 'base64', type: 'file' },
        commit: { sha: result.commitSha, message },
      },
    };
  }
  if (method === 'DELETE') {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const branchRef = branchOf(body);
    const message = typeof body.message === 'string' ? body.message : 'Delete file';
    const commitSha = deleteFile(store, repo, branchRef, path, message);
    if (commitSha === null) return NOT_FOUND;
    return { status: 200, body: { content: null, commit: { sha: commitSha, message } } };
  }
  if (method === 'GET') {
    const ref = query.get('ref') ?? defaultBranch(repo);
    const tip = repo.refs.get(`refs/heads/${ref}`) ?? (store.objects.has(ref) ? ref : undefined);
    if (tip === undefined) return NOT_FOUND;
    const commitOid = peelToCommit(store, tip);
    if (commitOid === null) return NOT_FOUND;
    const tree = parseCommit(store.objects.get(commitOid)!.data).tree;
    if (path === '') {
      return { status: 200, body: dirListing(store, repo, tree, '') };
    }
    const found = lookupPath(store, tree, path);
    if (found === null) return NOT_FOUND;
    if (found.kind === 'dir') return { status: 200, body: dirListing(store, repo, found.oid, path) };
    const blob = store.objects.get(found.oid)!;
    return {
      status: 200,
      body: {
        type: 'file',
        encoding: 'base64',
        content: blob.data.toString('base64'),
        name: path.split('/').pop(),
        path,
        sha: found.oid,
        size: blob.data.length,
      },
    };
  }
  return err(405, 'Method Not Allowed');
}

function lookupPath(store: Store, treeOid: string, path: string): { kind: 'file' | 'dir'; oid: string } | null {
  const segments = path.split('/');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = store.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) return { kind: entry.mode === '40000' ? 'dir' : 'file', oid: entry.oid };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

function dirListing(store: Store, repo: Repo, treeOid: string, prefix: string): Record<string, unknown>[] {
  const object = store.objects.get(treeOid);
  if (!object || object.type !== 'tree') return [];
  return parseTree(object.data).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
    sha: entry.oid,
    size: entry.mode === '40000' ? 0 : (store.objects.get(entry.oid)?.data.length ?? 0),
  }));
}

function handleIssues(store: Store, req: RestRequest, repo: Repo, owner: string, rest: string[]): RestReply {
  const { method, query } = req;
  if (rest.length === 1) {
    if (method === 'POST') {
      if (req.bodyMalformed) return err(400, 'Problems parsing JSON');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const labels = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return err(422, `Validation Failed: label ${label} does not exist`);
      }
      const issue: Issue = {
        number: repo.nextNumber,
        title: typeof body.title === 'string' ? body.title : '',
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        labels,
        comments: [],
        createdAt: store.nowIso(),
        isPull: false,
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return { status: 201, body: issueJson(issue, repo, owner) };
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      const direction = query.get('direction') ?? 'desc';
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { page, headers } = paginate(list.map((issue) => issueJson(issue, repo, owner)), query, `${req.baseUrl}/api/v3/repos/${owner}/${repo.name}/issues`);
      return { status: 200, body: page, headers };
    }
    return err(405, 'Method Not Allowed');
  }
  const number = Number.parseInt(rest[1]!, 10);
  const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
  if (rest.length === 2) {
    if (issue === undefined) return NOT_FOUND;
    if (method === 'GET') return { status: 200, body: issueJson(issue, repo, owner) };
    if (method === 'PATCH') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      return { status: 200, body: issueJson(issue, repo, owner) };
    }
    return err(405, 'Method Not Allowed');
  }
  if (rest.length === 3 && rest[2] === 'comments') {
    if (issue === undefined) return NOT_FOUND;
    if (method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const comment = { id: store.nextComment(), body: typeof body.body === 'string' ? body.body : '', createdAt: store.nowIso() };
      issue.comments.push(comment);
      return { status: 201, body: { id: comment.id, body: comment.body, created_at: comment.createdAt, user: { login: owner } } };
    }
    if (method === 'GET') {
      return {
        status: 200,
        body: issue.comments.map((comment) => ({ id: comment.id, body: comment.body, created_at: comment.createdAt, user: { login: owner } })),
      };
    }
  }
  return NOT_FOUND;
}

function handlePulls(store: Store, req: RestRequest, repo: Repo, owner: string, rest: string[]): RestReply {
  const { method, query } = req;
  if (rest.length === 1) {
    if (method === 'POST') {
      if (req.bodyMalformed) return err(400, 'Problems parsing JSON');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const head = typeof body.head === 'string' ? body.head.replace(/^[^:]+:/, '') : '';
      const base = typeof body.base === 'string' ? body.base : '';
      if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
        return err(422, 'Validation Failed: head or base branch does not exist');
      }
      const pull: Pull = {
        number: repo.nextNumber,
        title: typeof body.title === 'string' ? body.title : '',
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        headRef: head,
        baseRef: base,
        merged: false,
        mergeCommitSha: null,
        mergedAt: null,
        createdAt: store.nowIso(),
        isPull: true,
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      return { status: 201, body: pullJson(store, pull, repo, owner) };
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      list.sort((a, b) => b.number - a.number);
      const { page, headers } = paginate(list.map((pull) => pullJson(store, pull, repo, owner)), query, `${req.baseUrl}/api/v3/repos/${owner}/${repo.name}/pulls`);
      return { status: 200, body: page, headers };
    }
    return err(405, 'Method Not Allowed');
  }
  const number = Number.parseInt(rest[1]!, 10);
  const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
  if (rest.length === 2) {
    if (pull === undefined) return NOT_FOUND;
    if (method === 'GET') return { status: 200, body: pullJson(store, pull, repo, owner) };
    if (method === 'PATCH') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.state === 'open' || body.state === 'closed') pull.state = body.state;
      return { status: 200, body: pullJson(store, pull, repo, owner) };
    }
    return err(405, 'Method Not Allowed');
  }
  if (pull === undefined) return NOT_FOUND;
  if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
    const files = pullFiles(store, repo, pull).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      sha: '',
    }));
    const { page, headers } = paginate(files, query, `${req.baseUrl}/api/v3/repos/${owner}/${repo.name}/pulls/${number}/files`);
    return { status: 200, body: page, headers };
  }
  if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
    if (pull.state !== 'open') return err(405, 'Pull Request is not open');
    if (pullConflict(store, repo, pull)) return err(405, 'Pull Request is not mergeable');
    const sha = squashMerge(store, repo, pull);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergeCommitSha = sha;
    pull.mergedAt = store.nowIso();
    return { status: 200, body: { sha, merged: true, message: 'Pull Request successfully merged' } };
  }
  return NOT_FOUND;
}
