// The forge's whole state: one in-memory store, no disk, no outside service. A repository
// holds git objects and refs plus the REST resources (issues, pull requests, labels,
// comments) that read the same branches and commits. Everything the suite creates through
// any surface lands here, so REST, GraphQL, MCP and git all read one truth.
//
// Determinism: no wall clock anywhere. Created/merged timestamps are one fixed instant, and
// commit timestamps come from a fixed epoch plus a per-repository counter, so two runs of
// the same request sequence build byte-identical objects.

import {
  ZERO_OID,
  buildCommit,
  buildTreeFromFiles,
  collectReachable,
  commitAncestors,
  flattenTree,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  type GitObject,
  type GitObjectType,
} from './gitcore.ts';

export const FIXED_ISO = '2025-01-01T00:00:00.000Z';
const COMMIT_EPOCH_SEC = 1_735_689_600;
export const DEFAULT_BRANCH = 'main';

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  comments: IssueComment[];
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: PullRequest[];
  nextNumber: number;
  commitSeq: number;
}

export class Forge {
  readonly viewerLogin: string;
  readonly viewerName: string;
  readonly viewerEmail: string;
  readonly token: string;
  private repos = new Map<string, Repo>();
  private repoSeq = 0;
  private globalIdSeq = 0;
  private requestSeq = 0;

