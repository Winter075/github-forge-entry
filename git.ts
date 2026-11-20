// Git plumbing for the forge: object ids, packfiles, pkt-lines and tree/commit conversion.
// Everything here uses Node built-ins; the trial has no git binary and no packages.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}
export type GitStore = Map<string, GitObject>;

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The git SHA-1 of one loose object: `<type> <byte length>\0<data>`. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
}

/** Store an object and return its id. */
export function putObject(store: GitStore, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.has(oid)) store.set(oid, { type, data });
  return oid;
}

/** A pkt-line with its four-byte length prefix, or a control packet. */
export function pkt(text: string | Buffer): Buffer {
  const payload = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
  const head = Buffer.allocUnsafe(4);
  head.write((payload.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, payload]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Encode a list of pkt-lines; strings become UTF-8 payloads. */
export function encodePktLines(lines: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else parts.push(pkt(line));
  }
  return Buffer.concat(parts);
}

export interface GitPacket {
  readonly kind: 'data' | 'flush' | 'delim';
  readonly payload: Buffer;
}

/** Decode pkt-lines from a complete buffer. */
export function parsePktLines(input: Buffer): GitPacket[] {
  const out: GitPacket[] = [];
  let pos = 0;
  while (pos + 4 <= input.length) {
    const raw = input.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(raw)) break;
    const len = parseInt(raw, 16);
    pos += 4;
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      continue;
    }
    if (len < 4 || pos + len - 4 > input.length) break;
    out.push({ kind: 'data', payload: input.subarray(pos, pos + len - 4) });
    pos += len - 4;
  }
  return out;
}

/** Split the command preamble from the binary pack that follows a receive-pack request. */
export function splitPktStream(input: Buffer): { packets: GitPacket[]; rest: Buffer } {
  const packets: GitPacket[] = [];
  let pos = 0;
  while (pos + 4 <= input.length) {
    const raw = input.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(raw)) break;
    const len = parseInt(raw, 16);
    pos += 4;
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      break;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      continue;
    }
    if (len < 4 || pos + len - 4 > input.length) break;
    packets.push({ kind: 'data', payload: input.subarray(pos, pos + len - 4) });
    pos += len - 4;
  }
  return { packets, rest: input.subarray(pos) };
}

/** A complete packfile (version 2) with full objects and a SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    let size = object.data.length;
    let byte = (TYPE_CODE[object.type] << 4) | (size & 15);
    size >>>= 4;
    const varint: number[] = [];
    while (size > 0) {
      varint.push(byte | 0x80);
      byte = size & 0x7f;
      size >>>= 7;
    }
    varint.push(byte);
    parts.push(Buffer.from(varint));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}

function readVarint(buffer: Buffer, offset: number): { first: number; size: number; next: number } {
  let pos = offset;
  const first = buffer[pos++] ?? 0;
  let size = first & 15;
  let shift = 4;
  let byte = first;
  while ((byte & 0x80) !== 0) {
    byte = buffer[pos++] ?? 0;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { first, size, next: pos };
}

function readOfsBase(buffer: Buffer, offset: number): { value: number; next: number } {
  let pos = offset;
  let byte = buffer[pos++] ?? 0;
  let value = byte & 127;
  while ((byte & 0x80) !== 0) {
    byte = buffer[pos++] ?? 0;
    value = ((value + 1) << 7) | (byte & 127);
  }
  return { value, next: pos };
}

/** Read every object from a version 2/3 pack, resolving OFS_DELTA and REF_DELTA entries. */
export function readPack(input: Buffer, known: GitStore = new Map()): GitStore {
  if (input.length < 32 || input.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = input.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = input.readUInt32BE(8);
  const trailerStart = input.length - 20;
  interface RawEntry {
    readonly offset: number;
    readonly typeCode: number;
    readonly size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    type?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  const byOid = new Map<string, RawEntry>();
  for (const object of known.values()) {
    // Seed REF_DELTA resolution from the client's advertised haves.
    // The caller only needs the object id; resolution recomputes data from the pack base.
    void object;
  }
  let pos = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = pos;
    const header = readVarint(input, pos);
    pos = header.next;
    const typeCode = (header.first >> 4) & 7;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(input, pos);
      pos = base.next;
      entry.baseOffset = entryOffset - base.value;
    } else if (typeCode === 7) {
      if (pos + 20 > trailerStart) throw new Error('ref-delta base is truncated');
      entry.baseOid = input.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`unknown pack object type ${typeCode}`);
    }
    const inflated = inflateAt(input.subarray(0, trailerStart), pos);
    if (inflated.data.length !== header.size) throw new Error('pack object size mismatch');
    entry.data = inflated.data;
    pos = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (pos !== trailerStart) throw new Error('stray bytes before the pack trailer');

  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): GitObject => {
    if (entry.resolved !== undefined && entry.type !== undefined && entry.oid !== undefined) {
      return { type: entry.type, data: entry.resolved };
    }
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const base = byOffset.get(entry.baseOffset ?? -1);
      if (base === undefined) throw new Error('missing ofs-delta base');
      const resolvedBase = resolve(base);
      type = resolvedBase.type;
      data = applyDelta(resolvedBase.data, entry.data);
    } else if (entry.typeCode === 7) {
      const base = byOid.get(entry.baseOid ?? '') ?? [...byOid.values()].find((item) => item.oid === entry.baseOid);
      if (base === undefined) throw new Error('missing ref-delta base');
      const resolvedBase = resolve(base);
      type = resolvedBase.type;
      data = applyDelta(resolvedBase.data, entry.data);
    } else {
      type = CODE_TYPE[entry.typeCode] ?? 'blob';
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.type = type;
    entry.resolved = data;
    entry.oid = oid;
    byOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data };
  };
  const out: GitStore = new Map(known);
  for (const [oid, object] of known) out.set(oid, object);
  for (const entry of raw) {
    const object = resolve(entry);
    if (entry.oid !== undefined) out.set(entry.oid, object);
  }
  return out;
}

