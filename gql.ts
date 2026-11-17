// gql.ts — a small, purpose-built GraphQL v4 executor for POST /api/graphql.
//
// It parses the documents gh and github-mcp-server actually send (operations with
// variables, aliases, inline fragments, introspection __type probes, input objects,
// enum lists and operation batching) and resolves them against the same store the
// REST and git surfaces use, so an object created on one surface reads identically
// on the others. Global ids are opaque base64, stable across reads, and decode back
// to the store object for node(id:) and the mutation inputs.

import { Store, type Issue, type Pull, type Repo } from './core.ts';
import { pullConflict, pullFiles, squashMerge } from './rest.ts';

// ---------------------------------------------------------------------------
// global ids

export function gid(type: string, ...parts: (string | number)[]): string {
  return Buffer.from([type, ...parts].join(':'), 'utf8').toString('base64');
}

export function ungid(id: string): { type: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [type, ...parts] = text.split(':');
    if (!type) return null;
    return { type, parts };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// lexer + parser for the GraphQL subset the clients send

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'enum'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, Value>;
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selection: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

interface Fragment {
  typeCondition: string;
  selection: SelectionNode[];
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if ('{}()[]:$!@='.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '.') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push(`"${out}`);
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < source.length && /[A-Za-z0-9_.-]/.test(source[j]!)) j += 1;
    tokens.push(source.slice(i, j));
    i = j;
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private pos = 0;
  fragments = new Map<string, Fragment>();

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token === 'query' || token === 'mutation') {
        this.next();
        let name: string | null = null;
        if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') name = this.next();
        if (this.peek() === '(') this.skipBalanced();
        const selection = this.parseSelectionSet();
        operations.push({ type: token, name, selection });
      } else if (token === 'fragment') {
        this.next();
        const name = this.next();
        this.expect('on');
        const typeCondition = this.next();
        const selection = this.parseSelectionSet();
        this.fragments.set(name, { typeCondition, selection });
      } else if (token === '{') {
        const selection = this.parseSelectionSet();
        operations.push({ type: 'query', name: null, selection });
      } else {
        throw new Error(`unexpected token ${token}`);
      }
    }
    return operations;
  }

  private skipBalanced(): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token === '(' || token === '{' || token === '[') depth += 1;
      else if (token === ')' || token === '}' || token === ']') depth -= 1;
    } while (depth > 0);
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          const selection = this.parseSelectionSet();
          selections.push({ kind: 'inline', typeCondition, selection });
        } else {
          selections.push({ kind: 'spread', name: this.next() });
        }
        continue;
      }
      let name = this.next();
      let alias: string | null = null;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args = new Map<string, Value>();
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.next();
          this.expect(':');
          args.set(argName, this.parseValue());
        }
        this.expect(')');
      }
      if (this.peek() === '@') {
        this.next();
        this.next();
        if (this.peek() === '(') this.skipBalanced();
      }
      const selection = this.peek() === '{' ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', alias, name, args, selection });
    }
    this.expect('}');
    return selections;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'var', name: this.next() };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields = new Map<string, Value>();
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.set(name, this.parseValue());
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1) };
    if (token === 'true' || token === 'false') return { kind: 'bool', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    if (/^-?\d*\.\d+$/.test(token)) return { kind: 'int', value: Math.trunc(Number.parseFloat(token)) };
    return { kind: 'enum', value: token };
  }
}

// ---------------------------------------------------------------------------
// schema description for introspection

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasPullRequestsEnabled', 'description', 'isPrivate', 'issue', 'issues',
    'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'url',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'createdAt',
    'updatedAt', 'url', 'repository', 'closed',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'headRefName', 'baseRefName',
    'mergeable', 'files', 'author', 'createdAt', 'updatedAt', 'url', 'repository', 'mergeCommit',
  ],
  Ref: ['id', 'name', 'prefix', 'target'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Label: ['id', 'name', 'color'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  __Type: ['kind', 'name', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'interfaces', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  FileStatus: ['ADDED', 'DELETED', 'MODIFIED', 'RENAMED', 'COPIED', 'CHANGED'],
};

// ---------------------------------------------------------------------------
// execution

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, Fragment>;
  errors: { message: string }[];
}

type Obj = Record<string, unknown>;

function resolveValue(ctx: Ctx, value: Value): unknown {
  switch (value.kind) {
    case 'var':
      return ctx.variables[value.name];
    case 'int':
    case 'string':
    case 'enum':
    case 'bool':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(ctx, item));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of value.fields) out[key] = resolveValue(ctx, inner);
      return out;
    }
  }
}

