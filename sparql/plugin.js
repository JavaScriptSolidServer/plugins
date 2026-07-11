// SPARQL SELECT endpoint over a pod's JSON-LD, as a #206 loader plugin.
//
//   plugins: [{ module: 'sparql/plugin.js', prefix: '/sparql',
//               config: { baseUrl: 'http://localhost:3000',
//                         defaultContainer: '/alice/' } }]
//
// Out-of-tree exploration of JSS issue #509 ("SPARQL endpoint + write-time
// index"). This plugin implements the READ-TIME half honestly:
//
//   POST /sparql            Content-Type: application/sparql-query
//   → application/sparql-results+json
//
// over the JSON-LD resources under a container the caller names (FROM <iri>
// in the query, ?container=/path/, or config.defaultContainer). Every
// resource is fetched over loopback carrying the CALLER'S OWN Authorization
// header, so WAC applies definitionally: the query can only see what the
// caller could GET anyway (the notifications plugin's loopback pattern,
// applied to authorization of an entire dataset).
//
// It also implements SPARQL UPDATE for the GROUND-DATA forms:
//
//   POST /sparql            Content-Type: application/sparql-update
//   INSERT DATA / DELETE DATA, target named via GRAPH <iri> {} or
//   ?resource=/path → 200 + a small JSON summary
//
// as the exact inverse of the read lens: GET the target over loopback with
// the caller's own Authorization (host ETag captured), flatten, merge or
// filter the ground triples, serialize back, PUT with If-Match (retry once
// on 412, then 409) — the conditional-write pass-through remotestorage/
// measured, second consumer. Pattern forms (DELETE/INSERT … WHERE) and
// graph management are 501, not half-implemented.
//
// What a plugin CANNOT do is the other half of #509: the write-time index
// that makes queries O(1). There is no write-hook in the plugin api — no
// api.events.onResourceChange — so a plugin can't maintain an index that
// tracks writes authoritatively. That gap is the headline finding; see
// README.md and the api.events candidate seam already in NOTES.md. Until
// that seam exists, every query here is an O(N) bounded crawl.
//
// Everything below is hand-rolled on node builtins: a SPARQL tokenizer +
// recursive-descent parser for a documented SELECT subset, a minimal
// JSON-LD → triples flattener, and a nested-loop BGP join. A documented
// subset beats a broken full parser — see README.md for exactly what is
// and is not supported.

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const LDP_CONTAINS = 'http://www.w3.org/ns/ldp#contains';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

const DEFAULT_MAX_DEPTH = 3; // container nesting below the scope container
const DEFAULT_MAX_RESOURCES = 200; // loopback fetches per query
const DEFAULT_RESULT_CAP = 1000; // bindings, even when LIMIT is higher/absent
const MAX_QUERY_LENGTH = 20_000;
const MAX_JOIN_ROWS = 100_000; // abort pathological joins

class QueryError extends Error {}

// --------------------------------------------------------------- tokenizer

const IRI_RE = /^<([^<>"{}|^`\\\s]*)>/;
const PNAME_RE = /^([A-Za-z][A-Za-z0-9_-]*)?:([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)?/;
const WORD_RE = /^[A-Za-z_][A-Za-z0-9_-]*/;
const VARNAME_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
const NUM_TOKEN_RE = /^-?\d+(?:\.\d+)?/;

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '<') {
      const m = IRI_RE.exec(src.slice(i));
      if (m) { tokens.push({ k: 'iri', v: m[1] }); i += m[0].length; continue; }
      if (src[i + 1] === '=') { tokens.push({ k: 'op', v: '<=' }); i += 2; } else { tokens.push({ k: 'op', v: '<' }); i++; }
      continue;
    }
    if (c === '>') {
      if (src[i + 1] === '=') { tokens.push({ k: 'op', v: '>=' }); i += 2; } else { tokens.push({ k: 'op', v: '>' }); i++; }
      continue;
    }
    if (c === '!' && src[i + 1] === '=') { tokens.push({ k: 'op', v: '!=' }); i += 2; continue; }
    if (c === '=') { tokens.push({ k: 'op', v: '=' }); i++; continue; }
    if (c === '^' && src[i + 1] === '^') { tokens.push({ k: 'dtsep' }); i += 2; continue; }
    if (c === '?' || c === '$') {
      const m = VARNAME_RE.exec(src.slice(i + 1));
      if (!m) throw new QueryError(`bad variable name at offset ${i}`);
      tokens.push({ k: 'var', v: m[0] });
      i += 1 + m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== quote) {
        if (src[j] === '\\') {
          const esc = src[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j++];
        }
      }
      if (j >= src.length) throw new QueryError('unterminated string literal');
      const token = { k: 'str', v: out };
      i = j + 1;
      if (src[i] === '@') { // language tag, stored but ignored by matching
        const lm = /^[A-Za-z]+(?:-[A-Za-z0-9]+)*/.exec(src.slice(i + 1));
        if (lm) { token.lang = lm[0]; i += 1 + lm[0].length; }
      }
      tokens.push(token);
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = NUM_TOKEN_RE.exec(src.slice(i));
      tokens.push({ k: 'num', v: m[0] });
      i += m[0].length;
      continue;
    }
    if ('{}().,;*'.includes(c)) { tokens.push({ k: 'punc', v: c }); i++; continue; }
    const pm = PNAME_RE.exec(src.slice(i));
    if (pm && pm[0].includes(':')) {
      tokens.push({ k: 'pname', p: pm[1] || '', l: pm[2] || '' });
      i += pm[0].length;
      continue;
    }
    const wm = WORD_RE.exec(src.slice(i));
    if (wm) { tokens.push({ k: 'word', v: wm[0] }); i += wm[0].length; continue; }
    throw new QueryError(`unexpected character '${c}' at offset ${i}`);
  }
  return tokens;
}

