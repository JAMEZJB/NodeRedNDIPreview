"use strict";
// Verbose logging, shared by the nodes, the client of the NDI host and the NDI host itself.
//
// A logger made here writes one line per event, starting with an area in square brackets ("[host] ...",
// "[receiver] ..."), through whatever `emit` is given (a node's log, Node-RED's log, or the IPC channel of the NDI
// host). Nothing is written until `on` is true, so the switch costs a property read.
//
// Never pass frame or image contents, message payloads or credentials to it: callers give counts, sizes, names and
// reasons only. Control characters in what is logged are replaced, so a source name cannot forge a second line.

const MAX_LINE = 2000;
const MAX_VALUE = 200;

// control characters (C0, DEL, C1), line and paragraph separators, and the bidirectional overrides that could make a
// line read differently from what it says
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g;

const clean = (s) => {
  const t = String(s).replace(CONTROL, " ");
  return t.length > MAX_LINE ? t.slice(0, MAX_LINE - 1) + "…" : t;
};

// one value that came from outside (a topic, a source name, an error from the runtime): cleaned and kept short, so
// it cannot crowd out the rest of its line
const short = (s, max = MAX_VALUE) => {
  const t = String(s).replace(CONTROL, " ");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

function createVLog(emit, { on = false } = {}) {
  const limits = new Map();                // key -> { last, left out }
  const v = {
    on,
    // one line, now
    line(area, text) {
      if (!v.on) return;
      try { emit(clean(`[${area}] ${text}`)); } catch (e) { /* logging never breaks the caller */ }
    },
    // a line that already starts with its area (it comes from the NDI host process)
    raw(text) {
      if (!v.on) return;
      try { emit(clean(text)); } catch (e) { /* logging never breaks the caller */ }
    },
    // a line that may repeat quickly (one per grab, one per request): at most one every `everyMs` for each `key`;
    // the next line that is written says how many were left out
    rate(key, area, text, everyMs = 1000) {
      if (!v.on) return;
      const now = Date.now();
      let l = limits.get(key);
      if (!l) { l = { last: 0, skipped: 0 }; limits.set(key, l); if (limits.size > 200) limits.delete(limits.keys().next().value); }
      if (now - l.last < everyMs) { l.skipped++; return; }
      const extra = l.skipped ? ` (${l.skipped} similar line${l.skipped === 1 ? " was" : "s were"} left out since the last one shown)` : "";
      l.last = now; l.skipped = 0;
      v.line(area, text + extra);
    },
  };
  return v;
}

// 1204 -> "1,204"; 5300 -> "5.2 KB"
const bytes = (n) => (n >= 10240 ? `${(n / 1024).toFixed(1)} KB` : `${Number(n).toLocaleString("en-GB")} bytes`);

module.exports = { createVLog, bytes, clean, short, MAX_LINE, MAX_VALUE };
