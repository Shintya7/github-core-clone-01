// Git smart HTTP at /{owner}/{repo}.git: ref advertisements (v0 with the "# service=..."
// preamble, v2 with "version 2"), protocol v2 ls-refs and fetch, protocol v0 fetch, and
// protocol v0 receive-pack with report-status. A missing repository is a JSON 404 on
// GET /info/refs and the server stays up; a malformed request is a 400, never a crash.

import {
  ZERO_OID,
  decodePktLines,
  decodePktLinesPrefix,
  encodePktLine,
  encodePktLines,
  isObjectId,
  pktFlush,
} from './gitcore.ts';
import { refNamesOf, type Forge, type Repo } from './store.ts';
import type { HttpContext, HttpResult } from './rest.ts';

const AGENT = 'forge/1.0';

function gitError(status: number, message: string): HttpResult {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: `${JSON.stringify({ message })}\n` };
}

function packSideband(pack: Buffer): Buffer {
  // One sideband band-1 packet per chunk (band byte + at most 65515 payload bytes).
  const chunks: Buffer[] = [];
  const maxPayload = 65515;
  for (let offset = 0; offset < pack.length; offset += maxPayload) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + maxPayload));
    chunks.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return Buffer.concat(chunks);
}

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

function advertisementRefs(forge: Forge, repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (defaultTip !== undefined) {
    lines.push({ oid: defaultTip, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` });
  }
  for (const name of refNamesOf(repo)) {
    const oid = repo.refs.get(name) as string;
    const peeled = forge.peeledTarget(repo, oid);
    lines.push(peeled === null ? { oid, name } : { oid, name, peeled });
  }
  return lines;
}

/** The v0 advertisement body: preamble, flush, ref lines, flush. */
function v0Advertisement(forge: Forge, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps: string[] = [];
  if (service === 'git-upload-pack') {
    caps.push('symref=HEAD:refs/heads/main', 'side-band-64k', 'thin-pack', 'ofs-delta', 'shallow', `agent=${AGENT}`);
  } else {
    caps.push('symref=HEAD:refs/heads/main', 'report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`);
  }
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), pktFlush()];
  const refs = advertisementRefs(forge, repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps.join(' ')}\n`));
  } else {
    const first = refs[0] as RefLine;
    parts.push(encodePktLine(`${first.oid} ${first.name}\0${caps.join(' ')}\n`));
    for (const ref of refs.slice(1)) {
      parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(encodePktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v2 capability advertisement: "version 2" then capability lines, then flush. */
function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    `agent=${AGENT}\n`,
    'object-format=sha1\n',
    'flush',
  ]);
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallowHeld: string[];
  depth: number | undefined;
}

/** Parse a v2 fetch request body into its wants, haves, shallow boundary and deepen. */
function parseV2Fetch(lines: string[]): FetchRequest | { error: string } {
  const request: FetchRequest = { wants: [], haves: [], shallowHeld: [], depth: undefined };
  let seenCommand = false;
  let pastDelim = false;
  for (const raw of lines) {
    const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (line === 'command=fetch') {
      seenCommand = true;
      continue;
    }
    if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
    if (line === 'thin-pack' || line === 'no-progress' || line === 'ofs-delta') continue;
    if (line === 'done') continue;
    if (line.startsWith('want ')) {
      pastDelim = true;
      const oid = line.slice(5).trim();
      if (!isObjectId(oid)) return { error: `bad want ${JSON.stringify(oid)}` };
      request.wants.push(oid);
      continue;
    }
    if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (!isObjectId(oid)) return { error: `bad have ${JSON.stringify(oid)}` };
      request.haves.push(oid);
      continue;
    }
    if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (!isObjectId(oid)) return { error: `bad shallow ${JSON.stringify(oid)}` };
      request.shallowHeld.push(oid);
      continue;
    }
    if (line.startsWith('deepen ')) {
      const depth = Number.parseInt(line.slice(7).trim(), 10);
      if (!Number.isFinite(depth) || depth < 1) return { error: `bad deepen ${JSON.stringify(line)}` };
      request.depth = depth;
      continue;
    }
    if (line.startsWith('deepen-since ') || line.startsWith('deepen-not ') || line.startsWith('filter ')) continue;
    if (line === '') continue;
    if (!pastDelim && !seenCommand) return { error: `unexpected v2 line ${JSON.stringify(line)}` };
    if (line !== 'command=fetch') {
      // Unknown arguments are ignored the way a tolerant server would.
      continue;
    }
  }
  if (!seenCommand) return { error: 'no command=fetch' };
  return request;
}

/** Parse a v0 fetch request body (want lines, flush, have lines, done). */
function parseV0Fetch(lines: string[]): FetchRequest | { error: string } {
  const request: FetchRequest = { wants: [], haves: [], shallowHeld: [], depth: undefined };
  let inHaves = false;
  for (const raw of lines) {
    const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (line === '') {
      inHaves = true;
      continue;
    }
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0] as string;
      if (!isObjectId(oid)) return { error: `bad want ${JSON.stringify(oid)}` };
      request.wants.push(oid);
      continue;
    }
    if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (!isObjectId(oid)) return { error: `bad have ${JSON.stringify(oid)}` };
      request.haves.push(oid);
      continue;
    }
    if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (!isObjectId(oid)) return { error: `bad shallow ${JSON.stringify(oid)}` };
      request.shallowHeld.push(oid);
      continue;
    }
    if (line.startsWith('deepen ')) {
      const depth = Number.parseInt(line.slice(7).trim(), 10);
      if (!Number.isFinite(depth) || depth < 1) return { error: `bad deepen ${JSON.stringify(line)}` };
      request.depth = depth;
      continue;
    }
    if (line.startsWith('deepen-since ') || line.startsWith('deepen-not ')) continue;
    if (line === 'done') continue;
    return { error: `unexpected v0 line ${JSON.stringify(line)}` };
  }
  return request;
}

/** The v2 fetch response: acknowledgments, shallow-info, then the sideband packfile. */
function v2FetchResponse(forge: Forge, repo: Repo, request: FetchRequest): Buffer {
  const plan = forge.fetchPlan(repo, request.wants, request.haves, request.shallowHeld, request.depth);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  parts.push(encodePktLine('NAK\n'));
  parts.push(pktFlush());
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  if (plan.send.size > 0) {
    parts.push(encodePktLine('packfile\n'));
    const pack = forge.buildPack(repo, plan.send);
    parts.push(packSideband(pack));
    parts.push(pktFlush());
  }
  return Buffer.concat(parts);
}

/** The v0 fetch response: NAK and shallow lines, then the sideband pack. */
function v0FetchResponse(forge: Forge, repo: Repo, request: FetchRequest): Buffer {
  const plan = forge.fetchPlan(repo, request.wants, request.haves, request.shallowHeld, request.depth);
  const parts: Buffer[] = [encodePktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  if (plan.send.size > 0) {
    const pack = forge.buildPack(repo, plan.send);
    parts.push(packSideband(pack));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v2 ls-refs response for the requested arguments. */
function v2LsRefs(forge: Forge, repo: Repo, args: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): Buffer {
  const lines: string[] = [];
  const refs = advertisementRefs(forge, repo);
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (defaultTip !== undefined) {
    const head = refs.find((ref) => ref.name === 'HEAD');
    if (head && keep('HEAD')) {
      const attrs = args.symrefs && head.symrefTarget ? ` symref-target:${head.symrefTarget}` : '';
      lines.push(`${head.oid} HEAD${attrs}\n`);
    }
  } else if (args.unborn) {
    lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  }
  for (const ref of refs) {
    if (ref.name === 'HEAD' || !keep(ref.name)) continue;
    const attrs: string[] = [];
    if (args.peel && ref.peeled !== undefined) attrs.push(`peeled:${ref.peeled}`);
    lines.push(`${ref.oid} ${ref.name}${attrs.length ? ` ${attrs.join(' ')}` : ''}\n`);
  }
  const parts: Buffer[] = [];
  for (const line of lines) parts.push(encodePktLine(line));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Handle one git smart-HTTP request. Returns null when the path is not a git path, so the
 * caller can fall through to the next handler.
 */
export function handleGit(forge: Forge, ctx: HttpContext): HttpResult | null {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(ctx.pathname);
  if (!match) return null;
  const owner = match[1] as string;
  const name = match[2] as string;
  const suffix = match[3] ?? '';
  if (owner !== forge.viewerLogin) return gitError(404, 'Not Found');
  const repo = forge.getRepo(owner, name);
  if (!repo) return gitError(404, 'Not Found');

  // GET /info/refs?service=...
  if (ctx.method === 'GET' && suffix === '/info/refs') {
    const service = ctx.query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return gitError(400, 'service is required');
    const wantsV2 = service === 'git-upload-pack' && (ctx.headers['git-protocol'] ?? '') === 'version=2';
    const body = wantsV2 ? v2Advertisement() : v0Advertisement(forge, repo, service);
    return {
      status: 200,
      headers: { 'content-type': `application/x-${service}-advertisement` },
      body: body.toString('latin1'),
    };
  }

  if (ctx.method !== 'POST') return gitError(405, 'Method Not Allowed');

  // POST /git-upload-pack: the whole body is pkt-lines, so decode it in full.
  if (suffix === '/git-upload-pack') {
    let packets;
    try {
      packets = decodePktLines(ctx.body);
    } catch {
      return gitError(400, 'malformed pkt-line stream');
    }
    const dataLines: string[] = [];
    for (const packet of packets) {
      if (packet.kind === 'data') dataLines.push(packet.payload.toString('utf8'));
    }
    const first = dataLines[0] ?? '';
    const isV2 = first.startsWith('command=');
    if (isV2) {
      if (first === 'command=ls-refs\n' || first === 'command=ls-refs') {
        const args = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
        for (const raw of dataLines.slice(1)) {
          const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
          if (line === 'peel') args.peel = true;
          else if (line === 'symrefs') args.symrefs = true;
          else if (line === 'unborn') args.unborn = true;
          else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
        }
        const body = v2LsRefs(forge, repo, args);
        return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: body.toString('latin1') };
      }
      if (first !== 'command=fetch\n' && first !== 'command=fetch') {
        return gitError(400, `unknown v2 command ${JSON.stringify(first)}`);
      }
      const request = parseV2Fetch(dataLines);
      if ('error' in request) return gitError(400, request.error);
      const body = v2FetchResponse(forge, repo, request);
      return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: body.toString('latin1') };
    }
    const request = parseV0Fetch(dataLines);
    if ('error' in request) return gitError(400, request.error);
    const body = v0FetchResponse(forge, repo, request);
    return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: body.toString('latin1') };
  }

  // POST /git-receive-pack: decode only up to the command flush; the raw pack
  // bytes after it are not pkt-lines.
  if (suffix === '/git-receive-pack') {
    let prefix;
    try {
      prefix = decodePktLinesPrefix(ctx.body);
    } catch {
      return gitError(400, 'malformed pkt-line stream');
    }
    const dataLines: string[] = [];
    for (const packet of prefix.packets) {
      if (packet.kind === 'data') dataLines.push(packet.payload.toString('utf8'));
    }
    const commands: PushCommand[] = [];
    for (const raw of dataLines) {
      const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
      const nul = line.indexOf('\0');
      const head = nul >= 0 ? line.slice(0, nul) : line;
      const parts = head.split(' ');
      if (parts.length < 3) return gitError(400, `bad receive-pack command ${JSON.stringify(line)}`);
      const [oldOid, newOid, ref] = parts as [string, string, string];
      if (!isObjectId(oldOid) || !isObjectId(newOid) || !ref.startsWith('refs/')) {
        return gitError(400, `bad receive-pack command ${JSON.stringify(line)}`);
      }
      commands.push({ oldOid, newOid, ref });
    }
    if (commands.length === 0) return gitError(400, 'no commands');
    const packBytes = ctx.body.subarray(prefix.consumed);
    const pack = packBytes.length > 0 ? packBytes : null;
    const result = forge.applyPush(repo, commands, pack);
    const reportLines: string[] = [`unpack ${result.unpackOk ? 'ok' : result.unpackDetail}\n`];
    for (const verdict of result.refs) {
      reportLines.push(verdict.ok ? `ok ${verdict.ref}\n` : `ng ${verdict.ref} ${verdict.reason}\n`);
    }
    const report = encodePktLines([...reportLines, 'flush']);
    const body = Buffer.concat([packSideband(report), pktFlush()]);
    return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' }, body: body.toString('latin1') };
  }

  return gitError(404, 'Not Found');
}