// ------------------------------------------------------------------ parser
//
// Grammar (the SUPPORTED SUBSET — see README.md):
//   Query      := (PREFIX pname: <iri>)* SELECT [DISTINCT] (?var+ | *)
//                 [FROM <iri>] WHERE { (Triples | Filter)* } [LIMIT n]
//   Update     := (PREFIX pname: <iri>)* (INSERT|DELETE) DATA '{' QuadData '}'
//   QuadData   := GRAPH <iri> '{' Triples* '}' | Triples*
//   Triples    := Term Verb ObjList (';' Verb ObjList)* ['.']
//   ObjList    := Term (',' Term)*
//   Filter     := FILTER '(' Constraint ')'
//   Constraint := Operand (=|!=|<|>|<=|>=) Operand
//               | CONTAINS '(' Operand ',' Operand ')'
//               | REGEX '(' Operand ',' Operand [',' "flags"] ')'
//
// The token reader (cursor + PREFIX handling + term resolution) is shared
// by parseQuery and parseUpdate so both speak the exact same term language.

function reader(src) {
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const isWord = (t, w) => t && t.k === 'word' && t.v.toUpperCase() === w;
  const isPunc = (t, ch) => t && t.k === 'punc' && t.v === ch;
  const expectPunc = (ch) => {
    const t = next();
    if (!isPunc(t, ch)) throw new QueryError(`expected '${ch}'`);
  };

  const prefixes = {
    rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    xsd: XSD,
  };

  const resolveDatatype = () => {
    const t = next();
    if (t?.k === 'iri') return t.v;
    if (t?.k === 'pname') {
      if (!(t.p in prefixes)) throw new QueryError(`unknown prefix '${t.p}:'`);
      return prefixes[t.p] + t.l;
    }
    throw new QueryError('expected a datatype after ^^');
  };

  const resolveTerm = (t) => {
    if (!t) throw new QueryError('unexpected end of query');
    if (t.k === 'var') return { t: 'var', v: t.v };
    if (t.k === 'iri') return { t: 'iri', v: t.v };
    if (t.k === 'pname') {
      if (!(t.p in prefixes)) throw new QueryError(`unknown prefix '${t.p}:'`);
      return { t: 'iri', v: prefixes[t.p] + t.l };
    }
    if (t.k === 'word' && t.v === 'a') return { t: 'iri', v: RDF_TYPE };
    if (t.k === 'word' && /^(true|false)$/i.test(t.v)) {
      return { t: 'lit', v: t.v.toLowerCase(), dt: XSD + 'boolean' };
    }
    if (t.k === 'str') {
      const term = { t: 'lit', v: t.v };
      if (t.lang) term.lang = t.lang;
      if (peek()?.k === 'dtsep') { next(); term.dt = resolveDatatype(); }
      return term;
    }
    if (t.k === 'num') {
      return { t: 'lit', v: t.v, dt: XSD + (t.v.includes('.') ? 'decimal' : 'integer') };
    }
    throw new QueryError(`unexpected token in pattern: '${t.v ?? t.k}'`);
  };

  const parsePrologue = () => { // PREFIX declarations
    while (isWord(peek(), 'PREFIX')) {
      next();
      const pn = next();
      if (!pn || pn.k !== 'pname' || pn.l) throw new QueryError('PREFIX expects a namespace like `schema:`');
      const iri = next();
      if (!iri || iri.k !== 'iri') throw new QueryError('PREFIX expects an <iri>');
      prefixes[pn.p] = iri.v;
    }
  };

  return { peek, next, isWord, isPunc, expectPunc, resolveTerm, parsePrologue };
}

/** One `Subject Verb ObjList (';' Verb ObjList)* ['.']` group into `sink`. */
function parseTriplesGroup(r, sink) {
  const subj = r.resolveTerm(r.next());
  if (subj.t === 'lit') throw new QueryError('a literal cannot be a subject');
  do {
    const verb = r.resolveTerm(r.next());
    if (verb.t === 'lit') throw new QueryError('a literal cannot be a predicate');
    do {
      sink.push({ s: subj, p: verb, o: r.resolveTerm(r.next()) });
    } while (r.isPunc(r.peek(), ',') && r.next());
  } while (r.isPunc(r.peek(), ';') && r.next());
  if (r.isPunc(r.peek(), '.')) r.next();
}

