// Draggable column dividers for the digital-mode decode tables
// (FT8/JS8/JTTY/WSPR). Desktop/wide view only: the dividers and the custom
// widths apply at >= 900px, matching the responsive full-width layout. On
// phones/narrow windows nothing here runs, so the existing compact
// fixed-column layout (styles.css) is untouched.
//
// Each table has one "flex" column that stays fluid (minmax(…, 1fr)) and so
// is always the widest, soaking up the remaining space — Message for the
// FT8-shaped tables, Call for WSPR. Every other column gets an explicit
// pixel width that the user can drag. Widths are written to a single CSS
// custom property (--ft8-cols) on the table element, so the dynamically
// added rows inherit them without per-row JS. Per-table widths are
// remembered in localStorage; double-click a divider to reset that column.

const DESKTOP = '(min-width: 900px)';
const STORE_PREFIX = 'piro.cols.';
const MIN_W = 40; // px, a column can't be dragged narrower than this
const MAX_W = 420; // px, nor wider than this
const FLEX_MIN = 90; // px, the flex column never collapses past this

// Sensible, balanced defaults by header label (the flex column isn't listed).
// Anything unrecognised falls back to DEFAULT_W.
const DEFAULT_W = 76;
const WIDTH_BY_LABEL = {
  UTC: 72,
  dt: 54,
  Freq: 86,
  MHz: 74,
  SNR: 60,
  Grid: 60,
  dBm: 52,
};

// Which column stays fluid, by table key (id or aria-label). Default: the
// last column. WSPR's fluid column is Call (its widest), not the last.
const FLEX_BY_KEY = {
  'WSPR spots': 4, // UTC, SNR, dt, MHz, [Call], Grid, dBm
};

function tableKey(table) {
  return table.id || table.getAttribute('aria-label') || 'table';
}

function headerCells(table) {
  const head = table.querySelector('.ft8-table__head');
  return head ? Array.from(head.querySelectorAll('[role="columnheader"]')) : [];
}

function flexIndex(table, cells) {
  const k = FLEX_BY_KEY[tableKey(table)];
  return Number.isInteger(k) ? k : cells.length - 1;
}

function defaultsFor(cells, flex) {
  // One entry per column; the flex column is null (it has no fixed width).
  return cells.map((c, i) => {
    if (i === flex) return null;
    const label = (c.textContent || '').trim();
    return WIDTH_BY_LABEL[label] || DEFAULT_W;
  });
}

function loadWidths(table, cells, flex) {
  try {
    const raw = localStorage.getItem(STORE_PREFIX + tableKey(table));
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length !== cells.length) return null;
    for (let i = 0; i < arr.length; i++) {
      if (i === flex) continue; // flex slot is unused
      if (!Number.isFinite(arr[i]) || arr[i] < MIN_W || arr[i] > MAX_W) return null;
    }
    return arr;
  } catch {
    return null; // private mode / blocked storage: just use defaults
  }
}

function saveWidths(table, widths) {
  try {
    localStorage.setItem(STORE_PREFIX + tableKey(table), JSON.stringify(widths));
  } catch {
    // not remembered — the live layout still works for this session
  }
}

function applyWidths(table, widths, flex) {
  const cols = widths.map((w, i) =>
    i === flex ? `minmax(${FLEX_MIN}px, 1fr)` : `${Math.round(w)}px`
  );
  table.style.setProperty('--ft8-cols', cols.join(' '));
}

function setupTable(table) {
  const cells = headerCells(table);
  if (cells.length < 2) return null; // nothing meaningful to resize

  const flex = flexIndex(table, cells);
  const lastIndex = cells.length - 1;
  const defaults = defaultsFor(cells, flex);
  let widths = loadWidths(table, cells, flex) || defaults.slice();

  const handles = [];

  function enable() {
    table.setAttribute('data-resizable', '');
    applyWidths(table, widths, flex);
    // A divider on the right edge of every fixed column that has a real grid
    // gap to its right (i.e. not the flex column, and not the last column —
    // the last column has no neighbour to butt against).
    cells.forEach((cell, i) => {
      if (i === flex || i === lastIndex) return;
      if (cell.querySelector('.ft8-col-resizer')) return;
      const handle = document.createElement('span');
      handle.className = 'ft8-col-resizer';
      handle.setAttribute('aria-hidden', 'true');
      attachDrag(handle, table, i, flex, () => widths, (next) => {
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

function attachDrag(handle, table, index, flex, getWidths, setWidths, defaults) {
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
    applyWidths(table, live, flex);
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
    applyWidths(table, next, flex);
    saveWidths(table, next);
  });
}

export function initColumnResize() {
  // All the decode tables, FT8-shaped and WSPR alike.
  const tables = Array.from(document.querySelectorAll('.ft8-table'));
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