  constructor(viewerLogin: string, viewerName: string, viewerEmail: string, token: string) {
    this.viewerLogin = viewerLogin;
    this.viewerName = viewerName;
    this.viewerEmail = viewerEmail;
    this.token = token;
  }

  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  nextGlobalId(): number {
    this.globalIdSeq += 1;
    return this.globalIdSeq;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  /** Every repository the viewer owns, in creation order. */
  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === this.viewerLogin) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  createRepo(name: string, options: { private?: boolean; description?: string }): Repo | { error: string } {
    if (typeof name !== 'string' || name === '' || name.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      return { error: 'name is invalid' };
    }
    if (this.repos.has(this.repoKey(this.viewerLogin, name))) {
      return { error: 'already exists' };
    }
    this.repoSeq += 1;
    const repo: Repo = {
      id: this.repoSeq,
      name,
      owner: this.viewerLogin,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.repoSeq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      commitSeq: 0,
    };
    this.repos.set(this.repoKey(this.viewerLogin, name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
  }

  // -----------------------------------------------------------------------------------------
  // git objects and refs
  // -----------------------------------------------------------------------------------------

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  defaultTip(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  /** The identity a commit built through the contents API carries. */
  private commitIdentity(): string {
    return `${this.viewerName} <${this.viewerEmail}>`;
  }

  /** A deterministic commit timestamp for this repository (fixed epoch + a counter). */
  private nextCommitTime(repo: Repo): number {
    repo.commitSeq += 1;
    return COMMIT_EPOCH_SEC + repo.commitSeq;
  }

  /**
   * Write `files` (path -> content bytes) onto `branch`, creating the branch from the default
   * branch tip when it does not exist yet. Returns the new commit id, or an error string.
   */
  commitFiles(
    repo: Repo,
    branch: string,
    files: ReadonlyMap<string, Buffer>,
    message: string,
  ): { commitSha: string } | { error: string } {
    let baseTip = this.branchTip(repo, branch);
    if (baseTip === undefined && branch !== repo.defaultBranch) {
      baseTip = this.defaultTip(repo);
    }
    const lookup = this.lookup(repo);
    const current = new Map<string, { oid: string; mode: string }>();
    if (baseTip !== undefined) {
      const commit = lookup(baseTip);
      if (!commit || commit.type !== 'commit') return { error: 'branch tip is not a commit' };
      const tree = parseCommit(commit.data).tree;
      for (const [path, entry] of flattenTree(tree, lookup)) current.set(path, entry);
    }
    for (const [path, content] of files) {
      const blobOid = this.putObject(repo, 'blob', content);
      current.set(path, { oid: blobOid, mode: '100644' });
    }
    const { treeOid, newObjects } = buildTreeFromFiles(current, lookup);
    for (const object of newObjects) repo.objects.set(hashObject(object.type, object.data), object);
    const timestamp = this.nextCommitTime(repo);
    const identity = this.commitIdentity();
    const commitData = buildCommit({
      tree: treeOid,
      parents: baseTip === undefined ? [] : [baseTip],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: identity,
      committer: identity,
      timestamp,
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha };
  }

  /**
   * Remove one file from `branch` (a contents DELETE). The file must exist at the branch tip.
   */
  deleteFile(repo: Repo, branch: string, path: string, message: string): { commitSha: string } | { error: string } {
    const tip = this.branchTip(repo, branch);
    if (tip === undefined) return { error: 'branch has no commits' };
    const lookup = this.lookup(repo);
    const commit = lookup(tip);
    if (!commit || commit.type !== 'commit') return { error: 'branch tip is not a commit' };
    const current = flattenTree(parseCommit(commit.data).tree, lookup);
    if (!current.has(path)) return { error: 'file does not exist' };
    current.delete(path);
    const { treeOid, newObjects } = buildTreeFromFiles(current, lookup);
    for (const object of newObjects) repo.objects.set(hashObject(object.type, object.data), object);
    const timestamp = this.nextCommitTime(repo);
    const identity = this.commitIdentity();
    const commitData = buildCommit({
      tree: treeOid,
      parents: [tip],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: identity,
      committer: identity,
      timestamp,
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha };
  }

  /** The blob id and decoded bytes of a file at a branch tip, or null when absent. */
  fileAt(repo: Repo, branch: string, path: string): { sha: string; content: Buffer } | null {
    const tip = this.branchTip(repo, branch);
    if (tip === undefined) return null;
    const lookup = this.lookup(repo);
    const commit = lookup(tip);
    if (!commit || commit.type !== 'commit') return null;
    const entry = flattenTree(parseCommit(commit.data).tree, lookup).get(path);
    if (!entry) return null;
    const blob = lookup(entry.oid);
    if (!blob || blob.type !== 'blob') return null;
    return { sha: entry.oid, content: blob.data };
  }

  /** The immediate children of a directory at a branch tip (files and subdirectories). */
  dirAt(repo: Repo, branch: string, dirPath: string): { name: string; path: string; sha: string; type: 'file' | 'dir' }[] | null {
    const tip = this.branchTip(repo, branch);
    if (tip === undefined) return null;
    const lookup = this.lookup(repo);
    const commit = lookup(tip);
    if (!commit || commit.type !== 'commit') return null;
    const files = flattenTree(parseCommit(commit.data).tree, lookup);
    const prefix = dirPath === '' ? '' : `${dirPath}/`;
    const children = new Map<string, { name: string; path: string; sha: string; type: 'file' | 'dir' }>();
    for (const [path, entry] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest === '') continue;
      const slash = rest.indexOf('/');
      if (slash < 0) {
        children.set(rest, { name: rest, path, sha: entry.oid, type: 'file' });
      } else {
        const dirName = rest.slice(0, slash);
        if (!children.has(dirName)) {
          // The directory's own tree id, for a stable sha: recompute from its entries.
          const sub = new Map<string, { oid: string; mode: string }>();
          for (const [p, e] of files) {
            if (p.startsWith(`${prefix}${dirName}/`)) {
              sub.set(p.slice(prefix.length + dirName.length + 1), e);
            }
          }
          const { treeOid } = buildTreeFromFiles(sub, lookup);
          children.set(dirName, { name: dirName, path: `${prefix}${dirName}`, sha: treeOid, type: 'dir' });
        }
      }
    }
    return children.size === 0
      ? null
      : [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** Commits reachable from `ref`, newest first (parents after children). */
  commitsFrom(repo: Repo, ref: string): { sha: string; message: string; parents: string[] }[] {
    const tip = ref.startsWith('refs/') ? repo.refs.get(ref) : this.branchTip(repo, ref);
    if (tip === undefined) return [];
    const lookup = this.lookup(repo);
    const out: { sha: string; message: string; parents: string[] }[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      // The stored commit text ends with a newline; the API reports the message
      // as the caller wrote it, without that trailing newline.
      out.push({ sha: oid, message: commit.message.replace(/\n$/, ''), parents: commit.parents });
      for (const parent of commit.parents) queue.push(parent);
    }
    return out;
  }

  // -----------------------------------------------------------------------------------------
  // issues and pull requests
  // -----------------------------------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue: Issue = {
      id: this.nextGlobalId(),
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      userLogin: this.viewerLogin,
      createdAt: FIXED_ISO,
      updatedAt: FIXED_ISO,
      comments: [],
    };
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): PullRequest | { error: string } {
    const headSha = this.branchTip(repo, head);
    const baseSha = this.branchTip(repo, base);
    if (headSha === undefined || baseSha === undefined) return { error: 'head or base branch does not exist' };
    for (const existing of repo.pulls) {
      if (existing.state === 'open' && existing.headRef === head) return { error: 'a pull request is already open for this head' };
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pull: PullRequest = {
      id: this.nextGlobalId(),
      number,
      title,
      body,
      state: 'open',
      merged: false,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      userLogin: this.viewerLogin,
      createdAt: FIXED_ISO,
      updatedAt: FIXED_ISO,
      mergedAt: null,
      mergeCommitSha: null,
    };
    repo.pulls.push(pull);
    return pull;
  }

  /** Whether merging `pull` would conflict: a path changed on both sides with different results. */
  pullConflicts(repo: Repo, pull: PullRequest): boolean {
    const lookup = this.lookup(repo);
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === undefined || baseTip === undefined) return true;
    const base = mergeBase(headTip, baseTip, lookup);
    if (base === null) return false;
    const baseCommit = lookup(base);
    if (!baseCommit || baseCommit.type !== 'commit') return false;
    const ancestorFiles = flattenTree(parseCommit(baseCommit.data).tree, lookup);
    const headCommit = lookup(headTip);
    const baseTipCommit = lookup(baseTip);
    if (!headCommit || !baseTipCommit || headCommit.type !== 'commit' || baseTipCommit.type !== 'commit') return false;
    const headFiles = flattenTree(parseCommit(headCommit.data).tree, lookup);
    const baseFiles = flattenTree(parseCommit(baseTipCommit.data).tree, lookup);
    for (const [path, headEntry] of headFiles) {
      const ancestorEntry = ancestorFiles.get(path);
      const ancestorOid = ancestorEntry?.oid ?? null;
      if (headEntry.oid === ancestorOid) continue;
      const baseEntry = baseFiles.get(path);
      const baseOid = baseEntry?.oid ?? null;
      if (baseOid === ancestorOid) continue;
      if (headEntry.oid !== baseOid) return true;
    }
    for (const [path] of ancestorFiles) {
      if (!headFiles.has(path)) {
        const baseEntry = baseFiles.get(path);
        if (baseEntry !== undefined) return true;
      }
    }
    return false;
  }

  /** Squash-merge `pull` onto its base branch. Returns the merge commit id, or an error. */
  mergePull(repo: Repo, pull: PullRequest): { sha: string } | { error: string } {
    if (pull.state !== 'open') return { error: 'pull request is not open' };
    if (this.pullConflicts(repo, pull)) return { error: 'conflict' };
    const lookup = this.lookup(repo);
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === undefined || baseTip === undefined) return { error: 'head or base branch is missing' };
    const headCommit = lookup(headTip);
    const baseCommit = lookup(baseTip);
    if (!headCommit || !baseCommit || headCommit.type !== 'commit' || baseCommit.type !== 'commit') {
      return { error: 'head or base is not a commit' };
    }
    const base = mergeBase(headTip, baseTip, lookup);
    const ancestorFiles = new Map<string, { oid: string; mode: string }>();
    if (base !== null) {
      const baseAncestor = lookup(base);
      if (baseAncestor && baseAncestor.type === 'commit') {
        for (const [path, entry] of flattenTree(parseCommit(baseAncestor.data).tree, lookup)) {
          ancestorFiles.set(path, entry);
        }
      }
    }
    const headFiles = flattenTree(parseCommit(headCommit.data).tree, lookup);
    const baseFiles = flattenTree(parseCommit(baseCommit.data).tree, lookup);
    const mergedFiles = new Map(baseFiles);
    for (const [path, entry] of headFiles) {
      if (entry.oid !== ancestorFiles.get(path)?.oid) mergedFiles.set(path, entry);
    }
    for (const [path] of ancestorFiles) {
      if (!headFiles.has(path)) mergedFiles.delete(path);
    }
    const { treeOid, newObjects } = buildTreeFromFiles(mergedFiles, lookup);
    for (const object of newObjects) repo.objects.set(hashObject(object.type, object.data), object);
    const timestamp = this.nextCommitTime(repo);
    const identity = this.commitIdentity();
    const message = `${pull.title} (#${pull.number})\n`;
    const commitData = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      message,
      author: identity,
      committer: identity,
      timestamp,
    });
    const sha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_ISO;
    pull.mergeCommitSha = sha;
    pull.updatedAt = FIXED_ISO;
    return { sha };
  }

  /** The changed files of a pull request (merge base vs head), with line counts. */
  pullFiles(repo: Repo, pull: PullRequest): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const lookup = this.lookup(repo);
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === undefined || baseTip === undefined) return [];
    const base = mergeBase(headTip, baseTip, lookup);
    const ancestorFiles = new Map<string, { oid: string; mode: string }>();
    if (base !== null) {
      const ancestor = lookup(base);
      if (ancestor && ancestor.type === 'commit') {
        for (const [path, entry] of flattenTree(parseCommit(ancestor.data).tree, lookup)) ancestorFiles.set(path, entry);
      }
    }
    const headCommit = lookup(headTip);
    if (!headCommit || headCommit.type !== 'commit') return [];
    const headFiles = flattenTree(parseCommit(headCommit.data).tree, lookup);
    const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
    const countLines = (data: Buffer): string[] => {
      const text = data.toString('utf8');
      if (text === '') return [];
      const lines = text.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      return lines;
    };
    for (const [path, headEntry] of headFiles) {
      const ancestorEntry = ancestorFiles.get(path);
      if (ancestorEntry && ancestorEntry.oid === headEntry.oid) continue;
      const headBlob = lookup(headEntry.oid);
      const headLines = headBlob && headBlob.type === 'blob' ? countLines(headBlob.data) : [];
      let additions = headLines.length;
      let deletions = 0;
      let status = 'added';
      if (ancestorEntry) {
        status = 'modified';
        const ancestorBlob = lookup(ancestorEntry.oid);
        const ancestorLines = ancestorBlob && ancestorBlob.type === 'blob' ? countLines(ancestorBlob.data) : [];
        const ancestorSet = new Map<string, number>();
        for (const line of ancestorLines) ancestorSet.set(line, (ancestorSet.get(line) ?? 0) + 1);
        additions = 0;
        for (const line of headLines) {
          const remaining = ancestorSet.get(line) ?? 0;
          if (remaining > 0) ancestorSet.set(line, remaining - 1);
          else additions += 1;
        }
        deletions = [...ancestorSet.values()].reduce((sum, n) => sum + n, 0);
      }
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    for (const [path] of ancestorFiles) {
      if (headFiles.has(path)) continue;
      const ancestorEntry = ancestorFiles.get(path) as { oid: string; mode: string };
      const ancestorBlob = lookup(ancestorEntry.oid);
      const ancestorLines = ancestorBlob && ancestorBlob.type === 'blob' ? countLines(ancestorBlob.data) : [];
      out.push({ filename: path, status: 'removed', additions: 0, deletions: ancestorLines.length, changes: ancestorLines.length });
    }
    out.sort((a, b) => (a.filename < b.filename ? -1 : 1));
    return out;
  }