function parseQuery(src) {
  if (src.length > MAX_QUERY_LENGTH) throw new QueryError('query too long');
  const r = reader(src);
  r.parsePrologue();

  if (!r.isWord(r.peek(), 'SELECT')) throw new QueryError('only SELECT queries are supported');
  r.next();
  let distinct = false;
  if (r.isWord(r.peek(), 'DISTINCT')) { r.next(); distinct = true; }
  let star = false;
  const projected = [];
  if (r.isPunc(r.peek(), '*')) { r.next(); star = true; }
  else {
    while (r.peek()?.k === 'var') projected.push(r.next().v);
    if (!projected.length) throw new QueryError('SELECT needs ?vars or *');
  }

  let from = null;
  if (r.isWord(r.peek(), 'FROM')) {
    r.next();
    const t = r.next();
    if (t?.k !== 'iri') throw new QueryError('FROM expects an <iri>');
    from = t.v;
  }

  if (!r.isWord(r.peek(), 'WHERE')) throw new QueryError('expected WHERE');
  r.next();
  r.expectPunc('{');

  const patterns = [];
  const filters = [];

  const operand = () => r.resolveTerm(r.next());

  function parseConstraint() {
    if (r.isWord(r.peek(), 'CONTAINS') || r.isWord(r.peek(), 'REGEX')) {
      const fn = r.next().v.toUpperCase();
      r.expectPunc('(');
      const a = operand();
      r.expectPunc(',');
      const b = operand();
      let flags = '';
      if (fn === 'REGEX' && r.isPunc(r.peek(), ',')) {
        r.next();
        const f = r.next();
        if (f?.k !== 'str') throw new QueryError('REGEX flags must be a string');
        flags = f.v;
      }
      r.expectPunc(')');
      const constraint = { kind: fn.toLowerCase(), a, b, flags };
      if (fn === 'REGEX' && b.t === 'lit') {
        try { constraint.re = new RegExp(b.v, flags); }
        catch (e) { throw new QueryError(`bad REGEX pattern: ${e.message}`); }
      }
      return constraint;
    }
    const a = operand();
    const op = r.next();
    if (op?.k !== 'op') throw new QueryError('expected a comparison operator in FILTER');
    const b = operand();
    return { kind: 'cmp', op: op.v, a, b };
  }

  while (r.peek() && !r.isPunc(r.peek(), '}')) {
    if (r.isWord(r.peek(), 'FILTER')) {
      r.next();
      r.expectPunc('(');
      filters.push(parseConstraint());
      r.expectPunc(')');
      continue;
    }
    parseTriplesGroup(r, patterns);
  }
  r.expectPunc('}');

  let limit = null;
  while (r.peek()) {
    if (r.isWord(r.peek(), 'LIMIT')) {
      r.next();
      const n = r.next();
      if (n?.k !== 'num' || !/^\d+$/.test(n.v)) throw new QueryError('LIMIT expects a non-negative integer');
      limit = parseInt(n.v, 10);
      continue;
    }
    throw new QueryError(`unexpected trailing token '${r.peek().v ?? r.peek().k}'`);
  }

  if (!patterns.length) throw new QueryError('WHERE needs at least one triple pattern');
  return { distinct, star, projected, from, patterns, filters, limit };
}

// ----------------------------------------------------------- update parser
//
// SPARQL 1.1 Update, GROUND-DATA FORMS ONLY: INSERT DATA and DELETE DATA.
// The pattern forms (DELETE/INSERT … WHERE, WITH, USING), graph management
// (LOAD/CLEAR/CREATE/DROP/COPY/MOVE/ADD), multi-operation requests (';')
// and blank nodes in data blocks are all refused — the pattern forms with
// 501 (UnsupportedError), honestly, rather than half-implemented: applying
// a WHERE template needs bnode-safe instantiation against the store, which
// the read engine's per-document bnode relabelling cannot round-trip.

class UnsupportedError extends QueryError {}

const GRAPH_MGMT = new Set(['LOAD', 'CLEAR', 'CREATE', 'DROP', 'COPY', 'MOVE', 'ADD']);

