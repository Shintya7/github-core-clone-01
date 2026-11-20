// GitHub REST v3, under /api/v3: repositories, branches, commits, contents, labels,
// issues, comments and pull requests. Every reply is JSON with a non-empty
// X-GitHub-Request-Id; errors are JSON with a string message; unknown routes are 404.

import { FIXED_ISO, type Forge, type Issue, type PullRequest, type Repo } from './store.ts';
import { isObjectId } from './gitcore.ts';

export interface HttpContext {
  readonly method: string;
  readonly pathname: string;
  readonly query: URLSearchParams;
  readonly headers: Record<string, string | undefined>;
  readonly body: Buffer;
}

export interface HttpResult {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };

export function jsonResult(status: number, body: unknown, extra: Record<string, string> = {}): HttpResult {
  return { status, headers: { ...JSON_HEADERS, ...extra }, body: `${JSON.stringify(body)}\n` };
}

function errorResult(status: number, message: string): HttpResult {
  return jsonResult(status, { message });
}

function notFound(message = 'Not Found'): HttpResult {
  return errorResult(404, message);
}

/** The bearer token on the request, or null when the header is absent or malformed. */
export function bearerToken(ctx: HttpContext): string | null {
  const header = ctx.headers.authorization ?? ctx.headers.Authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  return match ? (match[1] as string) : null;
}