/** Apply a git delta stream to a base object. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  let baseSize = 0;
  let shift = 0;
  let byte = 0;
  do {
    byte = delta[pos++] ?? 0;
    baseSize += (byte & 127) * 2 ** shift;
    shift += 7;
  } while ((byte & 0x80) !== 0);
  shift = 0;
  let resultSize = 0;
  do {
    byte = delta[pos++] ?? 0;
    resultSize += (byte & 127) * 2 ** shift;
    shift += 7;
  } while ((byte & 0x80) !== 0);
  const chunks: Buffer[] = [];
  let written = 0;
  while (pos < delta.length && written < resultSize) {
    const op = delta[pos++] ?? 0;
    if ((op & 0x80) === 0) {
      const length = op & 127;
      chunks.push(delta.subarray(pos, pos + length));
      pos += length;
      written += length;
      continue;
    }
    let copyOffset = 0;
    let copySize = 0;
    for (let bit = 0; bit < 4; bit += 1) if ((op & (1 << bit)) !== 0) copyOffset |= (delta[pos++] ?? 0) << (bit * 8);
    for (let bit = 0; bit < 3; bit += 1) if ((op & (1 << (4 + bit))) !== 0) copySize |= (delta[pos++] ?? 0) << (bit * 8);
    if (copySize === 0) copySize = 0x10000;
    chunks.push(base.subarray(copyOffset, copyOffset + copySize));
    written += copySize;
  }
  return Buffer.concat(chunks).subarray(0, resultSize);
}

/** Parse a commit's tree, parents and message. */
export function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string; raw: string } {
  const raw = data.toString('utf8');
  const separator = raw.indexOf('\n\n');
  const head = separator < 0 ? raw : raw.slice(0, separator);
  const message = separator < 0 ? '' : raw.slice(separator + 2);
  const tree = /^tree ([0-9a-f]{40})$/m.exec(head)?.[1] ?? ZERO_OID;
  const parents = [...head.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((match) => match[1] ?? '');
  return { tree, parents, message, raw };
}

/** Parse a tag's target and type. */
export function parseTag(data: Buffer): { object: string; type: GitObjectType } {
  const raw = data.toString('utf8');
  const object = /^object ([0-9a-f]{40})$/m.exec(raw)?.[1] ?? ZERO_OID;
  const type = (/^type (\w+)$/m.exec(raw)?.[1] ?? 'commit') as GitObjectType;
  return { object, type };
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object's binary entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const nul = data.indexOf(0, pos);
    if (nul < 0) break;
    const [mode, name] = data.subarray(pos, nul).toString('utf8').split(' ', 2);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode: mode ?? '100644', name: name ?? '', oid });
    pos = nul + 21;
  }
  return out;
}

/** Build a tree object for a flat path map, creating nested trees as needed. */
export function writeTree(store: GitStore, files: ReadonlyMap<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [filePath, oid] of files) {
    const parts = filePath.split('/').filter((part) => part !== '');
    let node = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index] ?? '';
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1] ?? '', oid);
  }
  const encode = (node: Node): string => {
    const entries: Array<{ name: string; mode: string; oid: string }> = [];
    for (const [name, oid] of node.files) entries.push({ name, mode: '100644', oid });
    for (const [name, child] of node.dirs) entries.push({ name, mode: '40000', oid: encode(child) });
    entries.sort((a, b) => (a.mode === '40000' ? `${a.name}/` : a.name).localeCompare(b.mode === '40000' ? `${b.name}/` : b.name));
    const chunks: Buffer[] = [];
    for (const entry of entries) {
      chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
      chunks.push(Buffer.from(entry.oid, 'hex'));
    }
    return putObject(store, 'tree', Buffer.concat(chunks));
  };
  return encode(root);
}

