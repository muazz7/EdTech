/**
 * Verifies the design tokens against WCAG 2.1 contrast requirements.
 *
 *   node scripts/contrast-check.mjs
 *
 * The palette is deliberately bright, and bright colours fail as text. This
 * encodes which token may be used for what, so a future tweak that makes a
 * label unreadable fails here instead of in front of a student.
 *
 * Thresholds: 4.5:1 normal text, 3:1 large text and UI component boundaries.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'src', 'app', 'globals.css');
const css = readFileSync(CSS, 'utf8');

/**
 * Tokens are declared twice — light in @theme, dark under [data-theme='dark'].
 * Dark is opt-in, not media-query driven, so an OS-level dark preference cannot
 * override the intended light default.
 */
// The selector with its brace. Matching on a specific first property is
// brittle — it broke the moment `color-scheme` was added above the tokens, and
// a broken split silently reports SKIP rather than failing loudly.
const DARK_MARKER = "[data-theme='dark'] {";

function tokens(scope) {
  const source =
    scope === 'dark'
      ? (css.split(DARK_MARKER)[1] ?? '')
      : (css.split(DARK_MARKER)[0] ?? '');

  const map = {};
  for (const match of source.matchAll(/(--color-[a-z-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    map[match[1]] = match[2];
  }
  return map;
}

function luminance(hex) {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

let failures = 0;

function assertPair(scope, map, fg, bg, min, note) {
  const fgHex = map[fg] ?? fg;
  const bgHex = map[bg] ?? bg;
  if (!fgHex?.startsWith('#') || !bgHex?.startsWith('#')) {
    // A missing token means the parser lost the block, not that the pair is
    // fine. Counting it as a failure stops a silent pass.
    failures++;
    console.log(`FAIL  [${scope}] ${fg} on ${bg} — token not found, parser out of date`);
    return;
  }
  const ratio = contrast(fgHex, bgHex);
  const pass = ratio >= min;
  if (!pass) failures++;
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  [${scope}] ${fg} on ${bg} = ${ratio.toFixed(2)}:1 ` +
      `(need ${min}:1) — ${note}`,
  );
}

/** The vivid hues must NOT be usable as text. If one becomes readable it has
 *  stopped being vivid, and the palette has drifted back to muted. */
function assertVivid(scope, map, token, bg) {
  const ratio = contrast(map[token], map[bg]);
  const decorative = ratio < 4.5;
  if (!decorative) failures++;
  console.log(
    `${decorative ? 'PASS' : 'FAIL'}  [${scope}] ${token} on ${bg} = ${ratio.toFixed(2)}:1 ` +
      '— must stay below 4.5:1 (fills only, never text)',
  );
}

for (const scope of ['light', 'dark']) {
  const map = tokens(scope);
  console.log(`\n--- ${scope} ---`);

  assertPair(scope, map, '--color-foreground', '--color-background', 4.5, 'body text');
  assertPair(scope, map, '--color-foreground', '--color-surface', 4.5, 'text on cards');
  assertPair(scope, map, '--color-muted-foreground', '--color-background', 4.5, 'secondary text');
  assertPair(scope, map, '--color-primary', '--color-background', 4.5, 'links and ghost buttons');
  assertPair(scope, map, '--color-on-primary', '--color-primary', 4.5, 'primary button label');
  assertPair(scope, map, '--color-success', '--color-background', 4.5, 'success text');
  assertPair(scope, map, '--color-warning', '--color-background', 4.5, 'warning text');
  assertPair(scope, map, '--color-destructive', '--color-background', 4.5, 'error text');
  assertPair(
    scope,
    map,
    '--color-on-destructive',
    '--color-destructive',
    4.5,
    'danger button label',
  );
  assertPair(
    scope,
    map,
    '--color-border-strong',
    '--color-background',
    3,
    'input and control boundaries (WCAG 1.4.11)',
  );

  // Chips: the label uses --color-foreground on each tint.
  for (const tint of ['--color-cyan-tint', '--color-yellow-tint', '--color-coral-tint']) {
    assertPair(scope, map, '--color-foreground', tint, 4.5, 'chip label');
  }

  // Vivid hues on the page background.
  if (scope === 'light') {
    for (const vivid of ['--color-cyan-vivid', '--color-yellow-vivid', '--color-coral-vivid']) {
      assertVivid(scope, map, vivid, '--color-background');
    }
  }
}

console.log(
  `\n${failures === 0 ? 'ALL CONTRAST CHECKS PASSED' : `${failures} CONTRAST CHECK(S) FAILED`}`,
);
process.exit(failures === 0 ? 0 : 1);