function argOf(ctx: Ctx, field: FieldNode, name: string): unknown {
  const value = field.args.get(name);
  return value === undefined ? undefined : resolveValue(ctx, value);
}

/** Tagged store objects flowing through the executor. */
interface Node {
  __type: string;
  repo?: Repo;
  issue?: Issue;
  pull?: Pull;
  data?: Obj;
}

function executeSelection(ctx: Ctx, type: string, node: Node, selection: SelectionNode[]): Obj {
  const out: Obj = {};
  for (const item of selection) {
    if (item.kind === 'inline') {
      if (item.typeCondition === null || item.typeCondition === type) {
        Object.assign(out, executeSelection(ctx, type, node, item.selection));
      }
      continue;
    }
    if (item.kind === 'spread') {
      const fragment = ctx.fragments.get(item.name);
      if (fragment) Object.assign(out, executeSelection(ctx, type, node, fragment.selection));
      continue;
    }
    const key = item.alias ?? item.name;
    out[key] = resolveField(ctx, type, node, item);
  }
  return out;
}

function sub(ctx: Ctx, field: FieldNode, type: string, node: Node): Obj | null {
  if (field.selection === null) return {};
  return executeSelection(ctx, type, node, field.selection);
}

function repoNode(repo: Repo): Node {
  return { __type: 'Repository', repo };
}

