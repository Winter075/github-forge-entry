// Git smart HTTP v2 upload-pack and v0 receive-pack, implemented with pkt-lines and packs.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  collectHeld,
  collectObjects,
  encodePktLines,
  isAncestor,
  parsePktLines,
  peel,
  readPack,
  splitPktStream,
  writePack,
  ZERO_OID,
  type GitObject,
  type GitStore,
} from './git.ts';
import { readBody, sendBuffer } from './http.ts';
import { repoKey, VIEWER, type ForgeState, type Repo } from './state.ts';

const SERVICE_HEADER: Record<string, string> = {
  'git-upload-pack': '# service=git-upload-pack\n',
  'git-receive-pack': '# service=git-receive-pack\n',
};
const ADVERTISEMENT_CAPS_UPLOAD = 'side-band-64k shallow ofs-delta thin-pack symref=HEAD:refs/heads/main agent=makefun-git-client/1.0';
const ADVERTISEMENT_CAPS_RECEIVE = 'report-status side-band-64k delete-refs ofs-delta agent=makefun-git-client/1.0';
const SIDE_BAND_CHUNK = 65_515;

interface GitCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
  readonly sideband: boolean;
}

export async function handleGit(state: ForgeState, req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<void> {
  try {
    const segments = path.split('/').filter((segment) => segment !== '').map(decodeSegment);
    const owner = segments[0] ?? '';
    const rawName = segments[1] ?? '';
    const name = rawName.endsWith('.git') ? rawName.slice(0, -4) : rawName;
    const repo = state.repos.get(repoKey(owner, name));
    if (repo === undefined || repo.owner !== VIEWER.login) {
      sendBuffer(res, 404, 'application/json', Buffer.from('{"message":"Not Found"}\n'));
      return;
    }
    const url = new URL(req.url ?? '/', 'http://entry');
    const service = url.searchParams.get('service') ?? '';
    if (segments[2] === 'info' && segments[3] === 'refs' && method === 'GET') {
      advertise(repo, req, res, service);
      return;
    }
    if (segments[2] === 'git-upload-pack' && method === 'POST') {
      uploadPack(repo, req, res);
      return;
    }
    if (segments[2] === 'git-receive-pack' && method === 'POST') {
      await receivePack(repo, req, res);
      return;
    }
    sendBuffer(res, 404, 'application/json', Buffer.from('{"message":"Not Found"}\n'));
  } catch (err) {
    if (!res.headersSent) sendBuffer(res, 400, 'text/plain', Buffer.from(err instanceof Error ? err.message : 'bad request'));
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function visibleRefs(repo: Repo): Array<{ readonly name: string; readonly oid: string }> {
  const refs: Array<{ name: string; oid: string }> = [];
  for (const [ref, oid] of repo.refs) {
    if ((ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/')) && /^[0-9a-f]{40}$/.test(oid)) refs.push({ name: ref, oid });
  }
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

function headOid(repo: Repo): string {
  return visibleRefs(repo).find((ref) => ref.name === `refs/heads/${repo.defaultBranch}`)?.oid ?? ZERO_OID;
}

function advertise(repo: Repo, req: IncomingMessage, res: ServerResponse, service: string): void {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendBuffer(res, 400, 'text/plain', Buffer.from('unknown service'));
    return;
  }
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2') {
    const packets = encodePktLines([
      'version 2\n',
      'ls-refs=unborn\n',
      'fetch=shallow wait-for-done ofs-delta thin-pack no-progress\n',
      'object-format=sha1\n',
      'agent=makefun-git-client/1.0\n',
      'flush',
    ]);
    sendBuffer(res, 200, contentType, packets);
    return;
  }
  const caps = service === 'git-upload-pack' ? ADVERTISEMENT_CAPS_UPLOAD : ADVERTISEMENT_CAPS_RECEIVE;
  const lines: (string | Buffer | 'flush' | 'delim')[] = [SERVICE_HEADER[service] ?? '', 'flush'];
  const refs = visibleRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      lines.push(`${ref.oid} ${ref.name}${suffix}\n`);
      if (ref.name.startsWith('refs/tags/')) {
        const target = peel(repo.objects, ref.oid);
        if (target !== null && target !== ref.oid) lines.push(`${target} ${ref.name}^{}\n`);
      }
    });
  }
  lines.push('flush');
  sendBuffer(res, 200, contentType, encodePktLines(lines));
}

async function uploadPack(repo: Repo, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const text = body.toString('utf8');
  if (text.startsWith('zzzz')) {
    sendBuffer(res, 400, 'text/plain', Buffer.from('bad request'));
    return;
  }
  const packets = parsePktLines(body);
  const data = packets.filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8'));
  if (data[0] === 'command=ls-refs\n') {
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', lsRefs(repo, data));
    return;
  }
  if (data[0] === 'command=fetch\n') {
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', fetchV2(repo, data));
    return;
  }
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', fetchV0(repo, data));
}

function lsRefs(repo: Repo, lines: string[]): Buffer {
  const prefixes = lines.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length).trim());
  const wantPeel = lines.includes('peel\n');
  const wantSymrefs = lines.includes('symrefs\n');
  const out: string[] = [];
  const head = headOid(repo);
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  if (head !== ZERO_OID && matches('HEAD')) {
    out.push(wantSymrefs ? `${head} HEAD symref-target:refs/heads/${repo.defaultBranch}` : `${head} HEAD`);
  } else if (head === ZERO_OID && matches('HEAD')) {
    out.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}`);
  }
  for (const ref of visibleRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (wantPeel && ref.name.startsWith('refs/tags/')) {
      const target = peel(repo.objects, ref.oid);
      if (target !== null && target !== ref.oid) line += ` peeled:${target}`;
    }
    out.push(line);
  }
  return encodePktLines([...out, 'flush']);
}

function parseFetchCommand(lines: string[]): {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
} {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0] ?? '');
    else if (line.startsWith('have ')) haves.push(line.slice(5).split(' ')[0] ?? '');
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7));
  }
  return { wants, haves, shallow, depth };
}

function fetchV2(repo: Repo, lines: string[]): Buffer {
  const { wants, haves, shallow, depth } = parseFetchCommand(lines);
  return encodeFetchResponse(repo, wants, haves, shallow, depth);
}

function fetchV0(repo: Repo, lines: string[]): Buffer {
  const { wants, haves, shallow, depth } = parseFetchCommand(lines);
  const { objects, boundary } = objectsToSend(repo, wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  const ack = wants.length > 0 ? `ACK ${wants[0]}\n` : 'NAK\n';
  parts.push(encodePktLines([ack]));
  for (const oid of boundary) parts.push(encodePktLines([`shallow ${oid}\n`]));
  parts.push(...sidebandPackets(writePack(objects)));
  return Buffer.concat(parts);
}

function objectsToSend(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallow: string[],
  depth: number | null,
): { objects: GitObject[]; boundary: string[] } {
  const shallowSet = new Set(shallow);
  const held = collectHeld(repo.objects, haves.length > 0 ? haves : shallow, shallowSet);
  const result = collectObjects(repo.objects, wants, depth, shallowSet, held);
  return result;
}

function encodeFetchResponse(repo: Repo, wants: string[], haves: string[], shallow: string[], depth: number | null): Buffer {
  const { objects, boundary } = objectsToSend(repo, wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  parts.push(encodePktLines(['acknowledgments\n', wants.length > 0 ? `ACK ${wants[0]}\n` : 'NAK\n', 'flush']));
  if (boundary.length > 0 || shallow.length > 0) {
    const section: (string | Buffer | 'flush' | 'delim')[] = ['shallow-info\n'];
    for (const oid of boundary) if (!shallow.includes(oid)) section.push(`shallow ${oid}\n`);
    if (depth !== null) for (const oid of shallow) if (!boundary.includes(oid)) section.push(`unshallow ${oid}\n`);
    section.push('flush');
    parts.push(encodePktLines(section));
  }
  parts.push(encodePktLines(['packfile\n']));
  parts.push(...sidebandPackets(writePack(objects)));
  parts.push(encodePktLines(['flush']));
  return Buffer.concat(parts);
}

function sidebandPackets(data: Buffer, band = 1): Buffer[] {
  if (data.length === 0) return [encodePktLines([Buffer.from([band])])];
  const packets: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += SIDE_BAND_CHUNK) {
    packets.push(encodePktLines([Buffer.concat([Buffer.from([band]), data.subarray(offset, offset + SIDE_BAND_CHUNK)])]));
  }
  return packets;
}

async function receivePack(repo: Repo, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const { packets, rest } = splitPktStream(body);
  const commands: GitCommand[] = [];
  let sideband = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const raw = packet.payload.toString('utf8');
    const nul = raw.indexOf('\0');
    const line = nul < 0 ? raw : raw.slice(0, nul);
    const caps = nul < 0 ? '' : raw.slice(nul + 1);
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) continue;
    const [oldOid, newOid, ref] = fields;
    if (oldOid === undefined || newOid === undefined || ref === undefined) continue;
    if (/side-band-64k/.test(caps)) sideband = true;
    commands.push({ oldOid, newOid, ref, sideband });
  }
  if (commands.length === 0) {
    sendBuffer(res, 200, 'application/x-git-receive-pack-result', Buffer.alloc(0));
    return;
  }
  let unpackDetail: string | null = null;
  let unpacked: GitStore = new Map();
  if (rest.length > 0) {
    try {
      unpacked = readPack(rest);
    } catch (err) {
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  for (const [oid, object] of unpacked) repo.objects.set(oid, object);

  const report: string[] = [unpackDetail === null ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
  const accepted: GitCommand[] = [];
  if (unpackDetail === null) {
    for (const command of commands) {
      const reason = validateCommand(repo, command);
      if (reason === null) accepted.push(command);
      else report.push(`ng ${command.ref} ${reason}\n`);
    }
    for (const command of accepted) {
      if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
      report.push(`ok ${command.ref}\n`);
    }
  } else {
    for (const command of commands) report.push(`ng ${command.ref} unpack failed\n`);
  }
  const inner = encodePktLines(report);
  const outer = sideband ? Buffer.concat(sidebandPackets(inner, 1)) : inner;
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', outer);
}

function validateCommand(repo: Repo, command: GitCommand): string | null {
  const { oldOid, newOid, ref } = command;
  if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return 'permission denied';
  if (ref.includes('..') || ref.includes(' ') || ref.endsWith('.')) return 'permission denied';
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (current.toLowerCase() !== oldOid.toLowerCase()) return 'fetch first';
  if (newOid === ZERO_OID) return current === ZERO_OID ? 'fetch first' : null;
  if (repo.objects.get(newOid.toLowerCase()) === undefined) return 'missing object';
  if (current !== ZERO_OID && ref.startsWith('refs/heads/') && !isAncestor(repo.objects, current, newOid)) return 'non-fast-forward';
  return null;
}