function parseUpdate(src) {
  if (src.length > MAX_QUERY_LENGTH) throw new QueryError('update too long');
  const r = reader(src);
  r.parsePrologue();

  const head = r.next();
  if (!head) throw new QueryError('empty update');
  const headWord = head.k === 'word' ? head.v.toUpperCase() : null;
  if (headWord === 'WITH' || headWord === 'USING') {
    throw new UnsupportedError(`${headWord} … DELETE/INSERT … WHERE is not supported — only INSERT DATA and DELETE DATA`);
  }
  if (GRAPH_MGMT.has(headWord)) {
    throw new UnsupportedError(`${headWord} is not supported — only INSERT DATA and DELETE DATA`);
  }
  if (headWord !== 'INSERT' && headWord !== 'DELETE') {
    throw new QueryError('expected INSERT DATA or DELETE DATA');
  }
  if (!r.isWord(r.peek(), 'DATA')) {
    throw new UnsupportedError(`${headWord} with a template/WHERE form is not supported — only INSERT DATA and DELETE DATA (ground triples)`);
  }
  r.next(); // DATA
  const op = headWord === 'INSERT' ? 'insert' : 'delete';

  r.expectPunc('{');
  let graph = null;
  const triples = [];
  if (r.isWord(r.peek(), 'GRAPH')) {
    r.next();
    const g = r.next();
    if (g?.k !== 'iri') throw new QueryError('GRAPH expects an <iri>');
    graph = g.v;
    r.expectPunc('{');
    while (r.peek() && !r.isPunc(r.peek(), '}')) parseTriplesGroup(r, triples);
    r.expectPunc('}');
  } else {
    while (r.peek() && !r.isPunc(r.peek(), '}')) parseTriplesGroup(r, triples);
  }
  r.expectPunc('}');
  if (r.isPunc(r.peek(), ';')) {
    throw new UnsupportedError('multiple update operations in one request are not supported — send one INSERT DATA or DELETE DATA at a time');
  }
  if (r.peek()) throw new QueryError(`unexpected trailing token '${r.peek().v ?? r.peek().k}'`);

  if (!triples.length) throw new QueryError('the DATA block needs at least one triple');
  for (const tr of triples) {
    for (const part of [tr.s, tr.p, tr.o]) {
      if (part.t === 'var') {
        throw new QueryError('INSERT DATA / DELETE DATA take ground triples — variables are not allowed');
      }
    }
  }
  return { op, graph, triples };
}

// -------------------------------------------- JSON-LD → triples flattening
//
// Minimal, hand-rolled expansion. Handled: @context as object (prefix and
// term maps, {"@id": …, "@type": "@id"} defs, @vocab), @context as string
// (treated as @vocab — the schema.org heuristic), arrays of contexts, @id
// (resolved against the resource URL), @type (→ rdf:type), arrays, nested
// objects (named or blank), @value/@type/@language literal objects, @list
// (flattened to repeated triples), @graph. NOT handled: remote @context
// fetching, @reverse, @container maps, @nest. See README.md.

function parseContext(raw) {
  const ctx = { prefixes: {}, terms: {}, idTerms: new Set(), vocab: null };
  const entries = [];
  for (const part of [].concat(raw ?? [])) {
    if (typeof part === 'string') { ctx.vocab = part; continue; }
    if (part && typeof part === 'object') entries.push(...Object.entries(part));
  }
  for (const [k, v] of entries) { // pass 1: string mappings double as prefixes
    if (k === '@vocab' && typeof v === 'string') { ctx.vocab = v; continue; }
    if (k.startsWith('@')) continue;
    if (typeof v === 'string') { ctx.prefixes[k] = v; ctx.terms[k] = v; }
  }
  for (const [k, v] of entries) { // pass 2: object defs, resolved via pass 1
    if (!v || typeof v !== 'object' || k.startsWith('@')) continue;
    if (typeof v['@id'] === 'string') {
      ctx.terms[k] = expandPrefixed(v['@id'], ctx) ?? v['@id'];
    }
    if (v['@type'] === '@id') ctx.idTerms.add(k);
  }
  return ctx;
}

function expandPrefixed(name, ctx) {
  const m = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(name);
  if (m && ctx.prefixes[m[1]] !== undefined) return ctx.prefixes[m[1]] + m[2];
  return null;
}

function expandTerm(name, ctx) {
  if (Object.prototype.hasOwnProperty.call(ctx.terms, name)) return ctx.terms[name];
  const viaPrefix = expandPrefixed(name, ctx);
  if (viaPrefix) return viaPrefix;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(name)) return name; // already absolute
  if (ctx.vocab) return ctx.vocab + name;
  return null; // unmapped term with no @vocab: dropped
}

/**
 * Flatten one JSON-LD document into `triples`.
 * @param {*} doc          parsed JSON
 * @param {string} resourceIri  the resource's public URL (base for relative @id)
 * @param {Array} triples  sink; entries { s:{t,v}, p:{t:'iri',v}, o:{t,v} }
 * @param {Function} normalize  maps loopback-origin IRIs to the public origin
 * @param {string} docTag  unique per document, keeps blank labels apart
 */