function issueNode(repo: Repo, issue: Issue): Node {
  return { __type: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: Pull): Node {
  return { __type: 'PullRequest', repo, pull };
}

function plainNode(type: string, data: Obj): Node {
  return { __type: type, data };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const parsed = Number.parseInt(text.slice(7), 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resolveField(ctx: Ctx, type: string, node: Node, field: FieldNode): unknown {
  const { store } = ctx;
  const name = field.name;
  if (name === '__type' && (type === 'Query' || type === 'Mutation')) {
    const typeName = String(argOf(ctx, field, 'name') ?? '');
    return typeDescription(ctx, field, typeName);
  }
  if (name === '__schema') return null;

  switch (type) {
    case 'Query':
      return resolveQuery(ctx, node, field);
    case 'Mutation':
      return resolveMutation(ctx, node, field);
    case 'User': {
      if (name === 'login') return store.viewerLogin;
      if (name === 'id') return gid('User', 1000);
      if (name === 'name') return store.viewerLogin;
      break;
    }
    case 'Repository':
      return resolveRepository(ctx, node, field);
    case 'Issue':
      return resolveIssue(ctx, node, field);
    case 'PullRequest':
      return resolvePull(ctx, node, field);
    case '__Type': {
      const data = node.data!;
      if (name === 'name') return data.__name;
      if (name === 'kind') return data.__kind;
      if (name === 'fields') {
        const fields = TYPE_FIELDS[String(data.__name)] ?? [];
        return fields.map((fieldName) => sub(ctx, field, '__Field', plainNode('__Field', { name: fieldName })));
      }
      if (name === 'enumValues') {
        const values = TYPE_ENUMS[String(data.__name)] ?? [];
        return values.map((valueName) => sub(ctx, field, '__EnumValue', plainNode('__EnumValue', { name: valueName })));
      }
      return null;
    }
    case '__Field':
    case '__EnumValue': {
      if (name === 'name') return node.data!.name;
      if (name === 'description') return null;
      if (name === 'isDeprecated') return false;
      if (name === 'deprecationReason') return null;
      return null;
    }
    case 'PageInfo': {
      const data = node.data!;
      if (name in data) return data[name];
      return null;
    }
    default: {
      const data = node.data;
      if (data && name in data) {
        const value = data[name];
        if (value instanceof Object && !Array.isArray(value) && value !== null && '__node' in (value as Obj)) {
          const inner = value as unknown as Node;
          return sub(ctx, field, inner.__type, inner);
        }
        if (Array.isArray(value)) {
          return value.map((entry) =>
            entry instanceof Object && entry !== null && '__type' in (entry as Obj)
              ? sub(ctx, field, (entry as unknown as Node).__type, entry as unknown as Node)
              : entry,
          );
        }
        return value;
      }
      break;
    }
  }
  ctx.errors.push({ message: `Field '${name}' doesn't exist on type '${type}'` });
  return null;
}

function typeDescription(ctx: Ctx, field: FieldNode, typeName: string): Obj | null {
  const isEnum = typeName in TYPE_ENUMS;
  const isKnown = isEnum || typeName in TYPE_FIELDS;
  if (!isKnown) return null;
  const node = plainNode('__Type', { __name: typeName, __kind: isEnum ? 'ENUM' : 'OBJECT' });
  return sub(ctx, field, '__Type', node);
}

function resolveQuery(ctx: Ctx, _node: Node, field: FieldNode): unknown {
  const { store } = ctx;
  switch (field.name) {
    case 'viewer':
      return sub(ctx, field, 'User', plainNode('User', {}));
    case 'repository': {
      const owner = String(argOf(ctx, field, 'owner') ?? '');
      const name = String(argOf(ctx, field, 'name') ?? '');
      if (store.viewerLogin === null && store.repos.has(name)) store.learnViewer(owner);
      if (owner !== store.viewerLogin) return null;
      const repo = store.repos.get(name);
      if (!repo) return null;
      return sub(ctx, field, 'Repository', repoNode(repo));
    }
    case 'node': {
      const id = String(argOf(ctx, field, 'id') ?? '');
      const decoded = ungid(id);
      if (decoded?.type === 'Repository') {
        const repo = [...store.repos.values()].find((candidate) => candidate.id === Number(decoded.parts[0]));
        if (repo) return sub(ctx, field, 'Repository', repoNode(repo));
      }
      return null;
    }
    default:
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'Query'` });
      return null;
  }
}

function resolveRepository(ctx: Ctx, node: Node, field: FieldNode): unknown {
  const { store } = ctx;
  const repo = node.repo!;
  const owner = store.viewerLogin ?? '';
  switch (field.name) {
    case 'id':
      return gid('Repository', repo.id);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${owner}/${repo.name}`;
    case 'description':
      return repo.description;
    case 'isPrivate':
      return repo.priv;
    case 'owner':
      return sub(ctx, field, 'User', plainNode('User', {}));
    case 'defaultBranchRef': {
      const branch = repo.headRef.replace('refs/heads/', '');
      return sub(ctx, field, 'Ref', plainNode('Ref', { name: branch }));
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
    case 'hasPullRequestsEnabled':
      return true;
    case 'createdAt':
    case 'updatedAt':
      return repo.createdAt;
    case 'issue': {
      const number = Number(argOf(ctx, field, 'number'));
      const issue = repo.issues.get(number);
      return issue ? sub(ctx, field, 'Issue', issueNode(repo, issue)) : null;
    }
    case 'issues': {
      const first = Number(argOf(ctx, field, 'first') ?? 100);
      const after = argOf(ctx, field, 'after');
      const states = argOf(ctx, field, 'states') as string[] | undefined;
      const orderBy = argOf(ctx, field, 'orderBy') as { field?: string; direction?: string } | undefined;
      let list = [...repo.issues.values()];
      if (states !== undefined) {
        const wanted = new Set(states.map((state) => state.toLowerCase()));
        list = list.filter((issue) => wanted.has(issue.state));
      }
      const descending = orderBy?.direction !== 'ASC';
      list.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
      let start = 0;
      if (typeof after === 'string' && after !== '') {
        const afterNumber = numberFromCursor(after);
        if (afterNumber !== null) {
          const index = list.findIndex((issue) => issue.number === afterNumber);
          if (index !== -1) start = index + 1;
        }
      }
      const pageItems = list.slice(start, start + first);
      const hasNext = start + first < list.length;
      const connection = plainNode('IssueConnection', {
        totalCount: list.length,
      });
      return executeConnection(ctx, field, connection, pageItems.map((issue) => issueNode(repo, issue)), hasNext, pageItems);
    }
    case 'pullRequest': {
      const number = Number(argOf(ctx, field, 'number'));
      const pull = repo.pulls.get(number);
      return pull ? sub(ctx, field, 'PullRequest', pullNode(repo, pull)) : null;
    }
    case 'pullRequests': {
      const first = Number(argOf(ctx, field, 'first') ?? 100);
      const states = argOf(ctx, field, 'states') as string[] | undefined;
      let list = [...repo.pulls.values()];
      if (states !== undefined) {
        const wanted = new Set(states);
        list = list.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      }
      list.sort((a, b) => b.number - a.number);
      const pageItems = list.slice(0, first);
      const connection = plainNode('PullRequestConnection', { totalCount: list.length });
      return executeConnection(ctx, field, connection, pageItems.map((pull) => pullNode(repo, pull)), list.length > first, pageItems);
    }
    default:
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'Repository'` });
      return null;
  }
}

function executeConnection(
  ctx: Ctx,
  field: FieldNode,
  connection: Node,
  nodes: Node[],
  hasNext: boolean,
  pageItems: (Issue | Pull)[],
): Obj | null {
  if (field.selection === null) return {};
  const out: Obj = {};
  for (const item of field.selection) {
    if (item.kind !== 'field') continue;
    const key = item.alias ?? item.name;
    if (item.name === 'nodes') {
      out[key] = nodes.map((node) => sub(ctx, item, node.__type, node));
    } else if (item.name === 'edges') {
      out[key] = nodes.map((node, index) => {
        const number = pageItems[index]!.number;
        const edge = plainNode('Edge', { cursor: cursorFor(number) });
        if (item.selection === null) return {};
        const edgeOut: Obj = {};
        for (const edgeField of item.selection) {
          if (edgeField.kind !== 'field') continue;
          const edgeKey = edgeField.alias ?? edgeField.name;
          if (edgeField.name === 'node') edgeOut[edgeKey] = sub(ctx, edgeField, node.__type, node);
          else if (edgeField.name === 'cursor') edgeOut[edgeKey] = cursorFor(number);
          else edgeOut[edgeKey] = null;
        }
        void edge;
        return edgeOut;
      });
    } else if (item.name === 'pageInfo') {
      const last = pageItems[pageItems.length - 1];
      const info = plainNode('PageInfo', {
        hasNextPage: hasNext,
        hasPreviousPage: false,
        startCursor: pageItems.length > 0 ? cursorFor(pageItems[0]!.number) : null,
        endCursor: last ? cursorFor(last.number) : null,
      });
      out[key] = sub(ctx, item, 'PageInfo', info);
    } else if (item.name === 'totalCount') {
      out[key] = (connection.data ?? {}).totalCount ?? nodes.length;
    } else {
      out[key] = null;
    }
  }
  return out;
}

function resolveIssue(ctx: Ctx, node: Node, field: FieldNode): unknown {
  const issue = node.issue!;
  const repo = node.repo!;
  switch (field.name) {
    case 'id':
      return gid('Issue', repo.id, issue.number);
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'body':
      return issue.body;
    case 'state':
      return issue.state.toUpperCase();
    case 'closed':
      return issue.state === 'closed';
    case 'createdAt':
    case 'updatedAt':
      return issue.createdAt;
    case 'author':
      return sub(ctx, field, 'User', plainNode('User', {}));
    case 'repository':
      return sub(ctx, field, 'Repository', repoNode(repo));
    case 'labels': {
      const nodes = issue.labels.map((name) => plainNode('Label', { name, color: repo.labels.get(name)?.color ?? 'ededed', id: gid('Label', repo.id, name) }));
      if (field.selection === null) return {};
      const out: Obj = {};
      for (const item of field.selection) {
        if (item.kind !== 'field') continue;
        const key = item.alias ?? item.name;
        if (item.name === 'nodes') out[key] = nodes.map((label) => sub(ctx, item, 'Label', label));
        else out[key] = null;
      }
      return out;
    }
    case 'comments': {
      const first = Number(argOf(ctx, field, 'first') ?? 100);
      const nodes = issue.comments.slice(0, first).map((comment) =>
        plainNode('IssueComment', { id: gid('IssueComment', comment.id), body: comment.body, createdAt: comment.createdAt, updatedAt: comment.createdAt }),
      );
      if (field.selection === null) return {};
      const out: Obj = {};
      for (const item of field.selection) {
        if (item.kind !== 'field') continue;
        const key = item.alias ?? item.name;
        if (item.name === 'nodes') out[key] = nodes.map((comment) => sub(ctx, item, 'IssueComment', comment));
        else if (item.name === 'totalCount') out[key] = issue.comments.length;
        else out[key] = null;
      }
      return out;
    }
    default:
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'Issue'` });
      return null;
  }
}

function resolvePull(ctx: Ctx, node: Node, field: FieldNode): unknown {
  const { store } = ctx;
  const pull = node.pull!;
  const repo = node.repo!;
  switch (field.name) {
    case 'id':
      return gid('PullRequest', repo.id, pull.number);
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'body':
      return pull.body;
    case 'state':
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    case 'merged':
      return pull.merged;
    case 'mergedAt':
      return pull.mergedAt;
    case 'headRefName':
      return pull.headRef;
    case 'baseRefName':
      return pull.baseRef;
    case 'mergeable': {
      if (pull.state !== 'open') return 'UNKNOWN';
      return pullConflict(store, repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    }
    case 'createdAt':
    case 'updatedAt':
      return pull.createdAt;
    case 'author':
      return sub(ctx, field, 'User', plainNode('User', {}));
    case 'repository':
      return sub(ctx, field, 'Repository', repoNode(repo));
    case 'files': {
      const first = Number(argOf(ctx, field, 'first') ?? 100);
      const files = pullFiles(store, repo, pull).slice(0, first);
      const nodes = files.map((file) =>
        plainNode('PullRequestChangedFile', {
          path: file.filename,
          additions: file.additions,
          deletions: file.deletions,
          changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
        }),
      );
      if (field.selection === null) return {};
      const out: Obj = {};
      for (const item of field.selection) {
        if (item.kind !== 'field') continue;
        const key = item.alias ?? item.name;
        if (item.name === 'nodes') out[key] = nodes.map((file) => sub(ctx, item, 'PullRequestChangedFile', file));
        else if (item.name === 'totalCount') out[key] = files.length;
        else out[key] = null;
      }
      return out;
    }
    default:
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'PullRequest'` });
      return null;
  }
}

function findRepoById(store: Store, id: string): Repo | null {
  const decoded = ungid(id);
  if (decoded?.type !== 'Repository') return null;
  return [...store.repos.values()].find((repo) => repo.id === Number(decoded.parts[0])) ?? null;
}

function findIssueById(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = ungid(id);
  if (decoded?.type !== 'Issue') return null;
  const repo = [...store.repos.values()].find((candidate) => candidate.id === Number(decoded.parts[0]));
  if (!repo) return null;
  const issue = repo.issues.get(Number(decoded.parts[1]));
  return issue ? { repo, issue } : null;
}

function findPullById(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  const decoded = ungid(id);
  if (decoded?.type !== 'PullRequest') return null;
  const repo = [...store.repos.values()].find((candidate) => candidate.id === Number(decoded.parts[0]));
  if (!repo) return null;
  const pull = repo.pulls.get(Number(decoded.parts[1]));
  return pull ? { repo, pull } : null;
}

function resolveMutation(ctx: Ctx, _node: Node, field: FieldNode): unknown {
  const { store } = ctx;
  const input = (argOf(ctx, field, 'input') ?? {}) as Record<string, unknown>;
  switch (field.name) {
    case 'createIssue': {
      const repo = typeof input.repositoryId === 'string' ? findRepoById(store, input.repositoryId) : null;
      if (!repo) {
        ctx.errors.push({ message: 'repository not found' });
        return null;
      }
      const issue: Issue = {
        number: repo.nextNumber,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdAt: store.nowIso(),
        isPull: false,
        rev: 0,
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      const payload = plainNode('CreateIssuePayload', {});
      if (field.selection === null) return {};
      const out: Obj = {};
      for (const item of field.selection) {
        if (item.kind !== 'field') continue;
        const key = item.alias ?? item.name;
        if (item.name === 'issue') out[key] = sub(ctx, item, 'Issue', issueNode(repo, issue));
        else out[key] = null;
      }
      void payload;
      return out;
    }
    case 'closeIssue': {
      const found = typeof input.issueId === 'string' ? findIssueById(store, input.issueId) : null;
      if (!found) {
        ctx.errors.push({ message: 'issue not found' });
        return null;
      }
      found.issue.state = 'closed';
      found.issue.rev += 1;
      if (field.selection === null) return {};
      const out: Obj = {};
      for (const item of field.selection) {
        if (item.kind !== 'field') continue;
        const key = item.alias ?? item.name;
        if (item.name === 'issue') out[key] = sub(ctx, item, 'Issue', issueNode(found.repo, found.issue));
        else out[key] = null;
      }
      return out;
    }
    case 'createPullRequest': {
      const repo = typeof input.repositoryId === 'string' ? findRepoById(store, input.repositoryId) : null;
      if (!repo) {
        ctx.errors.push({ message: 'repository not found' });
        return null;
      }
      const pull: Pull = {
        number: repo.nextNumber,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        headRef: typeof input.headRefName === 'string' ? input.headRefName : '',
        baseRef: typeof input.baseRefName === 'string' ? input.baseRefName : '',
        merged: false,
        mergeCommitSha: null,
        mergedAt: null,
        createdAt: store.nowIso(),
        isPull: true,
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      if (field.selection === null) return {};
      const out: Obj = {};
      for (const item of field.selection) {
        if (item.kind !== 'field') continue;
        const key = item.alias ?? item.name;
        if (item.name === 'pullRequest') out[key] = sub(ctx, item, 'PullRequest', pullNode(repo, pull));
        else out[key] = null;
      }
      return out;
    }
    case 'mergePullRequest': {
      const found = typeof input.pullRequestId === 'string' ? findPullById(store, input.pullRequestId) : null;
      if (!found) {
        ctx.errors.push({ message: 'pull request not found' });
        return null;
      }
      const { repo, pull } = found;
      if (pull.state === 'open' && !pullConflict(store, repo, pull)) {
        const sha = squashMerge(store, repo, pull);
        pull.merged = true;
        pull.state = 'closed';
        pull.mergeCommitSha = sha;
        pull.mergedAt = store.nowIso();
      }
      if (field.selection === null) return {};
      const out: Obj = {};
      for (const item of field.selection) {
        if (item.kind !== 'field') continue;
        const key = item.alias ?? item.name;
        if (item.name === 'pullRequest') out[key] = sub(ctx, item, 'PullRequest', pullNode(repo, pull));
        else out[key] = null;
      }
      return out;
    }
    case 'addComment': {
      const found = typeof input.subjectId === 'string' ? findIssueById(store, input.subjectId) : null;
      if (!found) {
        ctx.errors.push({ message: 'subject not found' });
        return null;
      }
      const comment = {
        id: store.nextComment(),
        body: typeof input.body === 'string' ? input.body : '',
        createdAt: store.nowIso(),
      };
      found.issue.comments.push(comment);
      found.issue.rev += 1;
      const commentNode = plainNode('IssueComment', {
        id: gid('IssueComment', comment.id),
        body: comment.body,
        createdAt: comment.createdAt,
        updatedAt: comment.createdAt,
      });
      if (field.selection === null) return {};
      const out: Obj = {};
      for (const item of field.selection) {
        if (item.kind !== 'field') continue;
        const key = item.alias ?? item.name;
        if (item.name === 'commentEdge') {
          const edgeOut: Obj = {};
          if (item.selection !== null) {
            for (const edgeField of item.selection) {
              if (edgeField.kind !== 'field') continue;
              const edgeKey = edgeField.alias ?? edgeField.name;
              if (edgeField.name === 'node') edgeOut[edgeKey] = sub(ctx, edgeField, 'IssueComment', commentNode);
              else if (edgeField.name === 'cursor') edgeOut[edgeKey] = cursorFor(comment.id);
              else edgeOut[edgeKey] = null;
            }
          }
          out[key] = edgeOut;
        } else out[key] = null;
      }
      return out;
    }
    default:
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'Mutation'` });
      return null;
  }
}

// ---------------------------------------------------------------------------
// entry point

export interface GqlReply {
  status: number;
  body: unknown;
}

export function handleGraphQL(store: Store, rawBody: unknown): GqlReply {
  if (Array.isArray(rawBody)) {
    const results = rawBody.map((entry) => executeOne(store, entry));
    return { status: 200, body: results };
  }
  return { status: 200, body: executeOne(store, rawBody) };
}

function executeOne(store: Store, raw: unknown): Obj {
  const request = (raw ?? {}) as { query?: unknown; variables?: unknown };
  if (typeof request.query !== 'string') {
    return { errors: [{ message: 'a query document is required' }] };
  }
  const variables = (request.variables ?? {}) as Record<string, unknown>;
  let operations: Operation[];
  let fragments: Map<string, Fragment>;
  try {
    const parser = new Parser(request.query);
    operations = parser.parseDocument();
    fragments = parser.fragments;
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'parse error' }] };
  }
  const operation = operations[0];
  if (!operation) return { errors: [{ message: 'no operation in document' }] };
  const ctx: Ctx = { store, variables, fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(ctx, rootType, plainNode(rootType, {}), operation.selection);
  const out: Obj = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}
