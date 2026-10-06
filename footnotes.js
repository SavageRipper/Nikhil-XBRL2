// UI helper: maintain XBRL footnotes (fact-footnote links). Uses the existing filing footnote store
// (Filing.footnotes / Filing.addFootnote) that the importer reads into and the generator writes out
// (link:footnoteLink, xml:lang, fact-footnote arcs) — no new data structure and no change to generation.
// A footnote is generated only for facts that are generated; one with no linked fact is kept in the project
// but not written to the XML.

const touch = (filing) => { filing.revision++; };

/** footnotes with their linked facts (only facts that still exist) */
export function listFootnotes(filing) {
  return [...filing.footnotes.values()].map((fn) => ({
    id: fn.id, text: fn.text, lang: fn.lang || 'en',
    facts: [...fn.factKeys].map((k) => filing.facts.get(k)).filter(Boolean),
  }));
}
/** footnote ids linked to a fact */
export function footnotesOf(filing, factKey) {
  return [...filing.footnotes.values()].filter((fn) => fn.factKeys.has(factKey)).map((fn) => fn.id);
}
export function addFootnote(filing, text, factKeys = []) {
  const t = String(text ?? '').trim();
  if (!t) throw new Error('Footnote text is empty');
  for (const k of factKeys) if (!filing.facts.has(k)) throw new Error('A footnote can only be attached to a cell that has a value');
  return filing.addFootnote(t, factKeys, 'en');
}
export function updateFootnoteText(filing, id, text) {
  const fn = filing.footnotes.get(id);
  if (!fn) throw new Error(`Unknown footnote ${id}`);
  const t = String(text ?? '').trim();
  if (!t) throw new Error('Footnote text is empty — delete the footnote instead');
  fn.text = t; touch(filing);
}
export function linkFootnote(filing, id, factKey) {
  const fn = filing.footnotes.get(id);
  if (!fn) throw new Error(`Unknown footnote ${id}`);
  if (!filing.facts.has(factKey)) throw new Error('A footnote can only be attached to a cell that has a value');
  fn.factKeys.add(factKey); touch(filing);
}
export function unlinkFootnote(filing, id, factKey) {
  const fn = filing.footnotes.get(id);
  if (fn && fn.factKeys.delete(factKey)) touch(filing);
}
export function removeFootnote(filing, id) {
  if (filing.footnotes.delete(id)) touch(filing);
}
