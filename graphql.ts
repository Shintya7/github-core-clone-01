// GitHub GraphQL v4 at /api/graphql: a small document parser and executor for the
// documents gh and github-mcp-server actually send — viewer and repository reads, issue
// and pull-request reads and mutations, Relay node ids, cursor pagination, __type
// introspection, and batched operation documents. An unknown field is a 200 with an
// errors array naming it; an unknown repository is data.repository null with no errors.

import { FIXED_ISO, type Forge, type Issue, type PullRequest, type Repo } from './store.ts';
import { b64 } from './rest.ts';

// -------------------------------------------------------------------------------------------
// document parsing
// -------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selection: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; typeCondition: string; selection: SelectionNode[] };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  variables: { name: string; defaultValue: ValueNode | null }[];
  selection: SelectionNode[];
}

class ParseError extends Error {}

class Parser {
  private pos = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  private skipSpace(): void {
    for (;;) {
      while (this.pos < this.text.length && /\s/.test(this.text[this.pos] as string)) this.pos += 1;
      if (this.text[this.pos] === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      if (this.text.startsWith(',', this.pos)) {
        this.pos += 1;
        continue;
      }
      break;
    }
  }

  private peek(): string {
    this.skipSpace();
    return this.text[this.pos] ?? '';
  }

  private take(expected: string): void {
    this.skipSpace();
    if (!this.text.startsWith(expected, this.pos)) {
      throw new ParseError(`expected ${JSON.stringify(expected)} at ${this.pos}`);
    }
    this.pos += expected.length;
  }

  private tryTake(expected: string): boolean {
    this.skipSpace();
    if (this.text.startsWith(expected, this.pos)) {
      this.pos += expected.length;
      return true;
    }
    return false;
  }

  private readName(): string {
    this.skipSpace();
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos));
    if (!match) throw new ParseError(`expected a name at ${this.pos}`);
    this.pos += match[0].length;
    return match[0];
  }

  private readString(): string {
    this.skipSpace();
    if (this.text[this.pos] !== '"') throw new ParseError(`expected a string at ${this.pos}`);
    this.pos += 1;
    let out = '';
    for (;;) {
      if (this.pos >= this.text.length) throw new ParseError('unterminated string');
      const ch = this.text[this.pos] as string;
      if (ch === '"') {
        this.pos += 1;
        return out;
      }
      if (ch === '\\') {
        const next = this.text[this.pos + 1] as string;
        const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
        if (next === 'u') {
          out += String.fromCharCode(Number.parseInt(this.text.slice(this.pos + 2, this.pos + 6), 16));
          this.pos += 6;
        } else if (next in escapes) {
          out += escapes[next] as string;
          this.pos += 2;
        } else {
          throw new ParseError(`bad escape \\${next}`);
        }
        continue;
      }
      out += ch;
      this.pos += 1;
    }
  }

  private readNumber(): ValueNode {
    this.skipSpace();
    const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.text.slice(this.pos));
    if (!match) throw new ParseError(`expected a number at ${this.pos}`);
    this.pos += match[0].length;
    const value = Number(match[0]);
    return match[0].includes('.') || /[eE]/.test(match[0]) ? { kind: 'float', value } : { kind: 'int', value };
  }

  parseValue(): ValueNode {
    this.skipSpace();
    const ch = this.peek();
    if (ch === '$') {
      this.pos += 1;
      return { kind: 'variable', name: this.readName() };
    }
    if (ch === '"') return { kind: 'string', value: this.readString() };
    if (ch === '[') {
      this.pos += 1;
      const values: ValueNode[] = [];
      while (!this.tryTake(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (ch === '{') {
      this.pos += 1;
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.tryTake('}')) {
        const name = this.readName();
        this.take(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (ch === '-' || /[0-9]/.test(ch)) return this.readNumber();
    const name = this.readName();
    if (name === 'true') return { kind: 'boolean', value: true };
    if (name === 'false') return { kind: 'boolean', value: false };
    if (name === 'null') return { kind: 'null' };
    return { kind: 'enum', value: name };
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    if (!this.tryTake('(')) return args;
    while (!this.tryTake(')')) {
      const name = this.readName();
      this.take(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseType(): void {
    // A variable definition's type: [String!]!, String!, and so on — skip it.
    this.skipSpace();
    if (this.tryTake('[')) {
      this.parseType();
      this.take(']');
    } else {
      this.readName();
    }
    this.tryTake('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.take('{');
    const selections: SelectionNode[] = [];
    while (!this.tryTake('}')) {
      if (this.text.startsWith('...', this.pos)) {
        this.pos += 3;
        this.skipSpace();
        if (this.text.startsWith('on', this.pos) && !/[A-Za-z0-9_]/.test(this.text[this.pos + 2] ?? '')) {
          this.pos += 2;
          const typeCondition = this.readName();
          selections.push({ kind: 'fragment', typeCondition, selection: this.parseSelectionSet() });
        } else {
          // A named fragment spread: skip its name; the fragment itself is not in these documents.
          this.readName();
        }
        continue;
      }
      const first = this.readName();
      let alias: string | null = null;
      let name = first;
      if (this.tryTake(':')) {
        alias = first;
        name = this.readName();
      }
      const args = this.parseArguments();
      let selection: SelectionNode[] = [];
      this.skipSpace();
      if (this.peek() === '{') selection = this.parseSelectionSet();
      selections.push({ kind: 'field', field: { alias, name, args, selection } });
    }
    return selections;
  }

  parseOperation(): OperationNode {
    this.skipSpace();
    let type: 'query' | 'mutation' = 'query';
    const word = this.peek();
    if (word === 'q' || word === 'm') {
      const name = this.readName();
      if (name === 'query') type = 'query';
      else if (name === 'mutation') type = 'mutation';
      else throw new ParseError(`unknown operation ${name}`);
    }
    this.skipSpace();
    let name: string | null = null;
    const next = this.peek();
    if (next !== '{' && next !== '(' && next !== '') {
      name = this.readName();
    }
    const variables: { name: string; defaultValue: ValueNode | null }[] = [];
    if (this.tryTake('(')) {
      while (!this.tryTake(')')) {
        this.take('$');
        const varName = this.readName();
        this.take(':');
        this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.tryTake('=')) defaultValue = this.parseValue();
        variables.push({ name: varName, defaultValue });
      }
    }
    const selection = this.parseSelectionSet();
    return { type, name, variables, selection };
  }
}

function parseDocument(query: string): OperationNode {
  return new Parser(query).parseOperation();
}

// -------------------------------------------------------------------------------------------
// value resolution
// -------------------------------------------------------------------------------------------

type JsonValue = unknown;

function resolveValue(node: ValueNode, variables: Record<string, unknown>): JsonValue {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// -------------------------------------------------------------------------------------------
// schema surface for introspection
// -------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'comments', 'labels'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'createdAt', 'updatedAt', 'url', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'url'],
  SearchType: [],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'WIKI', 'PACKAGE'];

// -------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------

interface IssueRef {
  repo: Repo;
  issue: Issue;
}

interface PullRef {
  repo: Repo;
  pull: PullRequest;
}

type ResolvedValue =
  | { kind: 'viewer' }
  | { kind: 'repo'; repo: Repo }
  | { kind: 'issue'; ref: IssueRef }
  | { kind: 'pull'; ref: PullRef }
  | { kind: 'issues'; repo: Repo; issues: Issue[]; endCursor: string | null; hasNextPage: boolean }
  | { kind: 'pulls'; repo: Repo; pulls: PullRequest[] }
  | { kind: 'files'; repo: Repo; pull: PullRequest; first: number }
  | { kind: 'user'; login: string }
  | { kind: 'ref'; name: string }
  | { kind: 'pageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { kind: 'type'; name: string }
  | { kind: 'payload'; fields: Record<string, unknown> }
  | { kind: 'commentEdge'; id: string; body: string }
  | { kind: 'comment'; id: string; body: string }
  | { kind: 'scalar'; value: unknown };

const TYPE_NAMES: Record<string, string> = {
  viewer: 'User',
  repo: 'Repository',
  issue: 'Issue',
  pull: 'PullRequest',
  issues: 'IssueConnection',
  pulls: 'PullRequestConnection',
  files: 'PullRequestChangedFileConnection',
  user: 'User',
  ref: 'Ref',
  pageInfo: 'PageInfo',
  type: '__Type',
  payload: 'Payload',
  commentEdge: 'IssueCommentEdge',
  comment: 'IssueComment',
  scalar: 'String',
};

class Executor {
  private errors: { message: string }[] = [];
  private readonly forge: Forge;

  constructor(forge: Forge) {
    this.forge = forge;
  }

  private fail(message: string): void {
    this.errors.push({ message });
  }

  getErrors(): { message: string }[] {
    return this.errors;
  }

  private globalRepoId(repo: Repo): string {
    return b64(`R:${repo.id}`);
  }

  private globalIssueId(repo: Repo, issue: Issue): string {
    return b64(`I:${repo.id}:${issue.number}`);
  }

  private globalPullId(repo: Repo, pull: PullRequest): string {
    return b64(`P:${repo.id}:${pull.number}`);
  }

  private decodeGlobalId(id: string): { kind: string; repoId: number; number: number } | null {
    try {
      const text = Buffer.from(id, 'base64').toString('utf8');
      const parts = text.split(':');
      if (parts.length < 2) return null;
      const kind = parts[0] as string;
      const repoId = Number.parseInt(parts[1] as string, 10);
      const number = parts.length >= 3 ? Number.parseInt(parts[2] as string, 10) : 0;
      if (!Number.isFinite(repoId)) return null;
      return { kind, repoId, number };
    } catch {
      return null;
    }
  }

  private findRepoById(id: string): Repo | null {
    const decoded = this.decodeGlobalId(id);
    if (!decoded || decoded.kind !== 'R') return null;
    for (const repo of this.forge.viewerRepos()) {
      if (repo.id === decoded.repoId) return repo;
    }
    return null;
  }

  private findIssueById(id: string): IssueRef | null {
    const decoded = this.decodeGlobalId(id);
    if (!decoded || decoded.kind !== 'I') return null;
    for (const repo of this.forge.viewerRepos()) {
      if (repo.id !== decoded.repoId) continue;
      const issue = repo.issues.find((entry) => entry.number === decoded.number);
      if (issue) return { repo, issue };
    }
    return null;
  }

  private findPullById(id: string): PullRef | null {
    const decoded = this.decodeGlobalId(id);
    if (!decoded || decoded.kind !== 'P') return null;
    for (const repo of this.forge.viewerRepos()) {
      if (repo.id !== decoded.repoId) continue;
      const pull = repo.pulls.find((entry) => entry.number === decoded.number);
      if (pull) return { repo, pull };
    }
    return null;
  }

  private select(
    parent: ResolvedValue,
    selections: SelectionNode[],
    variables: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'fragment') {
        const parentType = TYPE_NAMES[parent.kind] ?? '';
        const applies =
          selection.typeCondition === parentType ||
          (parent.kind === 'repo' && selection.typeCondition === 'Repository') ||
          (parent.kind === 'scalar' && false);
        if (!applies) continue;
        Object.assign(out, this.select(parent, selection.selection, variables));
        continue;
      }
      const field = selection.field;
      const key = field.alias ?? field.name;
      out[key] = this.resolveField(parent, field, variables);
    }
    return out;
  }

  private resolveField(parent: ResolvedValue, field: FieldNode, variables: Record<string, unknown>): unknown {
    const args = argsOf(field, variables);
    switch (parent.kind) {
      case 'viewer':
        return this.resolveUserField(parent, field, variables);
      case 'repo':
        return this.resolveRepoField(parent.repo, field, args, variables);
      case 'issue':
        return this.resolveIssueField(parent.ref, field, variables);
      case 'pull':
        return this.resolvePullField(parent.ref, field, args, variables);
      case 'issues':
        return this.resolveIssuesField(parent, field, variables);
      case 'pulls':
        return this.resolvePullsField(parent, field, variables);
      case 'files':
        return this.resolveFilesField(parent, field, variables);
      case 'user':
        return this.resolveUserField(parent, field, variables);
      case 'ref':
        if (field.name === 'name') return parent.name;
        this.fail(`Cannot query field "${field.name}" on type "Ref".`);
        return null;
      case 'pageInfo':
        if (field.name === 'hasNextPage') return parent.hasNextPage;
        if (field.name === 'endCursor') return parent.endCursor;
        this.fail(`Cannot query field "${field.name}" on type "PageInfo".`);
        return null;
      case 'type':
        return this.resolveTypeField(parent.name, field, variables);
      case 'payload':
        return this.resolvePayloadField(parent, field, variables);
      case 'commentEdge':
        if (field.name === 'node') {
          return this.select({ kind: 'comment', id: parent.id, body: parent.body }, field.selection, variables);
        }
        this.fail(`Cannot query field "${field.name}" on type "IssueCommentEdge".`);
        return null;
      case 'comment':
        if (field.name === 'id') return parent.id;
        if (field.name === 'body') return parent.body;
        this.fail(`Cannot query field "${field.name}" on type "IssueComment".`);
        return null;
      case 'scalar':
        this.fail(`Cannot query field "${field.name}" on type "String".`);
        return null;
    }
  }

  private resolveUserField(parent: { kind: 'viewer' } | { kind: 'user'; login: string }, field: FieldNode, variables: Record<string, unknown>): unknown {
    const login = parent.kind === 'viewer' ? this.forge.viewerLogin : parent.login;
    if (field.name === 'login') return login;
    if (field.name === 'id') return b64(`U:${login}`);
    if (field.name === 'name') return this.forge.viewerName;
    this.fail(`Cannot query field "${field.name}" on type "User".`);
    return null;
  }

  private resolveRepoField(repo: Repo, field: FieldNode, args: Record<string, unknown>, variables: Record<string, unknown>): unknown {
    switch (field.name) {
      case 'id':
        return this.globalRepoId(repo);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'description':
        return repo.description;
      case 'createdAt':
        return FIXED_ISO;
      case 'url':
        return `https://github.com/${repo.owner}/${repo.name}`;
      case 'owner':
        return this.select({ kind: 'user', login: repo.owner }, field.selection, variables);
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip === undefined) return null;
        return this.select({ kind: 'ref', name: repo.defaultBranch }, field.selection, variables);
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const number = args.number as number;
        const issue = repo.issues.find((entry) => entry.number === number);
        if (!issue) return null;
        return this.select({ kind: 'issue', ref: { repo, issue } }, field.selection, variables);
      }
      case 'issues': {
        let issues = [...repo.issues];
        const states = args.states as string[] | undefined;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((state) => String(state).toLowerCase()));
          issues = issues.filter((issue) => wanted.has(issue.state));
        }
        const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
        if (orderBy?.field === 'CREATED_AT') {
          issues.sort((a, b) => (orderBy.direction === 'ASC' ? a.number - b.number : b.number - a.number));
        } else {
          issues.sort((a, b) => a.number - b.number);
        }
        let startIndex = 0;
        if (typeof args.after === 'string' && args.after !== '') {
          try {
            const decoded = Buffer.from(args.after, 'base64').toString('utf8');
            const afterNumber = Number.parseInt(decoded.replace(/^cur:/, ''), 10);
            if (Number.isFinite(afterNumber)) {
              const index = issues.findIndex((issue) => issue.number === afterNumber);
              if (index >= 0) startIndex = index + 1;
            }
          } catch {
            // An unparsable cursor starts from the beginning.
          }
        }
        const first = typeof args.first === 'number' ? args.first : issues.length;
        const page = issues.slice(startIndex, startIndex + first);
        const hasNextPage = startIndex + page.length < issues.length;
        const endCursor = page.length > 0 ? b64(`cur:${page[page.length - 1]?.number}`) : null;
        return this.select(
          { kind: 'issues', repo, issues: page, endCursor, hasNextPage },
          field.selection,
          variables,
        );
      }
      case 'pullRequests': {
        let pulls = [...repo.pulls];
        pulls.sort((a, b) => b.number - a.number);
        const first = typeof args.first === 'number' ? args.first : pulls.length;
        return this.select({ kind: 'pulls', repo, pulls: pulls.slice(0, first) }, field.selection, variables);
      }
      case 'pullRequest': {
        const number = args.number as number;
        const pull = repo.pulls.find((entry) => entry.number === number);
        if (!pull) return null;
        return this.select({ kind: 'pull', ref: { repo, pull } }, field.selection, variables);
      }
      default:
        this.fail(`Cannot query field "${field.name}" on type "Repository".`);
        return null;
    }
  }

  private resolveIssueField(ref: IssueRef, field: FieldNode, variables: Record<string, unknown>): unknown {
    const { repo, issue } = ref;
    switch (field.name) {
      case 'id':
        return this.globalIssueId(repo, issue);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issue.state.toUpperCase();
      case 'createdAt':
        return issue.createdAt;
      case 'updatedAt':
        return issue.updatedAt;
      case 'url':
        return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
      default:
        this.fail(`Cannot query field "${field.name}" on type "Issue".`);
        return null;
    }
  }

  private resolvePullField(ref: PullRef, field: FieldNode, args: Record<string, unknown>, variables: Record<string, unknown>): unknown {
    const { repo, pull } = ref;
    switch (field.name) {
      case 'id':
        return this.globalPullId(repo, pull);
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
      case 'mergeable':
        return this.forge.pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'createdAt':
        return pull.createdAt;
      case 'url':
        return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'files': {
        const first = typeof args.first === 'number' ? args.first : 100;
        return this.select({ kind: 'files', repo, pull, first }, field.selection, variables);
      }
      default:
        this.fail(`Cannot query field "${field.name}" on type "PullRequest".`);
        return null;
    }
  }

  private resolveIssuesField(parent: Extract<ResolvedValue, { kind: 'issues' }>, field: FieldNode, variables: Record<string, unknown>): unknown {
    switch (field.name) {
      case 'nodes':
        return parent.issues.map((issue) => this.select({ kind: 'issue', ref: { repo: parent.repo, issue } }, field.selection, variables));
      case 'pageInfo':
        return this.select({ kind: 'pageInfo', hasNextPage: parent.hasNextPage, endCursor: parent.endCursor }, field.selection, variables);
      case 'totalCount':
        return parent.issues.length;
      default:
        this.fail(`Cannot query field "${field.name}" on type "IssueConnection".`);
        return null;
    }
  }

  private resolvePullsField(parent: Extract<ResolvedValue, { kind: 'pulls' }>, field: FieldNode, variables: Record<string, unknown>): unknown {
    switch (field.name) {
      case 'nodes':
        return parent.pulls.map((pull) => this.select({ kind: 'pull', ref: { repo: parent.repo, pull } }, field.selection, variables));
      case 'pageInfo':
        return this.select({ kind: 'pageInfo', hasNextPage: false, endCursor: null }, field.selection, variables);
      case 'totalCount':
        return parent.pulls.length;
      default:
        this.fail(`Cannot query field "${field.name}" on type "PullRequestConnection".`);
        return null;
    }
  }

  private resolveFilesField(parent: Extract<ResolvedValue, { kind: 'files' }>, field: FieldNode, variables: Record<string, unknown>): unknown {
    switch (field.name) {
      case 'nodes': {
        const files = this.forge.pullFiles(parent.repo, parent.pull).slice(0, parent.first);
        return files.map((file) => {
          const out: Record<string, unknown> = {};
          for (const selection of field.selection) {
            if (selection.kind !== 'field') continue;
            if (selection.field.name === 'path') out[selection.field.alias ?? 'path'] = file.filename;
            else if (selection.field.name === 'filename') out[selection.field.alias ?? 'filename'] = file.filename;
            else this.fail(`Cannot query field "${selection.field.name}" on type "PullRequestChangedFile".`);
          }
          return out;
        });
      }
      case 'totalCount':
        return this.forge.pullFiles(parent.repo, parent.pull).length;
      default:
        this.fail(`Cannot query field "${field.name}" on type "PullRequestChangedFileConnection".`);
        return null;
    }
  }

  private resolveTypeField(name: string, field: FieldNode, variables: Record<string, unknown>): unknown {
    if (field.name === 'name') return name;
    if (field.name === 'kind') return name === 'SearchType' ? 'ENUM' : 'OBJECT';
    if (field.name === 'fields') {
      const names = TYPE_FIELDS[name] ?? [];
      return names.map((fieldName) => ({ name: fieldName }));
    }
    if (field.name === 'enumValues') {
      if (name !== 'SearchType') return [];
      return SEARCH_TYPE_VALUES.map((value) => ({ name: value }));
    }
    this.fail(`Cannot query field "${field.name}" on type "__Type".`);
    return null;
  }

  private resolvePayloadField(parent: Extract<ResolvedValue, { kind: 'payload' }>, field: FieldNode, variables: Record<string, unknown>): unknown {
    const value = parent.fields[field.name];
    if (value === undefined) {
      this.fail(`Cannot query field "${field.name}" on type "Payload".`);
      return null;
    }
    if (field.selection.length === 0) return value;
    if (typeof value === 'object' && value !== null && 'kind' in (value as Record<string, unknown>)) {
      return this.select(value as ResolvedValue, field.selection, variables);
    }
    return value;
  }

  private executeOperation(operation: OperationNode, variables: Record<string, unknown>): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const selection of operation.selection) {
      if (selection.kind === 'fragment') continue;
      const field = selection.field;
      const key = field.alias ?? field.name;
      if (operation.type === 'query') {
        data[key] = this.resolveQueryField(field, variables);
      } else {
        data[key] = this.resolveMutationField(field, variables);
      }
    }
    return data;
  }

  private resolveQueryField(field: FieldNode, variables: Record<string, unknown>): unknown {
    const args = argsOf(field, variables);
    switch (field.name) {
      case 'viewer':
        return this.select({ kind: 'viewer' }, field.selection, variables);
      case 'repository': {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        if (owner !== this.forge.viewerLogin) return null;
        const repo = this.forge.getRepo(owner, name);
        if (!repo) return null;
        return this.select({ kind: 'repo', repo }, field.selection, variables);
      }
      case 'node': {
        const id = String(args.id ?? '');
        const repo = this.findRepoById(id);
        if (!repo) return null;
        return this.select({ kind: 'repo', repo }, field.selection, variables);
      }
      case '__type': {
        const name = String(args.name ?? '');
        if (!(name in TYPE_FIELDS) && name !== 'SearchType') return null;
        return this.select({ kind: 'type', name }, field.selection, variables);
      }
      case '__schema':
        this.fail('Cannot query field "__schema" on type "Query".');
        return null;
      default:
        this.fail(`Cannot query field "${field.name}" on type "Query".`);
        return null;
    }
  }

  private resolveMutationField(field: FieldNode, variables: Record<string, unknown>): unknown {
    const args = argsOf(field, variables);
    const input = (args.input ?? {}) as Record<string, unknown>;
    switch (field.name) {
      case 'createIssue': {
        const repo = this.findRepoById(String(input.repositoryId ?? ''));
        if (!repo) {
          this.fail('createIssue: repository not found');
          return null;
        }
        const issue = this.forge.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        return this.select(
          { kind: 'payload', fields: { issue: { kind: 'issue', ref: { repo, issue } } } },
          field.selection,
          variables,
        );
      }
      case 'closeIssue': {
        const ref = this.findIssueById(String(input.issueId ?? ''));
        if (!ref) {
          this.fail('closeIssue: issue not found');
          return null;
        }
        ref.issue.state = 'closed';
        ref.issue.updatedAt = FIXED_ISO;
        return this.select(
          { kind: 'payload', fields: { issue: { kind: 'issue', ref } } },
          field.selection,
          variables,
        );
      }
      case 'createPullRequest': {
        const repo = this.findRepoById(String(input.repositoryId ?? ''));
        if (!repo) {
          this.fail('createPullRequest: repository not found');
          return null;
        }
        const created = this.forge.createPull(
          repo,
          String(input.title ?? ''),
          String(input.body ?? ''),
          String(input.headRefName ?? ''),
          String(input.baseRefName ?? ''),
        );
        if ('error' in created) {
          this.fail(`createPullRequest: ${created.error}`);
          return null;
        }
        return this.select(
          { kind: 'payload', fields: { pullRequest: { kind: 'pull', ref: { repo, pull: created } } } },
          field.selection,
          variables,
        );
      }
      case 'mergePullRequest': {
        const ref = this.findPullById(String(input.pullRequestId ?? ''));
        if (!ref) {
          this.fail('mergePullRequest: pull request not found');
          return null;
        }
        const merged = this.forge.mergePull(ref.repo, ref.pull);
        if ('error' in merged) {
          this.fail(`mergePullRequest: ${merged.error}`);
          return null;
        }
        return this.select(
          { kind: 'payload', fields: { pullRequest: { kind: 'pull', ref } } },
          field.selection,
          variables,
        );
      }
      case 'addComment': {
        const ref = this.findIssueById(String(input.subjectId ?? ''));
        if (!ref) {
          this.fail('addComment: subject not found');
          return null;
        }
        const comment = {
          id: this.forge.nextGlobalId(),
          body: String(input.body ?? ''),
          userLogin: this.forge.viewerLogin,
          createdAt: FIXED_ISO,
        };
        ref.issue.comments.push(comment);
        const edge = { kind: 'commentEdge', id: b64(`C:${ref.repo.id}:${comment.id}`), body: comment.body } as const;
        return this.select(
          { kind: 'payload', fields: { commentEdge: edge } },
          field.selection,
          variables,
        );
      }
      default:
        this.fail(`Cannot query field "${field.name}" on type "Mutation".`);
        return null;
    }
  }

  execute(query: string, variables: Record<string, unknown>): { data: Record<string, unknown>; errors: { message: string }[] } {
    let operation: OperationNode;
    try {
      operation = parseDocument(query);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : 'failed to parse the document');
      return { data: {}, errors: this.errors };
    }
    const mergedVariables: Record<string, unknown> = { ...variables };
    for (const definition of operation.variables) {
      if (!(definition.name in mergedVariables) && definition.defaultValue !== null) {
        mergedVariables[definition.name] = resolveValue(definition.defaultValue, variables);
      }
    }
    const data = this.executeOperation(operation, mergedVariables);
    return { data, errors: this.errors };
  }
}

