// Build/test-side XML Schema + XBRL 2.1 + XBRL Dimensions validation of generated instances,
// using Arelle (open-source XBRL processor, https://arelle.org) running fully offline:
//   * XBRL specification schemas come from Arelle's bundled cache (xbrl.org is not contacted)
//   * the MCA C&I 2016 taxonomy comes from the local package (.taxonomy/)
//   * a temporary copy of the instance points its schemaRef at the local entry point;
//     the instance itself is never modified.
// This is NOT the official MCA XBRL Validator V5.1 and does not run MCA business rules.
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureTaxonomy } from './taxonomy-source.mjs';

const PY = process.env.PYTHON || 'python3';

export function xsdValidatorStatus() {
  const r = spawnSync(PY, ['-c', 'import arelle, importlib.metadata as m; print(m.version("arelle-release"))'], { encoding: 'utf8' });
  if (r.status === 0) return { available: true, tool: 'Arelle', version: r.stdout.trim() };
  return { available: false, tool: 'Arelle', reason: 'python3 module "arelle" not installed (pip install -r requirements.txt)' };
}

export function validateInstanceXml(xml, { label = 'instance.xml' } = {}) {
  const st = xsdValidatorStatus();
  if (!st.available) return { status: 'UNAVAILABLE', ...st, errors: [], warnings: [] };
  const entry = pathToFileURL(path.join(ensureTaxonomy(), 'in-ci-ent-2016-03-31.xsd')).href;
  const local = xml.replace(/(<link:schemaRef\b[^>]*xlink:href=")[^"]+(")/, `$1${entry}$2`);
  const dir = mkdtempSync(path.join(tmpdir(), 'mca-xsd-'));
  try {
    const file = path.join(dir, label.replace(/[^\w.-]/g, '_'));
    const log = path.join(dir, 'arelle.log');
    writeFileSync(file, local);
    spawnSync(PY, ['-m', 'arelle.CntlrCmdLine', '--file', file, '--validate', '--internetConnectivity', 'offline', '--logFile', log, '--logLevel', 'warning'], { encoding: 'utf8', maxBuffer: 64e6 });
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    const msgs = lines.map((l) => { const m = /^\[([^\]]+)\]\s*(.*)$/.exec(l); return m ? { code: m[1], message: m[2] } : { code: 'log', message: l }; });
    // XML Schema, XBRL 2.1 (xbrl.*), Dimensions (xbrldte/xbrldie) and load errors are failures
    const errors = msgs.filter((m) => /^(xmlSchema|xbrl\.|xbrldte|xbrldie|arelle:|IOerror|xmlSchema:|xml)/i.test(m.code) || /error/i.test(m.code));
    const warnings = msgs.filter((m) => !errors.includes(m));
    return { status: errors.length ? 'FAIL' : 'PASS', ...st, errors, warnings };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const f = process.argv[2];
  if (!f) { console.log(JSON.stringify(xsdValidatorStatus())); process.exit(0); }
  const r = validateInstanceXml(readFileSync(f, 'utf8'), { label: path.basename(f) });
  console.log(`${r.status} (${r.tool} ${r.version || ''}) errors=${r.errors.length} warnings=${r.warnings.length}`);
  for (const e of r.errors.slice(0, 50)) console.log(`  [${e.code}] ${e.message}`);
  process.exit(r.status === 'FAIL' ? 1 : 0);
}