/** Build a commit object with a deterministic author timestamp. */
export function writeCommit(store: GitStore, tree: string, parents: readonly string[], message: string, counter: number): string {
  const when = String(1_700_000_000 + counter);
  const lines = [`tree ${tree}`, ...parents.map((parent) => `parent ${parent}`), 'author forge <forge@local> ' + when + ' +0000', 'committer forge <forge@local> ' + when + ' +0000', '', message, ''];
  return putObject(store, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
}

/** Read a commit's tree into a flat path -> blob id map. */
export function filesAt(store: GitStore, commitOid: string): Map<string, string> {
  const out = new Map<string, string>();
  if (commitOid === ZERO_OID) return out;
  const commit = store.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return out;
  const walk = (treeOid: string, prefix: string, depth: number): void => {
    if (depth > 32) return;
    const tree = store.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path, depth + 1);
      else out.set(path, entry.oid);
    }
  };
  walk(parseCommit(commit.data).tree, '', 0);
  return out;
}

/** All blobs of a tree map with their bytes. */
export function fileContents(store: GitStore, commitOid: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const [path, oid] of filesAt(store, commitOid)) {
    const object = store.get(oid);
    if (object !== undefined) out.set(path, object.data);
  }
  return out;
}

/** Objects reachable from the tips, optionally limited to a commit depth for shallow fetches. */
export function collectObjects(
  store: GitStore,
  tips: Iterable<string>,
  depth: number | null = null,
  shallow: ReadonlySet<string> = new Set(),
  held: ReadonlySet<string> = new Set(),
): { objects: GitObject[]; boundary: string[] } {
  const included = new Set<string>();
  const visited = new Set<string>();
  const boundary: string[] = [];
  const queue: Array<{ oid: string; distance: number }> = [...new Set(tips)].map((oid) => ({ oid, distance: 0 }));
  const takeTree = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop();
      if (oid === undefined || included.has(oid) || held.has(oid)) continue;
      const object = store.get(oid);
      if (object === undefined) continue;
      included.add(oid);
      if (object.type === 'tree') for (const entry of parseTree(object.data)) stack.push(entry.oid);
    }
  };
  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) continue;
    const { oid, distance } = item;
    if (visited.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    visited.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      takeTree(commit.tree);
      if (!held.has(oid)) included.add(oid);
      const depthStop = depth !== null && distance + 1 >= depth;
      const shallowStop = shallow.has(oid) && distance > 0;
      if (depthStop || shallowStop) {
        if (!held.has(oid)) boundary.push(oid);
      } else {
        for (const parent of commit.parents) queue.push({ oid: parent, distance: distance + 1 });
      }
    } else if (object.type === 'tag') {
      if (!held.has(oid)) included.add(oid);
      queue.push({ oid: parseTag(object.data).object, distance });
    } else if (!held.has(oid)) {
      included.add(oid);
    }
  }
  const objects: GitObject[] = [];
  for (const oid of included) {
    const object = store.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return { objects, boundary };
}

/** Objects a client already holds, stopping at its shallow boundaries. */
export function collectHeld(store: GitStore, tips: Iterable<string>, shallow: ReadonlySet<string>): Set<string> {
  const held = new Set<string>();
  const queue = [...new Set(tips)];
  const takeTree = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop();
      if (oid === undefined || held.has(oid)) continue;
      const object = store.get(oid);
      if (object === undefined) continue;
      held.add(oid);
      if (object.type === 'tree') for (const entry of parseTree(object.data)) stack.push(entry.oid);
    }
  };
  while (queue.length > 0) {
    const oid = queue.shift();
    if (oid === undefined || held.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      takeTree(commit.tree);
      if (!shallow.has(oid)) for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return held;
}

/** True when `ancestor` is reachable from `oid` by following commit parents. */
export function isAncestor(store: GitStore, ancestor: string, oid: string): boolean {
  const queue = [oid];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    if (current === ancestor) return true;
    seen.add(current);
    const object = store.get(current);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/** Peel a tag object to its target commit. */
export function peel(store: GitStore, oid: string, depth = 8): string | null {
  let current = oid;
  for (let index = 0; index < depth; index += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return null;
}
