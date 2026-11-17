import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, ObjectType } from './app.ts';

const types = ['', 'commit', 'tree', 'blob', 'tag'];
export function objectId(o: GitObject): string {
  return createHash('sha1').update(`${o.type} ${o.data.length}\0`).update(o.data).digest('hex');
}
export function pktLine(data: string | Buffer): Buffer {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (bytes.length > 65516) throw new Error('Packet too large');
  return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, '0')), bytes]);
}
export const flush = Buffer.from('0000');
export function readPackets(data: Buffer): { packets: Buffer[]; offset: number } {
  const packets: Buffer[] = []; let offset = 0;
  while (offset + 4 <= data.length) {
    const hex = data.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-f]{4}$/i.test(hex)) break;
    const n = parseInt(hex, 16); offset += 4;
    if (n <= 2) { packets.push(Buffer.alloc(0)); continue; }
    if (n < 4 || offset + n - 4 > data.length) throw new Error('Truncated packet');
    packets.push(data.subarray(offset, offset + n - 4)); offset += n - 4;
  }
  return { packets, offset };
}
function variable(n: number): Buffer {
  const out: number[] = [];
  do { const b = n % 128; n = Math.floor(n / 128); out.push(b | (n ? 128 : 0)); } while (n);
  return Buffer.from(out);
}
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  function size() { let n = 0, shift = 0, b: number; do { if (p >= delta.length || shift > 49) throw new Error('Invalid delta'); b = delta[p++]; n += (b & 127) * 2 ** shift; shift += 7; } while (b & 128); return n; }
  if (size() !== base.length) throw new Error('Delta base size mismatch');
  const length = size(); if (length > 256 * 1024 * 1024) throw new Error('Delta too large');
  const result = Buffer.allocUnsafe(length); let out = 0;
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 128) {
      let start = 0, count = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) { if (p >= delta.length) throw new Error('Invalid delta'); start += delta[p++] * 2 ** (8 * i); }
      for (let i = 0; i < 3; i++) if (op & (16 << i)) { if (p >= delta.length) throw new Error('Invalid delta'); count += delta[p++] * 2 ** (8 * i); }
      if (!count) count = 65536;
      if (start + count > base.length || out + count > length) throw new Error('Invalid delta copy');
      base.copy(result, out, start, start + count); out += count;
    } else {
      if (!op || p + op > delta.length || out + op > length) throw new Error('Invalid delta insert');
      delta.copy(result, out, p, p + op); p += op; out += op;
    }
  }
  if (out !== length) throw new Error('Delta result size mismatch');
  return result;
}
export function parsePack(data: Buffer, existing: Map<string, GitObject> = new Map()): Map<string, GitObject> {
  if (data.length < 32 || data.toString('ascii', 0, 4) !== 'PACK' || ![2, 3].includes(data.readUInt32BE(4))) throw new Error('Invalid pack header');
  const end = data.length - 20;
  if (!createHash('sha1').update(data.subarray(0, end)).digest().equals(data.subarray(end))) throw new Error('Invalid pack checksum');
  const entries: { offset: number; type: number; data: Buffer; base?: number | string; object?: GitObject }[] = [];
  const offsets = new Map<number, typeof entries[number]>(); const result = new Map<string, GitObject>(); let p = 12;
  for (let i = 0; i < data.readUInt32BE(8); i++) {
    const offset = p; let b = data[p++], size = b & 15, shift = 4; const type = (b >> 4) & 7;
    while (b & 128) { if (p >= end || shift > 49) throw new Error('Invalid entry'); b = data[p++]; size += (b & 127) * 2 ** shift; shift += 7; }
    let base: number | string | undefined;
    if (type === 6) { b = data[p++]; let distance = b & 127; while (b & 128) { b = data[p++]; distance = (distance + 1) * 128 + (b & 127); if (p >= end) throw new Error('Invalid offset'); } base = offset - distance; }
    else if (type === 7) { base = data.subarray(p, p + 20).toString('hex'); p += 20; }
    else if (!types[type]) throw new Error('Invalid object type');
    const inflated = inflateSync(data.subarray(p, end), { info: true, maxOutputLength: 256 * 1024 * 1024 });
    p += inflated.engine.bytesWritten;
    if (inflated.buffer.length !== size) throw new Error('Invalid entry size');
    const entry = { offset, type, data: inflated.buffer, base };
    entries.push(entry); offsets.set(offset, entry);
  }
  if (p !== end) throw new Error('Trailing pack data');
  let remaining = entries.length;
  while (remaining) {
    let progress = false;
    for (const e of entries) {
      if (e.object) continue;
      const base = typeof e.base === 'number' ? offsets.get(e.base)?.object : typeof e.base === 'string' ? result.get(e.base) ?? existing.get(e.base) : undefined;
      if (e.type >= 6 && !base) continue;
      e.object = base ? { type: base.type, data: applyDelta(base.data, e.data) } : { type: types[e.type] as ObjectType, data: e.data };
      result.set(objectId(e.object), e.object); remaining--; progress = true;
    }
    if (!progress) throw new Error('Missing delta base');
  }
  return result;
}
function header(type: number, size: number): Buffer {
  const out = [(type << 4) | (size & 15)]; size = Math.floor(size / 16);
  if (size) out[0] |= 128;
  while (size) { const b = size % 128; size = Math.floor(size / 128); out.push(b | (size ? 128 : 0)); }
  return Buffer.from(out);
}
function makeDelta(base: Buffer, target: Buffer): Buffer {
  let prefix = 0; while (prefix < Math.min(base.length, target.length) && base[prefix] === target[prefix]) prefix++;
  let suffix = 0; while (suffix < Math.min(base.length, target.length) - prefix && base[base.length - 1 - suffix] === target[target.length - 1 - suffix]) suffix++;
  const parts = [variable(base.length), variable(target.length)];
  function copy(offset: number, count: number) {
    while (count) { const n = Math.min(count, 0xffffff); let op = 128; const args: number[] = [];
      for (let i = 0; i < 4; i++) { const b = Math.floor(offset / 2 ** (8 * i)) & 255; if (b) { op |= 1 << i; args.push(b); } }
      for (let i = 0; i < 3; i++) { const b = (n >> (8 * i)) & 255; if (b) { op |= 16 << i; args.push(b); } }
      parts.push(Buffer.from([op, ...args])); offset += n; count -= n;
    }
  }
  if (prefix) copy(0, prefix);
  for (let p = prefix; p < target.length - suffix; p += 127) { const piece = target.subarray(p, Math.min(p + 127, target.length - suffix)); parts.push(Buffer.from([piece.length]), piece); }
  if (suffix) copy(base.length - suffix, suffix);
  return Buffer.concat(parts);
}
export function generatePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects]; const h = Buffer.alloc(12); h.write('PACK'); h.writeUInt32BE(2, 4); h.writeUInt32BE(list.length, 8);
  const parts = [h]; const previous: { object: GitObject; id: string; depth: number }[] = [];
  for (const object of list) {
    let compressed = deflateSync(object.data), type = types.indexOf(object.type), baseId: string | undefined, depth = 0;
    for (const base of previous.slice(-4)) {
      if (base.object.type !== object.type || base.depth >= 3 || Math.abs(base.object.data.length - object.data.length) > Math.max(1024, object.data.length / 2)) continue;
      const delta = makeDelta(base.object.data, object.data); if (delta.length + 20 >= compressed.length) continue;
      const zipped = deflateSync(delta);
      if (zipped.length + 20 < compressed.length) { compressed = zipped; type = 7; baseId = base.id; depth = base.depth + 1; var deltaSize = delta.length; }
    }
    parts.push(header(type, type === 7 ? deltaSize! : object.data.length)); if (baseId) parts.push(Buffer.from(baseId, 'hex')); parts.push(compressed);
    previous.push({ object, id: objectId(object), depth }); if (previous.length > 4) previous.shift();
  }
  const body = Buffer.concat(parts); return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
