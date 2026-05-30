'use strict';

// Natural / "human" sort that orders embedded numbers numerically:
//   aaa1, aaa2, aaa9, aaa10, aaa11, aaa12   (not aaa1, aaa10, aaa11, aaa2 ...)
// Uses Intl collation with numeric mode, which handles digit runs of any length
// and is locale-aware, with a manual tokenized fallback for older runtimes.

let collator = null;
try {
  collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: 'base'
  });
} catch (_) {
  collator = null;
}

function tokenize(str) {
  // Split into alternating non-digit / digit chunks.
  return String(str).match(/(\d+|\D+)/g) || [];
}

function fallbackCompare(a, b) {
  const ta = tokenize(a.toLowerCase());
  const tb = tokenize(b.toLowerCase());
  const len = Math.min(ta.length, tb.length);
  for (let i = 0; i < len; i++) {
    const x = ta[i];
    const y = tb[i];
    const xn = /^\d/.test(x);
    const yn = /^\d/.test(y);
    if (xn && yn) {
      const dx = parseInt(x, 10);
      const dy = parseInt(y, 10);
      if (dx !== dy) return dx - dy;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return ta.length - tb.length;
}

function naturalCompare(a, b) {
  if (collator) return collator.compare(String(a), String(b));
  return fallbackCompare(String(a), String(b));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { naturalCompare };
}
