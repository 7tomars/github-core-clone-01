// mcp.ts — the Model Context Protocol endpoint at POST /mcp (JSON-RPC 2.0 over
// streamable HTTP). It speaks both eras the suite negotiates: the modern
// server/discover revision (2026-07-28) and the legacy initialize handshake
// (2025-11-25 and earlier). The six tools act on the same store as REST, so an
// object created here reads back identically over REST and GraphQL.

import { Store, type Repo } from './core.ts';
import { pullConflict, squashMerge } from './rest.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface Tool {
  name: string;
  description: string;
  required: string[];
  properties: Record<string, { type: string; description: string }>;
  run: (store: Store, args: Record<string, unknown>) => unknown;
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function repoOf(store: Store, args: Record<string, unknown>): Repo | null {
  const fullName = str(args, 'full_name');
  const name = str(args, 'repo') || (fullName.includes('/') ? fullName.split('/')[1]! : '');
  const repo = store.repos.get(name);
  if (!repo) return null;
  const owner = str(args, 'owner') || (fullName.includes('/') ? fullName.split('/')[0]! : '');
  if (owner !== '' && store.viewerLogin === null) store.learnViewer(owner);
  if (owner !== '' && store.viewerLogin !== null && owner !== store.viewerLogin) return null;
  return repo;
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const owner = store.viewerLogin ?? '';
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.priv,
    description: repo.description,
    default_branch: repo.headRef.replace('refs/heads/', ''),
    owner: { login: owner },
  };
}

function issueJson(repo: Repo, issue: { number: number; title: string; body: string; state: string; labels: string[] }): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
  };
}

const TOOLS: Tool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    run: (store, args) => {
      const name = str(args, 'name');
      if (name === '') throw new Error('name is required');
      if (store.repos.has(name)) throw new Error(`repository ${name} already exists`);
      const repo = store.createRepo(name, str(args, 'description'), args.private === true);
      return repoJson(store, repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The full name, owner/repo.' },
    },
    run: (store, args) => {
      const repo = repoOf(store, args);
      if (!repo) throw new Error('repository not found');
      return repoJson(store, repo);
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    required: ['owner', 'repo', 'title'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The full name, owner/repo.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    run: (store, args) => {
      const repo = repoOf(store, args);
      if (!repo) throw new Error('repository not found');
      const issue = {
        number: repo.nextNumber,
        title: str(args, 'title'),
        body: str(args, 'body'),
        state: 'open' as const,
        labels: [] as string[],
        comments: [],
        createdAt: store.nowIso(),
        isPull: false as const,
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return issueJson(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The full name, owner/repo.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    run: (store, args) => {
      const repo = repoOf(store, args);
      if (!repo) throw new Error('repository not found');
      const state = str(args, 'state') || 'open';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      return list.map((issue) => issueJson(repo, issue));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    required: ['owner', 'repo', 'title', 'head', 'base'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The full name, owner/repo.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    run: (store, args) => {
      const repo = repoOf(store, args);
      if (!repo) throw new Error('repository not found');
      const head = str(args, 'head');
      const base = str(args, 'base');
      if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
        throw new Error('head or base branch does not exist');
      }
      const pull = {
        number: repo.nextNumber,
        title: str(args, 'title'),
        body: str(args, 'body'),
        state: 'open' as const,
        headRef: head,
        baseRef: base,
        merged: false,
        mergeCommitSha: null,
        mergedAt: null,
        createdAt: store.nowIso(),
        isPull: true as const,
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      const owner = store.viewerLogin ?? '';
      return {
        id: repo.id * 1_000_000 + pull.number,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: head, sha: repo.refs.get(`refs/heads/${head}`) },
        base: { ref: base, sha: repo.refs.get(`refs/heads/${base}`) },
        html_url: `/${owner}/${repo.name}/pull/${pull.number}`,
      };
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    required: ['owner', 'repo', 'pull_number'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The full name, owner/repo.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
      merge_method: { type: 'string', description: 'The merge method: squash, merge or rebase.' },
    },
    run: (store, args) => {
      const repo = repoOf(store, args);
      if (!repo) throw new Error('repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(str(args, 'pull_number'), 10);
      const pull = repo.pulls.get(number);
      if (!pull) throw new Error('pull request not found');
      if (pull.state !== 'open') throw new Error('pull request is not open');
      if (pullConflict(store, repo, pull)) throw new Error('pull request is not mergeable');
      const sha = squashMerge(store, repo, pull);
      pull.merged = true;
      pull.state = 'closed';
      pull.mergeCommitSha = sha;
      pull.mergedAt = store.nowIso();
      return { sha, merged: true, message: 'Pull Request successfully merged' };
    },
  },
];

/** The tools/list payload, built once: byte-for-byte identical on every call. */
const TOOLS_LIST = TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: {
    type: 'object',
    properties: tool.properties,
    required: tool.required,
  },
}));

export interface McpReply {
  status: number;
  body: unknown;
  /** true when the reply must be an empty 202 (a notification) */
  empty?: boolean;
}

function rpcError(id: unknown, code: number, message: string): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

export function handleMcp(store: Store, raw: unknown): McpReply {
  if (Array.isArray(raw)) {
    const replies = raw.map((entry) => handleOne(store, entry)).filter((reply) => !reply.empty);
    return { status: 200, body: replies.map((reply) => reply.body) };
  }
  return handleOne(store, raw);
}

function handleOne(store: Store, raw: unknown): McpReply {
  const request = (raw ?? {}) as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id;
  const params = (request.params ?? {}) as Record<string, unknown>;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS[0],
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS_LIST });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (!tool) return rpcError(id, -32602, `unknown tool: ${name}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      for (const required of tool.required) {
        if (args[required] === undefined || args[required] === '') {
          return rpcResult(id, {
            content: [{ type: 'text', text: `missing required argument: ${required}` }],
            isError: true,
          });
        }
      }
      try {
        const result = tool.run(store, args);
        const text = typeof result === 'string' ? result : JSON.stringify(result);
        return rpcResult(id, {
          content: [{ type: 'text', text }],
          structuredContent: result,
          isError: false,
        });
      } catch (error) {
        return rpcResult(id, {
          content: [{ type: 'text', text: error instanceof Error ? error.message : 'tool failed' }],
          isError: true,
        });
      }
    }
    default:
      if (isNotification || method.startsWith('notifications/')) return { status: 202, body: null, empty: true };
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}