function flattenDoc(doc, resourceIri, triples, normalize, docTag) {
  const ctx = parseContext(doc?.['@context']);
  let bn = 0;
  const emit = (s, p, o) => triples.push({ s, p: { t: 'iri', v: p }, o });

  const resolveId = (id) => {
    if (typeof id !== 'string') return null;
    if (id.startsWith('_:')) return `_:${docTag}.${id.slice(2)}`;
    try { return normalize(new URL(id, resourceIri).href); } catch { return null; }
  };

  const literalTerm = (value, dt, lang) => {
    if (typeof value === 'number') {
      return { t: 'lit', v: String(value), dt: XSD + (Number.isInteger(value) ? 'integer' : 'decimal') };
    }
    if (typeof value === 'boolean') return { t: 'lit', v: String(value), dt: XSD + 'boolean' };
    const term = { t: 'lit', v: String(value) };
    if (dt) term.dt = dt;
    if (lang) term.lang = lang;
    return term;
  };

  const iriOrBlank = (id) => (id.startsWith('_:') ? { t: 'bn', v: id } : { t: 'iri', v: id });

  function processNode(node) {
    const id = resolveId(node['@id']) ?? `_:${docTag}.b${bn++}`;
    const subj = iriOrBlank(id);
    for (const t of [].concat(node['@type'] ?? [])) {
      const iri = typeof t === 'string' ? expandTerm(t, ctx) : null;
      if (iri) emit(subj, RDF_TYPE, { t: 'iri', v: normalize(iri) });
    }
    for (const [key, raw] of Object.entries(node)) {
      if (key.startsWith('@')) continue;
      const pred = expandTerm(key, ctx);
      if (!pred) continue;
      addValue(subj, pred, key, raw);
    }
    return subj;
  }

  function addValue(subj, pred, key, val) {
    if (val === null || val === undefined) return;
    if (Array.isArray(val)) {
      for (const item of val) addValue(subj, pred, key, item);
      return;
    }
    if (typeof val === 'object') {
      if ('@value' in val) {
        const dt = typeof val['@type'] === 'string' ? expandTerm(val['@type'], ctx) : undefined;
        emit(subj, pred, literalTerm(val['@value'], dt || undefined, val['@language']));
      } else if ('@list' in val) {
        addValue(subj, pred, key, val['@list']); // order collapsed; documented
      } else {
        emit(subj, pred, processNode(val));
      }
      return;
    }
    if (typeof val === 'string' && ctx.idTerms.has(key)) {
      const iri = resolveId(val);
      if (iri) emit(subj, pred, iriOrBlank(iri));
      return;
    }
    emit(subj, pred, literalTerm(val));
  }

  for (const node of Array.isArray(doc) ? doc : [doc]) {
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node['@graph'])) {
      for (const g of node['@graph']) {
        if (g && typeof g === 'object') processNode(g);
      }
      const rest = { ...node };
      delete rest['@graph'];
      if (Object.keys(rest).some((k) => !k.startsWith('@')) || rest['@id'] || rest['@type']) {
        processNode(rest);
      }
    } else {
      processNode(node);
    }
  }
}

// -------------------------------------------- triples → JSON-LD (inverse)
//
// The exact inverse of flattenDoc's lens, used by the update path: group
// triples by subject into an `@graph` of node objects with absolute-IRI
// keys, `@type` for rdf:type, `{"@id"}` objects for IRI/bnode objects and
// `{"@value"[, "@type"|"@language"]}` objects for literals. Re-flattening
// the produced document yields the same triples (bnode labels aside).
// Consequence, documented in README: an update REWRITES the target through
// this lens — anything flattenDoc drops (unmapped terms, @list order, the
// original @context/formatting) does not survive an update.

function tripleEquals(a, b) {
  return termEquals(a.s, b.s) && termEquals(a.p, b.p) && termEquals(a.o, b.o);
}

function triplesToJsonLd(triples) {
  const nodes = new Map();
  const nodeFor = (id) => {
    if (!nodes.has(id)) nodes.set(id, { '@id': id });
    return nodes.get(id);
  };
  for (const tr of triples) {
    const node = nodeFor(tr.s.v);
    if (tr.p.v === RDF_TYPE && tr.o.t === 'iri') {
      node['@type'] = [].concat(node['@type'] ?? [], [tr.o.v]);
      continue;
    }
    let obj;
    if (tr.o.t === 'iri' || tr.o.t === 'bn') {
      obj = { '@id': tr.o.v };
    } else {
      obj = { '@value': tr.o.v };
      if (tr.o.dt && tr.o.dt !== XSD + 'string') obj['@type'] = tr.o.dt;
      if (tr.o.lang) obj['@language'] = tr.o.lang;
    }
    node[tr.p.v] = [].concat(node[tr.p.v] ?? [], [obj]);
  }
  return { '@graph': [...nodes.values()] };
}

// --------------------------------------------------------------- evaluator

const NUMERIC_RE = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function termEquals(a, b) {
  return a.t === b.t && a.v === b.v; // datatype-insensitive; documented
}

function matchTerm(pat, val, row) {
  if (pat.t === 'var') {
    const bound = row[pat.v];
    if (bound) return termEquals(bound, val) ? row : null;
    return { ...row, [pat.v]: val };
  }
  return termEquals(pat, val) ? row : null;
}

function evalBGP(triples, patterns) {
  let rows = [{}];
  for (const pat of patterns) {
    const nextRows = [];
    for (const row of rows) {
      for (const tr of triples) {
        let r = matchTerm(pat.s, tr.s, row);
        if (r) r = matchTerm(pat.p, tr.p, r);
        if (r) r = matchTerm(pat.o, tr.o, r);
        if (r) nextRows.push(r);
      }
      if (nextRows.length > MAX_JOIN_ROWS) throw new QueryError('join too large; narrow the patterns');
    }
    rows = nextRows;
    if (!rows.length) break;
  }
  return rows;
}

