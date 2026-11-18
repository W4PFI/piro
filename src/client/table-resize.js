// Draggable column dividers for the digital-mode decode tables
// (FT8/JS8/JTTY — the "UTC … Freq SNR Message" shape). Desktop/wide view
// only: the dividers and the custom widths apply at >= 900px, matching the
// responsive full-width layout. On phones/narrow windows nothing here runs,
// so the existing compact fixed-column layout (styles.css) is untouched.
//
// How it works: each resizable (non-last) column gets an explicit pixel
// width; the last column (Message) stays flexible (minmax(…, 1fr)) so it is
// always the widest and soaks up the remaining space. Widths are written to
// a single CSS custom property (--ft8-cols) on the table element, so the
// dynamically-added rows inherit them without per-row JS. Per-table widths
// are remembered in localStorage; double-click a divider to reset a column
// to its default.

const DESKTOP = '(min-width: 900px)';
const STORE_PREFIX = 'piro.cols.';
const MIN_W = 40; // px, a column can't be dragged narrower than this
const MAX_W = 420; // px, nor wider than this
const FLEX_MIN = 100; // px, the Message column never collapses past this

// Sensible, balanced defaults by header label (Message is flexible, not
// listed). Anything unrecognised falls back to DEFAULT_W.
const DEFAULT_W = 76;
const WIDTH_BY_LABEL = {
  UTC: 72,
  dt: 54,
  Freq: 86,
  SNR: 60,
};

function headerCells(table) {
  const head = table.querySelector('.ft8-table__head');
  return head ? Array.from(head.querySelectorAll('[role="columnheader"]')) : [];
}

function storageKey(table) {
  return STORE_PREFIX + (table.id || table.getAttribute('aria-label') || 'table');
}

function defaultsFor(cells) {
  // One width per resizable (non-last) column.
  return cells.slice(0, -1).map((c) => {
    const label = (c.textContent || '').trim();
    return WIDTH_BY_LABEL[label] || DEFAULT_W;
  });
}

function loadWidths(table, expectedLen) {
  try {
    const raw = localStorage.getItem(storageKey(table));
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length !== expectedLen) return null;
    if (!arr.every((n) => Number.isFinite(n) && n >= MIN_W && n <= MAX_W)) return null;
    return arr;
  } catch {
    return null; // private mode / blocked storage: just use defaults
  }
}

function saveWidths(table, widths) {
  try {
    localStorage.setItem(storageKey(table), JSON.stringify(widths));
  } catch {
    // not remembered — the live layout still works for this session
  }
}

function applyWidths(table, widths) {
  // widths: px for each non-last column; last column flexes to fill.
  const cols = widths.map((w) => `${Math.round(w)}px`);
  cols.push(`minmax(${FLEX_MIN}px, 1fr)`);
  table.style.setProperty('--ft8-cols', cols.join(' '));
}

function setupTable(table) {
  const cells = headerCells(table);
  if (cells.length < 2) return null; // nothing meaningful to resize

  const resizableCount = cells.length - 1; // last column is the flex column
  const defaults = defaultsFor(cells);
  let widths = loadWidths(table, resizableCount) || defaults.slice();

  const handles = [];

  function enable() {
    table.setAttribute('data-resizable', '');
    applyWidths(table, widths);
    // Build one divider on the right edge of every non-last header cell.
    cells.slice(0, -1).forEach((cell, i) => {
      if (cell.querySelector('.ft8-col-resizer')) return;
      const handle = document.createElement('span');
      handle.className = 'ft8-col-resizer';
      handle.setAttribute('aria-hidden', 'true');
      attachDrag(handle, table, i, () => widths, (next) => {
        widths = next;
      }, defaults);
      cell.appendChild(handle);
      handles.push(handle);
    });
  }

  function disable() {
    table.removeAttribute('data-resizable');
    table.style.removeProperty('--ft8-cols');
    while (handles.length) handles.pop().remove();
    // Defensive: drop any stragglers from a previous build.
    table.querySelectorAll('.ft8-col-resizer').forEach((h) => h.remove());
  }

  return { enable, disable };
}

function attachDrag(handle, table, index, getWidths, setWidths, defaults) {
  let startX = 0;
  let startW = 0;
  let live = null;

  function onMove(e) {
    const dx = e.clientX - startX;
    let w = startW + dx;
    if (w < MIN_W) w = MIN_W;
    if (w > MAX_W) w = MAX_W;
    live = getWidths().slice();
    live[index] = w;
    applyWidths(table, live);
  }

  function onUp(e) {
    handle.classList.remove('is-dragging');
    try {
      handle.releasePointerCapture(e.pointerId);
    } catch {
      // ignore — capture may not have been set
    }
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (live) {
      setWidths(live);
      saveWidths(table, live);
      live = null;
    }
  }

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    startX = e.clientX;
    startW = getWidths()[index];
    handle.classList.add('is-dragging');
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });

  // Double-click a divider: reset just that column to its default width.
  handle.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const next = getWidths().slice();
    next[index] = defaults[index];
    setWidths(next);
    applyWidths(table, next);
    saveWidths(table, next);
  });
}

export function initColumnResize() {
  // The message-shaped decode tables only: FT8, JTTY, JS8. WSPR has a
  // different 7-column shape (no Message), so it's intentionally excluded.
  const tables = Array.from(document.querySelectorAll('.ft8-table:not(.wspr-table)'));
  const controllers = tables.map(setupTable).filter(Boolean);
  if (!controllers.length) return;

  const mq = window.matchMedia(DESKTOP);
  function sync() {
    for (const c of controllers) {
      if (mq.matches) c.enable();
      else c.disable();
    }
  }
  sync();
  // Adapt live when the window crosses the breakpoint or a device rotates.
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', sync);
  else if (typeof mq.addListener === 'function') mq.addListener(sync); // older Safari
}
