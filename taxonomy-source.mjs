// Extracts the MCA taxonomy package (Final_C_and_I_Taxonomy_2016_V1.2.zip, kept as supplied) into
// .taxonomy/ (git-ignored) so the DTS loader can read it. Pure Node (zlib), no dependencies.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const TAXONOMY_ZIP = path.join(ROOT, 'Final_C_and_I_Taxonomy_2016_V1.2.zip');
export const TAXONOMY_DIR = path.join(ROOT, '.taxonomy');
export const TAXONOMY_ROOT = path.join(TAXONOMY_DIR, 'Taxonomy-2016-03-31');

export function ensureTaxonomy() {
  if (existsSync(path.join(TAXONOMY_ROOT, 'in-ci-ent-2016-03-31.xsd'))) return TAXONOMY_ROOT;
  const buf = readFileSync(TAXONOMY_ZIP);
  // end of central directory record
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('Taxonomy zip: end of central directory not found');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Taxonomy zip: bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen).replace(/\\/g, '/');
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    if (name.split('/').includes('..')) throw new Error(`Taxonomy zip: unsafe path ${name}`);
    const lnlen = buf.readUInt16LE(local + 26), lxlen = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + lnlen + lxlen, local + 30 + lnlen + lxlen + csize);
    const out = path.join(TAXONOMY_DIR, name);
    mkdirSync(path.dirname(out), { recursive: true });
    if (method === 0) writeFileSync(out, data);
    else if (method === 8) writeFileSync(out, inflateRawSync(data));
    else throw new Error(`Taxonomy zip: unsupported compression ${method} for ${name}`);
  }
  return TAXONOMY_ROOT;
}