/** Parse a JSON request body; on failure, the 400 result to answer with. */
export function parseJsonBody(ctx: HttpContext): { value: unknown } | { error: HttpResult } {
  if (ctx.body.length === 0) return { value: {} };
  try {
    return { value: JSON.parse(ctx.body.toString('utf8')) as unknown };
  } catch {
    return { error: errorResult(400, 'Problems parsing JSON') };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, field: string): string {
  const item = value[field];
  return typeof item === 'string' ? item : '';
}

function boolField(value: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const item = value[field];
  return typeof item === 'boolean' ? item : fallback;
}

function queryInt(ctx: HttpContext, name: string, fallback: number): number {
  const raw = ctx.query.get(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function pageOf<T>(items: readonly T[], ctx: HttpContext): { page: T[]; total: number; pageNumber: number; perPage: number } {
  const perPage = queryInt(ctx, 'per_page', 30);
  const pageNumber = queryInt(ctx, 'page', 1);
  const start = (pageNumber - 1) * perPage;
  return { page: items.slice(start, start + perPage), total: items.length, pageNumber, perPage };
}

function repoObject(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: b64(`R:${repo.id}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

export function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: b64(`I:${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: issue.userLogin, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullObject(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: b64(`P:${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: true,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: { login: repo.owner },
      repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: { login: repo.owner },
      repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    user: { login: pull.userLogin, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** Split a /api/v3 path into its decoded segments. */
function segmentsOf(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

/**
 * Handle one REST request. `authorized` is true when the bearer token matched the trial
 * token (or any non-empty token when the trial set none); unauthenticated requests are 401.
 * A repository under any owner other than the token's login is 404, never 403.
 */
export async function handleRest(forge: Forge, ctx: HttpContext, authorized: boolean): Promise<HttpResult | null> {
  if (!ctx.pathname.startsWith('/api/v3')) return null;
  if (!authorized) return errorResult(401, 'Requires authentication');

  const segments = segmentsOf(ctx.pathname.replace(/^\/api\/v3/, '') || '/');

  // GET /api/v3/ — the API root.
  if (ctx.method === 'GET' && segments.length === 0) {
    return jsonResult(
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  // GET /api/v3/meta
  if (ctx.method === 'GET' && segments.length === 1 && segments[0] === 'meta') {
    return jsonResult(200, { verifiable_password_authentication: true, installed_version: '1.0.0' });
  }

  // GET /api/v3/user
  if (ctx.method === 'GET' && segments.length === 1 && segments[0] === 'user') {
    return jsonResult(200, {
      login: forge.viewerLogin,
      id: 1000,
      name: forge.viewerName,
      email: forge.viewerEmail,
      type: 'User',
    });
  }

  // POST /api/v3/user/repos and GET /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (ctx.method === 'POST') {
      const parsed = parseJsonBody(ctx);
      if ('error' in parsed) return parsed.error;
      if (!isRecord(parsed.value)) return errorResult(400, 'Problems parsing JSON');
      const name = stringField(parsed.value, 'name');
      const created = forge.createRepo(name, {
        private: boolField(parsed.value, 'private', false),
        description: stringField(parsed.value, 'description'),
      });
      if ('error' in created) {
        if (created.error === 'already exists') return errorResult(422, 'Repository already exists');
        return errorResult(422, created.error);
      }
      return jsonResult(201, repoObject(forge, created));
    }
    if (ctx.method === 'GET') {
      const all = forge.viewerRepos();
      const { page, total, pageNumber, perPage } = pageOf(all, ctx);
      const headers: Record<string, string> = {};
      if ((pageNumber - 1) * perPage + page.length < total) {
        const host = ctx.headers.host ?? 'localhost';
        const proto = 'http';
        const next = `${proto}://${host}/api/v3/user/repos?per_page=${perPage}&page=${pageNumber + 1}`;
        headers.link = `<${next}>; rel="next"`;
      }
      return jsonResult(200, page.map((repo) => repoObject(forge, repo)), headers);
    }
    return errorResult(405, 'Method Not Allowed');
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    if (owner !== forge.viewerLogin) return notFound('Not Found');
    const repo = forge.getRepo(owner, name);
    const rest = segments.slice(3);

    if (rest.length === 0) {
      if (ctx.method === 'GET') {
        if (!repo) return notFound('Not Found');
        return jsonResult(200, repoObject(forge, repo));
      }
      if (ctx.method === 'PATCH') {
        if (!repo) return notFound('Not Found');
        const parsed = parseJsonBody(ctx);
        if ('error' in parsed) return parsed.error;
        if (isRecord(parsed.value)) {
          const description = parsed.value.description;
          if (typeof description === 'string') repo.description = description;
        }
        return jsonResult(200, repoObject(forge, repo));
      }
      if (ctx.method === 'DELETE') {
        if (!repo) return notFound('Not Found');
        forge.deleteRepo(repo);
        return { status: 204, headers: {}, body: '' };
      }
      return errorResult(405, 'Method Not Allowed');
    }

    if (!repo) return notFound('Not Found');

    // GET /repos/{o}/{r}/branches and GET /repos/{o}/{r}/branches/{branch}
    if (rest[0] === 'branches') {
      if (ctx.method === 'GET' && rest.length === 1) {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ref.slice('refs/heads/'.length))
          .sort()
          .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`) }, protected: false }));
        return jsonResult(200, branches);
      }
      if (ctx.method === 'GET' && rest.length === 2) {
        const branch = rest[1] as string;
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) return notFound('Not Found');
        return jsonResult(200, { name: branch, commit: { sha }, protected: false });
      }
      return notFound('Not Found');
    }

    // GET /repos/{o}/{r}/git/refs[/heads/{branch}] and POST /repos/{o}/{r}/git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (ctx.method === 'GET' && rest.length >= 3) {
        const refName = rest.slice(2).join('/');
        const sha = repo.refs.get(refName);
        if (sha === undefined) return notFound('Not Found');
        return jsonResult(200, { ref: refName, object: { sha, type: 'commit' }, url: `/api/v3/repos/${owner}/${name}/git/refs/${refName}` });
      }
      if (ctx.method === 'POST' && rest.length === 2) {
        const parsed = parseJsonBody(ctx);
        if ('error' in parsed) return parsed.error;
        if (!isRecord(parsed.value)) return errorResult(400, 'Problems parsing JSON');
        const ref = stringField(parsed.value, 'ref');
        const sha = stringField(parsed.value, 'sha');
        if (!ref.startsWith('refs/heads/') || !isObjectId(sha)) return errorResult(422, 'Invalid ref or sha');
        if (repo.refs.has(ref)) return errorResult(422, 'Reference already exists');
        if (!repo.objects.has(sha)) return errorResult(422, 'Object does not exist');
        repo.refs.set(ref, sha);
        return jsonResult(201, { ref, object: { sha, type: 'commit' }, url: `/api/v3/repos/${owner}/${name}/git/refs/${ref}` });
      }
      return notFound('Not Found');
    }

    // GET /repos/{o}/{r}/commits[?sha=]
    if (rest[0] === 'commits' && rest.length === 1 && ctx.method === 'GET') {
      const ref = ctx.query.get('sha') ?? repo.defaultBranch;
      const commits = forge.commitsFrom(repo, ref);
      return jsonResult(
        200,
        commits.map((commit) => ({
          sha: commit.sha,
          commit: {
            message: commit.message,
            author: { name: forge.viewerName, email: forge.viewerEmail, date: FIXED_ISO },
            committer: { name: forge.viewerName, email: forge.viewerEmail, date: FIXED_ISO },
          },
          parents: commit.parents.map((parent) => ({ sha: parent })),
        })),
      );
    }

    // /repos/{o}/{r}/contents/{path...}
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      if (filePath === '') return notFound('Not Found');
      if (ctx.method === 'GET') {
        const ref = ctx.query.get('ref') ?? repo.defaultBranch;
        const file = forge.fileAt(repo, ref, filePath);
        if (file) {
          return jsonResult(200, {
            type: 'file',
            encoding: 'base64',
            size: file.content.length,
            name: filePath.split('/').pop(),
            path: filePath,
            content: file.content.toString('base64'),
            sha: file.sha,
          });
        }
        const dir = forge.dirAt(repo, ref, filePath);
        if (dir !== null) {
          return jsonResult(
            200,
            dir.map((entry) => ({ type: entry.type, name: entry.name, path: entry.path, sha: entry.sha, size: 0 })),
          );
        }
        return notFound('Not Found');
      }
      if (ctx.method === 'PUT') {
        const parsed = parseJsonBody(ctx);
        if ('error' in parsed) return parsed.error;
        if (!isRecord(parsed.value)) return errorResult(400, 'Problems parsing JSON');
        const message = stringField(parsed.value, 'message') || 'Update file';
        const contentB64 = stringField(parsed.value, 'content');
        if (contentB64 === '') return errorResult(422, 'content is required');
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          return errorResult(422, 'content is not valid base64');
        }
        const branch = stringField(parsed.value, 'branch') || repo.defaultBranch;
        const sha = stringField(parsed.value, 'sha');
        const existing = forge.fileAt(repo, branch, filePath);
        if (existing) {
          if (sha === '' || sha.toLowerCase() !== existing.sha.toLowerCase()) {
            return errorResult(409, 'sha does not match the current file');
          }
        }
        const committed = forge.commitFiles(repo, branch, new Map([[filePath, content]]), message);
        if ('error' in committed) return errorResult(422, committed.error);
        const blobSha = forge.fileAt(repo, branch, filePath)?.sha ?? '';
        return jsonResult(existing ? 200 : 201, {
          content: { name: filePath.split('/').pop(), path: filePath, sha: blobSha, size: content.length, type: 'file', encoding: 'base64', content: contentB64 },
          commit: { sha: committed.commitSha, message },
        });
      }
      if (ctx.method === 'DELETE') {
        const parsed = parseJsonBody(ctx);
        if ('error' in parsed) return parsed.error;
        const branch = isRecord(parsed.value) ? stringField(parsed.value, 'branch') || repo.defaultBranch : repo.defaultBranch;
        const message = isRecord(parsed.value) ? stringField(parsed.value, 'message') || 'Delete file' : 'Delete file';
        const existing = forge.fileAt(repo, branch, filePath);
        if (!existing) return notFound('Not Found');
        const deleted = forge.deleteFile(repo, branch, filePath, message);
        if ('error' in deleted) return errorResult(422, deleted.error);
        return jsonResult(200, { commit: { sha: deleted.commitSha, message } });
      }
      return errorResult(405, 'Method Not Allowed');
    }

    // POST /repos/{o}/{r}/labels
    if (rest[0] === 'labels' && rest.length === 1) {
      if (ctx.method === 'POST') {
        const parsed = parseJsonBody(ctx);
        if ('error' in parsed) return parsed.error;
        if (!isRecord(parsed.value)) return errorResult(400, 'Problems parsing JSON');
        const name = stringField(parsed.value, 'name');
        if (name === '') return errorResult(422, 'name is required');
        const color = stringField(parsed.value, 'color') || 'ededed';
        const label = { name, color };
        repo.labels.set(name, label);
        return jsonResult(201, { name, color });
      }
      if (ctx.method === 'GET') {
        return jsonResult(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
      }
      return errorResult(405, 'Method Not Allowed');
    }

    // /repos/{o}/{r}/issues[/{n}[/comments]]
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (ctx.method === 'POST') {
          const parsed = parseJsonBody(ctx);
          if ('error' in parsed) return parsed.error;
          if (!isRecord(parsed.value)) return errorResult(400, 'Problems parsing JSON');
          const title = stringField(parsed.value, 'title');
          const body = stringField(parsed.value, 'body');
          const labelNames = Array.isArray(parsed.value.labels) ? parsed.value.labels : [];
          const labels: { name: string; color: string }[] = [];
          for (const labelName of labelNames) {
            if (typeof labelName !== 'string') continue;
            const label = repo.labels.get(labelName);
            if (!label) return errorResult(422, `Label "${labelName}" does not exist`);
            labels.push(label);
          }
          const issue = forge.createIssue(repo, title, body, labels);
          return jsonResult(201, issueObject(repo, issue));
        }
        if (ctx.method === 'GET') {
          let issues = [...repo.issues];
          const state = ctx.query.get('state') ?? 'open';
          if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
          const sort = ctx.query.get('sort') ?? 'created';
          const direction = ctx.query.get('direction') ?? 'desc';
          if (sort === 'created') {
            issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          }
          const { page } = pageOf(issues, ctx);
          return jsonResult(200, page.map((issue) => issueObject(repo, issue)));
        }
        return errorResult(405, 'Method Not Allowed');
      }
      const number = Number.parseInt(rest[1] as string, 10);
      const issue = repo.issues.find((entry) => entry.number === number);
      if (rest.length === 2) {
        if (!issue) return notFound('Not Found');
        if (ctx.method === 'GET') return jsonResult(200, issueObject(repo, issue));
        if (ctx.method === 'PATCH') {
          const parsed = parseJsonBody(ctx);
          if ('error' in parsed) return parsed.error;
          if (isRecord(parsed.value)) {
            const state = parsed.value.state;
            if (state === 'open' || state === 'closed') issue.state = state;
            const title = parsed.value.title;
            if (typeof title === 'string') issue.title = title;
            const body = parsed.value.body;
            if (typeof body === 'string') issue.body = body;
          }
          issue.updatedAt = FIXED_ISO;
          return jsonResult(200, issueObject(repo, issue));
        }
        return errorResult(405, 'Method Not Allowed');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) return notFound('Not Found');
        if (ctx.method === 'POST') {
          const parsed = parseJsonBody(ctx);
          if ('error' in parsed) return parsed.error;
          const body = isRecord(parsed.value) ? stringField(parsed.value, 'body') : '';
          const comment = {
            id: forge.nextGlobalId(),
            body,
            userLogin: forge.viewerLogin,
            createdAt: FIXED_ISO,
          };
          issue.comments.push(comment);
          return jsonResult(201, { id: comment.id, body: comment.body, user: { login: comment.userLogin }, created_at: comment.createdAt });
        }
        if (ctx.method === 'GET') {
          return jsonResult(
            200,
            issue.comments.map((comment) => ({ id: comment.id, body: comment.body, user: { login: comment.userLogin }, created_at: comment.createdAt })),
          );
        }
        return errorResult(405, 'Method Not Allowed');
      }
      return notFound('Not Found');
    }

    // /repos/{o}/{r}/pulls[/{n}[/merge|/files]]
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (ctx.method === 'POST') {
          const parsed = parseJsonBody(ctx);
          if ('error' in parsed) return parsed.error;
          if (!isRecord(parsed.value)) return errorResult(400, 'Problems parsing JSON');
          const title = stringField(parsed.value, 'title');
          const body = stringField(parsed.value, 'body');
          const head = stringField(parsed.value, 'head');
          const base = stringField(parsed.value, 'base') || repo.defaultBranch;
          const created = forge.createPull(repo, title, body, head, base);
          if ('error' in created) return errorResult(422, created.error);
          return jsonResult(201, pullObject(repo, created));
        }
        if (ctx.method === 'GET') {
          let pulls = [...repo.pulls];
          const state = ctx.query.get('state') ?? 'open';
          if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
          pulls.sort((a, b) => b.number - a.number);
          const { page } = pageOf(pulls, ctx);
          return jsonResult(200, page.map((pull) => pullObject(repo, pull)));
        }
        return errorResult(405, 'Method Not Allowed');
      }
      const number = Number.parseInt(rest[1] as string, 10);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (rest.length === 2) {
        if (!pull) return notFound('Not Found');
        if (ctx.method === 'GET') return jsonResult(200, pullObject(repo, pull));
        return errorResult(405, 'Method Not Allowed');
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (!pull) return notFound('Not Found');
        if (ctx.method === 'GET') return jsonResult(200, forge.pullFiles(repo, pull));
        return errorResult(405, 'Method Not Allowed');
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (!pull) return notFound('Not Found');
        if (ctx.method === 'PUT') {
          const merged = forge.mergePull(repo, pull);
          if ('error' in merged) {
            if (merged.error === 'conflict') return errorResult(405, 'Merge conflict');
            return errorResult(422, merged.error);
          }
          return jsonResult(200, { sha: merged.sha, merged: true, message: `Pull request #${pull.number} merged` });
        }
        return errorResult(405, 'Method Not Allowed');
      }
      return notFound('Not Found');
    }

    return notFound('Not Found');
  }

  return notFound('Not Found');
}
