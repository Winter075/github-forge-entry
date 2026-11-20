// Small HTTP helpers shared by the REST, Git, GraphQL and MCP surfaces.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** Raised when a request carries a non-empty body that is not valid JSON. */
export class JsonParseError extends Error {
  constructor() {
    super('Invalid JSON body');
    this.name = 'JsonParseError';
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': String(Buffer.byteLength(text)),
    ...headers,
  });
  res.end(text);
}

export function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length), ...headers });
  res.end(body);
}

export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Read a request body as a buffer. Never throws for a client disconnect. */
export async function readBody(req: IncomingMessage, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > maxBytes) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Parse a JSON request body; returns undefined when the body is not valid JSON. */
export async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req, 8 * 1024 * 1024);
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    throw new JsonParseError();
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function absoluteUrl(req: IncomingMessage, pathAndQuery: string): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}${pathAndQuery}`;
}

export function splitSegments(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}