  // -----------------------------------------------------------------------------------------
  // git smart HTTP: fetch and push
  // -----------------------------------------------------------------------------------------

  /**
   * The objects a fetch of `wants` must deliver, given the client's `haves` and the shallow
   * boundary it already holds. `depth` limits generations from the wants (1 = the tips only).
   * Returns the object ids to send, the new shallow boundary, and the old boundary commits
   * that are no longer shallow (their parents are now delivered).
   */
  fetchPlan(
    repo: Repo,
    wants: readonly string[],
    haves: readonly string[],
    shallowHeld: readonly string[],
    depth: number | undefined,
  ): { send: Set<string>; shallow: string[]; unshallow: string[] } {
    const lookup = this.lookup(repo);
    const heldBoundary = new Set(shallowHeld);
    // What the client already holds: reachable from the haves, stopping at the shallow
    // boundary (a shallow commit's parents are not held).
    const held = collectReachable(haves, lookup, { allowMissing: true, stopAt: heldBoundary });
    // What the wants reach, limited to `depth` generations of commits when asked.
    const wanted = new Set<string>();
    if (depth === undefined) {
      for (const oid of collectReachable(wants, lookup, { allowMissing: true })) wanted.add(oid);
    } else {
      // Walk commits by generation from the wants; a commit at generation >= depth is
      // not included, and its children mark the new shallow boundary.
      const queue: { oid: string; generation: number }[] = wants.map((oid) => ({ oid, generation: 0 }));
      const seen = new Set<string>();
      while (queue.length) {
        const { oid, generation } = queue.shift() as { oid: string; generation: number };
        if (seen.has(oid)) continue;
        seen.add(oid);
        const object = lookup(oid);
        if (!object) continue;
        if (object.type === 'commit') {
          if (generation >= depth) continue;
          wanted.add(oid);
          const commit = parseCommit(object.data);
          for (const parent of commit.parents) queue.push({ oid: parent, generation: generation + 1 });
        } else if (object.type === 'tag') {
          wanted.add(oid);
          queue.push({ oid: parseTag(object.data).object, generation });
        }
      }
      // The full tree closure (every tree and blob) under each wanted commit or tag.
      for (const oid of [...wanted]) {
        const object = lookup(oid);
        if (!object) continue;
        if (object.type === 'commit') {
          const commit = parseCommit(object.data);
          for (const reached of collectReachable([commit.tree], lookup, { allowMissing: true })) wanted.add(reached);
        } else if (object.type === 'tag') {
          const tag = parseTag(object.data);
          if (tag.type === 'tree') {
            for (const reached of collectReachable([tag.object], lookup, { allowMissing: true })) wanted.add(reached);
          }
        }
      }
    }
    const send = new Set<string>();
    for (const oid of wanted) if (!held.has(oid)) send.add(oid);
    // The new shallow boundary: wanted commits whose parents were cut off by the depth limit.
    const shallow: string[] = [];
    const unshallow: string[] = [];
    if (depth !== undefined) {
      for (const oid of wanted) {
        const object = lookup(oid);
        if (!object || object.type !== 'commit') continue;
        const commit = parseCommit(object.data);
        if (commit.parents.length > 0 && commit.parents.some((parent) => !wanted.has(parent))) {
          shallow.push(oid);
        }
      }
      for (const boundary of heldBoundary) {
        if (!shallow.includes(boundary) && wanted.has(boundary)) {
          const object = lookup(boundary);
          if (object && object.type === 'commit') {
            const commit = parseCommit(object.data);
            if (commit.parents.every((parent) => wanted.has(parent))) unshallow.push(boundary);
          }
        }
      }
    }
    return { send, shallow, unshallow };
  }