/**
 * Handle one POST /api/graphql request. Returns null when the path is not the GraphQL
 * endpoint. An unauthenticated request is exactly 401.
 */
export function handleGraphql(forge: Forge, ctx: { pathname: string; body: Buffer }, authorized: boolean): { status: number; body: string } | null {
  if (ctx.pathname !== '/api/graphql') return null;
  if (!authorized) {
    return { status: 401, body: `${JSON.stringify({ message: 'Requires authentication' })}\n` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8')) as unknown;
  } catch {
    return { status: 400, body: `${JSON.stringify({ errors: [{ message: 'Problems parsing JSON' }] })}\n` };
  }
  const operations = Array.isArray(parsed) ? parsed : [parsed];
  const results: unknown[] = [];
  for (const operation of operations) {
    if (typeof operation !== 'object' || operation === null) {
      results.push({ errors: [{ message: 'the operation is not an object' }] });
      continue;
    }
    const record = operation as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    const executor = new Executor(forge);
    const { data, errors } = executor.execute(query, variables);
    const result: Record<string, unknown> = { data };
    if (errors.length > 0) result.errors = errors;
    results.push(result);
  }
  const body = Array.isArray(parsed) ? results : (results[0] as unknown);
  return { status: 200, body: `${JSON.stringify(body)}\n` };
}