function compare(x, y, op) {
  switch (op) {
    case '=': return x === y;
    case '!=': return x !== y;
    case '<': return x < y;
    case '>': return x > y;
    case '<=': return x <= y;
    case '>=': return x >= y;
    default: return false;
  }
}

function applyFilter(f, row) {
  const A = f.a.t === 'var' ? row[f.a.v] : f.a;
  const B = f.b.t === 'var' ? row[f.b.v] : f.b;
  if (!A || !B) return false; // unbound → filter fails (SPARQL error semantics)
  const a = A.v;
  const b = B.v;
  switch (f.kind) {
    case 'cmp':
      if (NUMERIC_RE.test(a) && NUMERIC_RE.test(b)) return compare(parseFloat(a), parseFloat(b), f.op);
      return compare(a, b, f.op);
    case 'contains':
      return a.includes(b);
    case 'regex': {
      try {
        const re = f.re ?? new RegExp(b, f.flags);
        return re.test(a);
      } catch { return false; }
    }
    default:
      return false;
  }
}

function toBinding(term) {
  if (term.t === 'iri') return { type: 'uri', value: term.v };
  if (term.t === 'bn') return { type: 'bnode', value: term.v.slice(2) };
  const b = { type: 'literal', value: term.v };
  if (term.dt && term.dt !== XSD + 'string') b.datatype = term.dt;
  if (term.lang) b['xml:lang'] = term.lang;
  return b;
}

function varsInPatterns(patterns) {
  const vars = [];
  for (const pat of patterns) {
    for (const part of [pat.s, pat.p, pat.o]) {
      if (part.t === 'var' && !vars.includes(part.v)) vars.push(part.v);
    }
  }
  return vars;
}

// ---------------------------------------------------------------- activate