  /** Build a packfile of the given object ids, in a stable order. */
  buildPack(repo: Repo, oids: Iterable<string>): Buffer {
    const objects: GitObject[] = [];
    const sorted = [...oids].sort();
    for (const oid of sorted) {
      const object = repo.objects.get(oid);
      if (object) objects.push(object);
    }
    return writePack(objects);
  }

  /**
   * Apply a receive-pack: store the pack's objects, then apply each ref command. Returns the
   * per-ref verdicts in command order.
   */
  applyPush(
    repo: Repo,
    commands: readonly { oldOid: string; newOid: string; ref: string }[],
    pack: Uint8Array | null,
  ): { unpackOk: boolean; unpackDetail: string; refs: { ref: string; ok: boolean; reason: string }[] } {
    const lookup = this.lookup(repo);
    if (pack !== null && pack.length > 0) {
      try {
        const { objects } = readPack(pack, { resolveBase: lookup });
        for (const [oid, object] of objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (err) {
        return {
          unpackOk: false,
          unpackDetail: err instanceof Error ? err.message : 'pack parse failed',
          refs: commands.map((command) => ({ ref: command.ref, ok: false, reason: 'unpack failed' })),
        };
      }
    }
    const verdicts: { ref: string; ok: boolean; reason: string }[] = [];
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          verdicts.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          verdicts.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          repo.refs.delete(command.ref);
          verdicts.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      const target = lookup(command.newOid);
      if (!target) {
        verdicts.push({ ref: command.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          verdicts.push({ ref: command.ref, ok: false, reason: 'already exists' });
        } else {
          repo.refs.set(command.ref, command.newOid);
          verdicts.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (current === undefined) {
        verdicts.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
        continue;
      }
      if (command.oldOid !== current) {
        verdicts.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      const isTag = command.ref.startsWith('refs/tags/');
      if (!isTag && target.type === 'commit' && !isAncestor(current, command.newOid, lookup)) {
        verdicts.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      verdicts.push({ ref: command.ref, ok: true, reason: '' });
    }
    return { unpackOk: true, unpackDetail: 'ok', refs: verdicts };
  }

  /** The peeled commit of an annotated tag, or null when the object is not a tag. */
  peeledTarget(repo: Repo, oid: string): string | null {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tag') return null;
    try {
      const tag = parseTag(object.data);
      if (tag.type !== 'commit') return null;
      return tag.object;
    } catch {
      return null;
    }
  }
}

/** Sort refs the way an advertisement lists them: HEAD first is handled by the caller. */
export function sortRefNames(names: readonly string[]): string[] {
  return [...names].sort();
}

export function refNamesOf(repo: Repo): string[] {
  return sortRefNames([...repo.refs.keys()]);
}