export async function activate(api) {
  const routePath = api.prefix || '/sparql';
  const baseUrl = (api.config.baseUrl || '').replace(/\/$/, '');
  if (!baseUrl) {
    throw new Error(
      'sparql plugin requires config.baseUrl — the plugin api does not expose ' +
      'the server\'s public origin (same api.serverInfo finding as notifications/)',
    );
  }
  const loopback = (api.config.loopbackUrl || baseUrl).replace(/\/$/, '');
  const defaultContainer = api.config.defaultContainer || null;
  const maxDepth = api.config.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxResources = api.config.maxResources ?? DEFAULT_MAX_RESOURCES;
  const resultCap = api.config.resultCap ?? DEFAULT_RESULT_CAP;
  const origin = new URL(baseUrl).origin;

  /** Map any loopback-origin IRI back to the public origin. */
  const normalize = (iri) =>
    iri === loopback ? baseUrl
      : iri.startsWith(loopback + '/') ? baseUrl + iri.slice(loopback.length)
      : iri;

  /**
   * Walk `containerPath` over loopback with the caller's own Authorization
   * header: containers via their ldp:contains listing (recursively, bounded
   * by maxDepth/maxResources), everything else probed and parsed only when
   * the server serves it as JSON. A resource the caller cannot GET simply
   * contributes no triples — WAC by construction.
   */
  async function collectTriples(containerPath, authorization) {
    const triples = [];
    const visited = new Set();
    const state = { fetched: 0, truncated: false };
    let docCounter = 0;

    async function fetchDoc(path) {
      state.fetched++;
      let res;
      try {
        res = await fetch(loopback + path, {
          redirect: 'manual',
          headers: {
            accept: 'application/ld+json, application/json;q=0.9',
            ...(authorization ? { authorization } : {}),
          },
        });
      } catch {
        return null;
      }
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (!res.ok || !contentType.includes('json')) {
        try { await res.body?.cancel(); } catch { /* already drained */ }
        return null;
      }
      try { return await res.json(); } catch { return null; }
    }

    async function walk(path, depth) {
      if (visited.has(path)) return;
      if (state.fetched >= maxResources) { state.truncated = true; return; }
      visited.add(path);
      const doc = await fetchDoc(path);
      if (doc == null) return;
      const before = triples.length;
      flattenDoc(doc, baseUrl + path, triples, normalize, `d${docCounter++}`);
      if (!path.endsWith('/') || depth >= maxDepth) {
        if (path.endsWith('/') && depth >= maxDepth) state.truncated = true;
        return;
      }
      const children = triples.slice(before)
        .filter((tr) => tr.p.v === LDP_CONTAINS && tr.o.t === 'iri')
        .map((tr) => tr.o.v);
      for (const child of children) {
        let u;
        try { u = new URL(child); } catch { continue; }
        if (u.origin !== origin) continue;
        if (/\.(acl|meta)$/i.test(u.pathname)) continue;
        await walk(u.pathname, depth + 1);
      }
    }

    await walk(containerPath, 0);
    return { triples, truncated: state.truncated, resources: visited.size };
  }

  /**
   * SPARQL UPDATE (INSERT DATA / DELETE DATA) against ONE pod resource:
   * GET the target over loopback with the caller's own Authorization
   * (capturing the host's ETag), flatten it with the read side's lens,
   * merge/filter the ground triples, serialize with the inverse lens, and
   * PUT back with If-Match (If-None-Match: * when creating). On 412 the
   * whole read-transform-write is retried once, then 409 to the caller —
   * the conditional-write pass-through remotestorage/ measured, second
   * consumer.
   */
  async function handleUpdate(request, reply, body) {
    let update;
    try {
      update = parseUpdate(body);
    } catch (err) {
      if (err instanceof UnsupportedError) return reply.code(501).send({ error: err.message });
      if (err instanceof QueryError) return reply.code(400).send({ error: err.message });
      throw err;
    }

    // Target: the update names ONE resource (the read side's "a resource is
    // a graph" model, inverted) — GRAPH <iri> {} in the data block or
    // ?resource=/path on the URL.
    let resourcePath = null;
    if (update.graph) {
      let u;
      try { u = new URL(update.graph); } catch {
        return reply.code(400).send({ error: 'GRAPH must be an absolute IRI' });
      }
      if (u.origin !== origin) {
        return reply.code(400).send({ error: `GRAPH must be on this server (${origin}); no federation` });
      }
      resourcePath = u.pathname;
    }
    if (typeof request.query?.resource === 'string' && request.query.resource) {
      if (!request.query.resource.startsWith('/')) {
        return reply.code(400).send({ error: '?resource= must be an absolute path like /alice/notes.jsonld' });
      }
      if (resourcePath && resourcePath !== request.query.resource) {
        return reply.code(400).send({ error: 'GRAPH <iri> and ?resource= disagree — name the target once' });
      }
      resourcePath = resourcePath ?? request.query.resource;
    }
    if (!resourcePath) {
      return reply.code(400).send({
        error: 'name the target resource: GRAPH <iri> { … } in the update, or ?resource=/path',
      });
    }
    if (resourcePath.endsWith('/')) {
      return reply.code(400).send({ error: 'the target must be a single resource, not a container' });
    }
    if (/\.(acl|meta)$/i.test(resourcePath)) {
      return reply.code(400).send({
        error: '.acl/.meta sidecars are not updatable through this endpoint (the read side skips them too)',
      });
    }

    const authorization = request.headers.authorization ?? null;
    const authHeaders = authorization ? { authorization } : {};
    const drain = async (res) => { try { await res.body?.cancel(); } catch { /* drained */ } };

    let retried = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      let got;
      try {
        got = await fetch(loopback + resourcePath, {
          redirect: 'manual',
          headers: { accept: 'application/ld+json, application/json;q=0.9', ...authHeaders },
        });
      } catch {
        return reply.code(502).send({ error: `loopback GET ${resourcePath} failed` });
      }
      let etag = null;
      let exists = false;
      const baseTriples = [];
      if (got.status === 401 || got.status === 403) {
        await drain(got);
        return reply.code(got.status)
          .send({ error: `the host refused ${resourcePath} (${got.status}) — WAC decides, not this plugin` });
      }
      if (got.ok) {
        const ct = (got.headers.get('content-type') || '').toLowerCase();
        if (!ct.includes('json')) {
          await drain(got);
          return reply.code(409).send({
            error: 'the target resource is not JSON(-LD) — this endpoint updates exactly the resources the read side can see',
          });
        }
        let doc;
        try { doc = await got.json(); } catch {
          return reply.code(409).send({ error: 'the target resource is not parseable JSON' });
        }
        etag = got.headers.get('etag');
        exists = true;
        flattenDoc(doc, baseUrl + resourcePath, baseTriples, normalize, 'd0');
      } else if (got.status === 404) {
        await drain(got);
        if (update.op === 'delete') {
          return reply.code(404).send({ error: `${resourcePath} does not exist` });
        }
        // insert into a missing resource creates it (PUT If-None-Match: *)
      } else {
        await drain(got);
        return reply.code(502).send({ error: `loopback GET ${resourcePath} → ${got.status}` });
      }

      let result;
      let inserted = 0;
      let removed = 0;
      if (update.op === 'insert') {
        result = baseTriples.slice();
        for (const tr of update.triples) {
          if (!result.some((x) => tripleEquals(x, tr))) { result.push(tr); inserted++; }
        }
      } else {
        result = baseTriples.filter((x) => !update.triples.some((tr) => tripleEquals(x, tr)));
        removed = baseTriples.length - result.length;
      }

      const summary = {
        ok: true,
        op: update.op === 'insert' ? 'INSERT DATA' : 'DELETE DATA',
        resource: baseUrl + resourcePath,
        inserted,
        removed,
        triples: result.length,
        retried,
      };

      if (exists && inserted === 0 && removed === 0) {
        // No-op: don't touch the resource at all.
        reply.header('content-type', 'application/json');
        return JSON.stringify(summary);
      }

      const putHeaders = { 'content-type': 'application/ld+json', ...authHeaders };
      if (exists) {
        if (etag) putHeaders['if-match'] = etag; // unconditional only if the host sent no ETag
      } else {
        putHeaders['if-none-match'] = '*';
      }
      let put;
      try {
        put = await fetch(loopback + resourcePath, {
          method: 'PUT',
          redirect: 'manual',
          headers: putHeaders,
          body: JSON.stringify(triplesToJsonLd(result)),
        });
      } catch {
        return reply.code(502).send({ error: `loopback PUT ${resourcePath} failed` });
      }
      await drain(put);
      if (put.status === 412) { retried = true; continue; } // raced: re-read once
      if (put.status === 401 || put.status === 403) {
        return reply.code(put.status)
          .send({ error: `the host refused to write ${resourcePath} (${put.status}) — WAC decides, not this plugin` });
      }
      if (!put.ok) {
        return reply.code(502).send({ error: `loopback PUT ${resourcePath} → ${put.status}` });
      }
      reply.header('content-type', 'application/json');
      return JSON.stringify(summary);
    }
    return reply.code(409).send({
      error: 'concurrent writes kept changing the resource (If-Match failed twice) — retry the update',
    });
  }

  // Discovery: GET describes the endpoint and its subset.
  api.fastify.get(routePath, async (request, reply) => {
    reply.header('content-type', 'application/json');
    return JSON.stringify({
      endpoint: routePath,
      accepts: 'application/sparql-query | application/sparql-update (POST)',
      returns: 'application/sparql-results+json (query) | application/json summary (update)',
      subset: 'SELECT [DISTINCT] (?vars|*) [FROM <iri>] WHERE { BGP, FILTER(cmp|CONTAINS|REGEX) } [LIMIT n]',
      updateSubset: 'INSERT DATA / DELETE DATA with ground triples; target via GRAPH <iri> {} or ?resource=/path',
      scope: 'FROM <iri> | ?container=/path/ | config.defaultContainer',
      limits: { maxDepth, maxResources, resultCap },
    });
  });

  api.fastify.post(routePath, async (request, reply) => {
    const contentType = (request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const body = Buffer.isBuffer(request.body) ? request.body.toString('utf8') : String(request.body ?? '');
    if (contentType === 'application/sparql-update') {
      return handleUpdate(request, reply, body);
    }
    if (contentType !== 'application/sparql-query') {
      return reply.code(415).send({
        error: 'POST a query with Content-Type: application/sparql-query, or an update with application/sparql-update',
      });
    }

    let query;
    try {
      query = parseQuery(body);
    } catch (err) {
      if (err instanceof QueryError) return reply.code(400).send({ error: err.message });
      throw err;
    }

    // Scope: which container's subtree to query.
    let containerPath = null;
    if (query.from) {
      let u;
      try { u = new URL(query.from); } catch {
        return reply.code(400).send({ error: 'FROM must be an absolute IRI' });
      }
      if (u.origin !== origin) {
        return reply.code(400).send({ error: `FROM must be on this server (${origin}); no federation` });
      }
      containerPath = u.pathname;
    } else if (typeof request.query?.container === 'string' && request.query.container) {
      if (!request.query.container.startsWith('/')) {
        return reply.code(400).send({ error: '?container= must be an absolute path like /alice/photos/' });
      }
      containerPath = request.query.container;
    } else if (defaultContainer) {
      containerPath = defaultContainer;
    }
    if (!containerPath) {
      return reply.code(400).send({
        error: 'name a scope: FROM <iri> in the query, ?container=/path/, or config.defaultContainer',
      });
    }

    // The caller's own credentials ride along on every loopback fetch, so
    // the dataset is exactly what THEY could read — WAC by construction.
    const authorization = request.headers.authorization ?? null;
    const { triples, truncated, resources } = await collectTriples(containerPath, authorization);

    let rows;
    try {
      rows = evalBGP(triples, query.patterns)
        .filter((row) => query.filters.every((f) => applyFilter(f, row)));
    } catch (err) {
      if (err instanceof QueryError) return reply.code(400).send({ error: err.message });
      throw err;
    }

    const vars = query.star ? varsInPatterns(query.patterns) : query.projected;
    let bindings = rows.map((row) => {
      const b = {};
      for (const v of vars) if (row[v]) b[v] = toBinding(row[v]);
      return b;
    });
    if (query.distinct) {
      const seen = new Set();
      bindings = bindings.filter((b) => {
        const key = JSON.stringify(b);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    bindings = bindings.slice(0, Math.min(query.limit ?? resultCap, resultCap));

    reply.header('content-type', 'application/sparql-results+json');
    reply.header('x-sparql-scope-resources', String(resources));
    if (truncated) reply.header('x-sparql-scope-truncated', 'true');
    return JSON.stringify({ head: { vars }, results: { bindings } });
  });

  api.log.info(`sparql: SELECT + INSERT/DELETE DATA endpoint at ${routePath} (read-time crawl; no write-time index — see README findings)`);
}
