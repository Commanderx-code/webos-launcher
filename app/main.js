// Minimal launcher: app grid, inputs, clock, rearranging, and Continue Watching under Plex.
// Plain ES2017 with no optional chaining or newer APIs: webOS 5 runs Chromium 68.
(function () {
  'use strict';

  // Must match "id" in appinfo.json, so the launcher leaves itself out of the grid.
  const SELF_ID = 'com.minimal.launcher';
  const COLS = 6;
  const LONG_PRESS_MS = 600;

  const KEY = {
    ENTER: 13, LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40,
    BACK: 461, BACKSPACE: 8, ESC: 27,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
    // Keyboard stand-ins for the color buttons when previewing in a browser.
    R: 82, G: 71, Y: 89, B: 66,
  };

  const DEFAULT_INPUTS = [1, 2, 3, 4].map((n) => ({ id: 'HDMI_' + n, title: 'HDMI ' + n, appId: 'com.webos.app.hdmi' + n }));

  const data = window.LAUNCHER_DATA || {};
  let apps = (data.apps || []).slice();
  const inputs = data.inputs && data.inputs.length ? data.inputs : DEFAULT_INPUTS;
  const plex = data.plex && data.plex.server && data.plex.token ? data.plex : null;

  const THEMES = [
    { id: 'ambient', name: 'Ambient' },
    { id: 'aurora', name: 'Aurora' },
    { id: 'midnight', name: 'Midnight' },
  ];
  if (data.wallpaper) THEMES.push({ id: 'photo', name: 'Wallpaper' });
  const AMBIENT_FALLBACK = 'hsl(222, 30%, 24%)';

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem('launcher.' + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem('launcher.' + key, JSON.stringify(value));
      } catch (e) {
        // Storage unavailable: the change lasts until the launcher closes.
      }
    },
  };

  const state = {
    order: store.get('order', []),
    hidden: store.get('hidden', []),
    showHidden: false,
    editing: null,   // key of the app being moved
    focus: null,     // key of the focused tile, e.g. "app:netflix"
    zone: 'grid',    // 'grid' or 'panel'
    theme: store.get('theme', THEMES[0].id),
    panel: null,     // Continue Watching row under an app tile
  };

  let current = { sections: [], rows: [] };
  let lastPos = { r: 0, c: 0 };

  // Apps whose tile opens a Continue Watching row instead of launching straight away.
  const providers = [];
  if (plex) {
    providers.push({
      appId: plex.appId,
      name: 'Plex',
      load: () => window.Plex.continueWatching(plex),
    });
  }

  function providerFor(app) {
    return providers.filter((p) => p.appId === app.id)[0] || null;
  }

  // ---------------------------------------------------------------- model

  function orderedApps() {
    const byKey = new Map(apps.map((a) => [a.key, a]));
    const out = [];
    state.order.forEach((key) => {
      if (byKey.has(key)) {
        out.push(byKey.get(key));
        byKey.delete(key);
      }
    });
    // Apps not placed yet go at the end, in the TV's order.
    byKey.forEach((a) => out.push(a));
    return out;
  }

  function isHidden(app) {
    return state.hidden.indexOf(app.key) !== -1;
  }

  function visibleApps() {
    return orderedApps().filter((a) => state.showHidden || !isHidden(a) || a.key === state.editing);
  }

  function layout() {
    const sections = [
      { title: 'Apps', items: visibleApps().map((a) => ({ key: 'app:' + a.key, kind: 'app', app: a })) },
      { title: 'Inputs', items: inputs.map((i) => ({ key: 'input:' + i.id, kind: 'input', input: i })) },
    ];
    const rows = [];
    sections.forEach((s) => {
      for (let i = 0; i < s.items.length; i += COLS) rows.push(s.items.slice(i, i + COLS));
    });
    return { sections: sections, rows: rows };
  }

  function findPos(key) {
    for (let r = 0; r < current.rows.length; r++) {
      for (let c = 0; c < current.rows[r].length; c++) {
        if (current.rows[r][c].key === key) return { r: r, c: c };
      }
    }
    return null;
  }

  function focusedItem() {
    const pos = findPos(state.focus);
    return pos ? current.rows[pos.r][pos.c] : null;
  }

  // ---------------------------------------------------------------- rendering

  const $ = (id) => document.getElementById(id);

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function fallbackLetter(box, title) {
    box.textContent = '';
    box.appendChild(el('span', 'tile-letter', (title || '?').charAt(0).toUpperCase()));
  }

  const HDMI_GLYPH = '<svg class="tile-glyph" viewBox="0 0 48 24" aria-hidden="true">' +
    '<path d="M3 4h42v9l-5 7H8l-5-7z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>' +
    '<path d="M12 10h24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>';

  function renderTile(item) {
    const tile = el('div', 'tile');
    tile.dataset.key = item.key;
    const box = el('div', 'tile-box');
    let title;

    if (item.kind === 'app') {
      const app = item.app;
      title = app.title;
      if (app.bgColor) box.style.backgroundColor = app.bgColor;
      if (app.icon) {
        const img = el('img');
        img.src = app.icon;
        img.alt = '';
        img.onerror = () => fallbackLetter(box, title);
        box.appendChild(img);
      } else {
        fallbackLetter(box, title);
      }
      if (isHidden(app)) {
        tile.classList.add('is-hidden');
        box.appendChild(el('span', 'tile-badge', 'Hidden'));
      }
      if (app.key === state.editing) {
        tile.classList.add('editing');
        box.appendChild(el('span', 'tile-badge tile-badge-edit', 'Moving'));
      }
    } else {
      title = item.input.title;
      box.classList.add('tile-input');
      box.innerHTML = HDMI_GLYPH;
    }

    tile.appendChild(box);
    tile.appendChild(el('div', 'tile-label', title));

    tile.addEventListener('mouseenter', () => {
      if (!state.editing) setFocus(item.key, 'grid');
    });
    tile.addEventListener('click', () => {
      if (state.editing) return;
      setFocus(item.key, 'grid');
      activate();
    });
    return tile;
  }

  function panelCards() {
    const p = state.panel;
    const cards = [{ kind: 'open' }];
    p.items.forEach((item) => cards.push({ kind: 'item', item: item }));
    return cards;
  }

  function renderPanel(col) {
    const p = state.panel;
    const panel = el('div', 'panel');
    panel.id = 'panel';
    panel.style.setProperty('--caret-col', col);

    const head = el('div', 'panel-head');
    head.appendChild(el('div', 'panel-title', 'Continue watching'));
    head.appendChild(el('div', 'panel-source', p.providerName));
    let status = '';
    if (p.status === 'loading') status = 'Loading…';
    else if (p.status === 'error') status = p.message;
    else if (!p.items.length) status = 'Nothing in progress';
    head.appendChild(el('div', 'panel-status' + (p.status === 'error' ? ' is-error' : ''), status));
    panel.appendChild(head);

    const row = el('div', 'cards');
    row.id = 'cards';
    panelCards().forEach((card, i) => {
      const node = el('div', 'card');
      const art = el('div', 'card-art');
      if (card.kind === 'open') {
        node.classList.add('card-open');
        if (p.app.bgColor) art.style.backgroundColor = p.app.bgColor;
        if (p.app.icon) {
          const img = el('img');
          img.src = p.app.icon;
          img.alt = '';
          art.appendChild(img);
        }
        node.appendChild(art);
        node.appendChild(el('div', 'card-title', 'Open ' + p.app.title));
        node.appendChild(el('div', 'card-sub', 'Home screen'));
      } else {
        const item = card.item;
        if (item.image) art.style.backgroundImage = 'url("' + item.image + '")';
        if (item.progress) {
          const bar = el('div', 'card-progress');
          const fill = el('span');
          fill.style.width = (item.progress * 100).toFixed(1) + '%';
          bar.appendChild(fill);
          art.appendChild(bar);
        }
        node.appendChild(art);
        node.appendChild(el('div', 'card-title', item.title));
        node.appendChild(el('div', 'card-sub', [item.subtitle, item.meta].filter(Boolean).join(' · ')));
      }
      node.addEventListener('mouseenter', () => {
        state.panel.index = i;
        setFocus(state.focus, 'panel');
      });
      node.addEventListener('click', () => {
        state.panel.index = i;
        setFocus(state.focus, 'panel');
        activate();
      });
      row.appendChild(node);
    });
    panel.appendChild(row);
    return panel;
  }

  function render() {
    current = layout();
    // Build off-screen and swap in one step, so the scroll position survives.
    const content = el('div');
    content.id = 'content';
    const panelKey = state.panel ? 'app:' + state.panel.app.key : null;

    current.sections.forEach((section) => {
      const sec = el('section', 'section');
      sec.appendChild(el('h2', 'section-title', section.title));
      const grid = el('div', 'grid');
      if (!section.items.length) {
        grid.appendChild(el('p', 'empty', 'No apps yet. Run "npm run sync" on your computer, then "npm run deploy".'));
      }
      section.items.forEach((item, i) => {
        grid.appendChild(renderTile(item));
        const rowStart = i - (i % COLS);
        const rowEnd = Math.min(rowStart + COLS, section.items.length) - 1;
        if (i === rowEnd && panelKey) {
          const col = section.items.slice(rowStart, rowEnd + 1).map((it) => it.key).indexOf(panelKey);
          if (col !== -1) grid.appendChild(renderPanel(col));
        }
      });
      sec.appendChild(grid);
      content.appendChild(sec);
    });
    const scroller = $('scroller');
    const old = $('content');
    if (old) scroller.replaceChild(content, old);
    else scroller.appendChild(content);

    // Focus fell off the list (an app was hidden or uninstalled): take the tile in its place.
    if (!findPos(state.focus) && current.rows.length) {
      const r = Math.min(lastPos.r, current.rows.length - 1);
      const c = Math.min(lastPos.c, current.rows[r].length - 1);
      state.focus = current.rows[r][c].key;
    }
    applyFocus();
  }

  function applyFocus() {
    const pos = findPos(state.focus);
    if (pos) lastPos = pos;

    Array.prototype.forEach.call(document.querySelectorAll('.focused'), (n) => n.classList.remove('focused'));
    const tile = document.querySelector('.tile[data-key="' + cssEscape(state.focus) + '"]');

    if (state.zone === 'panel' && state.panel) {
      if (tile) tile.classList.add('owner');
      const cards = document.querySelectorAll('#cards .card');
      const card = cards[state.panel.index];
      if (card) {
        card.classList.add('focused');
        keepInViewX($('cards'), card);
      }
      const panel = $('panel');
      if (tile && panel) keepInViewY(tile.getBoundingClientRect().top, panel.getBoundingClientRect().bottom);
    } else if (tile) {
      tile.classList.add('focused');
      const box = tile.getBoundingClientRect();
      keepInViewY(box.top, box.bottom);
    }
    const item = focusedItem();
    const color = state.zone === 'panel' && state.panel ? state.panel.app.bgColor : item && item.kind === 'app' ? item.app.bgColor : null;
    $('backdrop').style.setProperty('--ambient', ambientColor(color) || AMBIENT_FALLBACK);
    renderHints();
  }

  // An app's card color, toned down to glow behind white text. Black, white and grays
  // have no hue to borrow, so they get the fallback.
  function ambientColor(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return null;
    const n = parseInt(m[1], 16);
    const r = (n >> 16) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (d < 0.12) return null;
    const s = d / (1 - Math.abs(2 * l - 1));
    let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = Math.round(h * 60 + 360) % 360;
    return 'hsl(' + h + ', ' + Math.round(Math.min(s, 0.7) * 100) + '%, ' + Math.round(Math.min(l, 0.38) * 100) + '%)';
  }

  function applyTheme() {
    if (!THEMES.some((t) => t.id === state.theme)) state.theme = THEMES[0].id;
    $('app').className = 'theme-' + state.theme;
    $('backdrop').style.backgroundImage = state.theme === 'photo' ? 'url("' + data.wallpaper + '")' : '';
  }

  function cycleTheme() {
    const i = THEMES.map((t) => t.id).indexOf(state.theme);
    const next = THEMES[(i + 1) % THEMES.length];
    state.theme = next.id;
    store.set('theme', next.id);
    applyTheme();
    toast('Theme: ' + next.name);
  }

  function cssEscape(s) {
    return String(s).replace(/["\\]/g, '\\$&');
  }

  function rem(n) {
    return n * parseFloat(getComputedStyle(document.documentElement).fontSize);
  }

  // Scroll the page so the screen range [top, bottom] sits clear of the edges.
  function keepInViewY(top, bottom) {
    const scroller = $('scroller');
    const view = scroller.getBoundingClientRect();
    const margin = rem(4);
    if (top - margin < view.top) scroller.scrollTop -= view.top - (top - margin);
    else if (bottom + margin > view.bottom) scroller.scrollTop += Math.min(bottom + margin - view.bottom, top - margin - view.top);
  }

  function keepInViewX(row, card) {
    const view = row.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    const margin = rem(1);
    if (box.left - margin < view.left) row.scrollLeft -= view.left - (box.left - margin);
    else if (box.right + margin > view.right) row.scrollLeft += box.right + margin - view.right;
  }

  function hint(keyClass, keyText, label) {
    const h = el('span', 'hint');
    h.appendChild(el('span', 'key ' + keyClass, keyText));
    h.appendChild(document.createTextNode(label));
    return h;
  }

  function renderHints() {
    const bar = $('hints');
    bar.textContent = '';
    const add = (k, t, l) => bar.appendChild(hint(k, t, l));

    if (state.editing) {
      add('key-text', '◀ ▶ ▲ ▼', 'Move');
      add('key-red', '', isHidden({ key: state.editing }) ? 'Unhide' : 'Hide');
      add('key-text', 'OK', 'Done');
      return;
    }
    if (state.zone === 'panel' && state.panel) {
      add('key-text', '◀ ▶', 'Browse');
      add('key-text', 'OK', 'Open in ' + state.panel.app.title);
      add('key-text', 'BACK', 'Close');
      return;
    }
    const item = focusedItem();
    if (item && item.kind === 'app') {
      add('key-text', 'OK', providerFor(item.app) ? 'Continue watching' : 'Open');
      add('key-yellow', '', 'Rearrange or hide (or hold OK)');
    } else if (item) {
      add('key-text', 'OK', 'Switch input');
    }
    if (state.hidden.length) add('key-green', '', state.showHidden ? 'Leave out hidden apps' : 'Show hidden apps');
    add('key-blue', '', 'Theme');
  }

  let toastTimer = null;
  function toast(message) {
    const node = $('toast');
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 2500);
  }

  // ---------------------------------------------------------------- actions

  function setFocus(key, zone) {
    state.focus = key;
    state.zone = zone || 'grid';
    applyFocus();
  }

  function launch(id, params, title) {
    if (!window.Luna.available()) {
      toast(title + ' opens here on the TV');
      return;
    }
    toast('Opening ' + title + '…');
    window.Luna.launch(id, params).catch((err) => toast("Couldn't open " + title + ': ' + err.message));
  }

  function activate() {
    if (state.zone === 'panel' && state.panel) {
      // Plex can't be told which item to play, so every card opens the app.
      launch(state.panel.app.id, state.panel.app.params, state.panel.app.title);
      return;
    }
    const item = focusedItem();
    if (!item) return;
    if (item.kind === 'input') {
      launch(item.input.appId, null, item.input.title);
      return;
    }
    const provider = providerFor(item.app);
    if (provider) openPanel(item.app, provider);
    else launch(item.app.id, item.app.params, item.app.title);
  }

  function openPanel(app, provider) {
    if (state.panel && state.panel.app.key === app.key) {
      setFocus(state.focus, 'panel');
      return;
    }
    const cacheKey = 'cache.' + app.key;
    state.panel = {
      app: app,
      providerName: provider.name,
      items: store.get(cacheKey, []),
      status: 'loading',
      message: '',
      index: 0,
    };
    state.zone = 'panel';
    render();
    refreshPanel(provider, cacheKey);
  }

  function refreshPanel(provider, cacheKey) {
    const panel = state.panel;
    provider.load().then((items) => {
      store.set(cacheKey, items);
      if (state.panel !== panel) return;
      panel.items = items;
      panel.status = 'ready';
      panel.index = Math.min(panel.index, items.length);
      render();
    }, (err) => {
      if (state.panel !== panel) return;
      panel.status = 'error';
      panel.message = err.message;
      render();
    });
  }

  function closePanel() {
    state.panel = null;
    state.zone = 'grid';
    render();
  }

  function moveGrid(dx, dy) {
    const pos = findPos(state.focus);
    if (!pos) return;
    const r = pos.r + dy;
    let c = pos.c + dx;
    if (r < 0 || r >= current.rows.length) return;
    if (dx && (c < 0 || c >= current.rows[r].length)) return;
    c = Math.min(c, current.rows[r].length - 1);
    if (state.panel && dy) {
      // Leaving the tile row the panel hangs under closes it.
      state.panel = null;
      state.focus = current.rows[r][c].key;
      render();
      return;
    }
    setFocus(current.rows[r][c].key, 'grid');
  }

  function movePanel(dx) {
    const count = panelCards().length;
    state.panel.index = Math.max(0, Math.min(count - 1, state.panel.index + dx));
    applyFocus();
  }

  function startEdit() {
    const item = focusedItem();
    if (!item || item.kind !== 'app') return;
    state.panel = null;
    state.zone = 'grid';
    state.editing = item.app.key;
    render();
  }

  function finishEdit() {
    state.editing = null;
    render();
  }

  function moveEditing(dx, dy) {
    const visible = visibleApps();
    const from = visible.map((a) => a.key).indexOf(state.editing);
    let to = from + dx + dy * COLS;
    if (dx && Math.floor(to / COLS) !== Math.floor(from / COLS)) return;
    to = Math.max(0, Math.min(visible.length - 1, to));
    if (to === from) return;

    // Move within the full order, so hidden apps keep their places.
    const order = orderedApps().map((a) => a.key);
    order.splice(order.indexOf(state.editing), 1);
    let at = order.indexOf(visible[to].key);
    if (to > from) at += 1;
    order.splice(at, 0, state.editing);

    state.order = order;
    store.set('order', order);
    render();
  }

  function toggleHidden(key) {
    const i = state.hidden.indexOf(key);
    if (i === -1) state.hidden.push(key);
    else state.hidden.splice(i, 1);
    store.set('hidden', state.hidden);
    render();
  }

  // ---------------------------------------------------------------- input

  const ok = { down: false, long: false, timer: null };

  function onOkPress() {
    if (state.editing) finishEdit();
    else activate();
  }

  function onOkHold() {
    const item = focusedItem();
    if (!state.editing && state.zone === 'grid' && item && item.kind === 'app') startEdit();
    else onOkPress();
  }

  document.addEventListener('keydown', (e) => {
    const k = e.keyCode;
    if (k === KEY.ENTER) {
      e.preventDefault();
      // Holding OK repeats keydown; only the first one counts.
      if (!ok.down) {
        ok.down = true;
        ok.long = false;
        ok.timer = setTimeout(() => {
          ok.long = true;
          onOkHold();
        }, LONG_PRESS_MS);
      }
      return;
    }

    const dx = k === KEY.LEFT ? -1 : k === KEY.RIGHT ? 1 : 0;
    const dy = k === KEY.UP ? -1 : k === KEY.DOWN ? 1 : 0;
    const back = k === KEY.BACK || k === KEY.BACKSPACE || k === KEY.ESC;
    if (dx || dy || back) e.preventDefault();

    if ((k === KEY.BLUE || k === KEY.B) && !state.editing) {
      cycleTheme();
      return;
    }

    if (state.editing) {
      if (dx || dy) moveEditing(dx, dy);
      else if (k === KEY.RED || k === KEY.R) toggleHidden(state.editing);
      else if (back || k === KEY.YELLOW || k === KEY.Y) finishEdit();
      return;
    }

    if (state.zone === 'panel' && state.panel) {
      if (dx) movePanel(dx);
      else if (k === KEY.UP || back) {
        state.zone = 'grid';
        closePanel();
      } else if (k === KEY.DOWN) {
        state.zone = 'grid';
        moveGrid(0, 1);
      }
      return;
    }

    if (dx || dy) moveGrid(dx, dy);
    else if (k === KEY.YELLOW || k === KEY.Y) startEdit();
    else if ((k === KEY.GREEN || k === KEY.G) && (state.hidden.length || state.showHidden)) {
      state.showHidden = !state.showHidden;
      render();
    } else if (back) {
      // This is the home screen: Back closes what is open and otherwise stays put.
      if (state.panel) closePanel();
      else if (state.showHidden) {
        state.showHidden = false;
        render();
      }
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.keyCode !== KEY.ENTER) return;
    clearTimeout(ok.timer);
    if (ok.down && !ok.long) onOkPress();
    ok.down = false;
  });

  // ---------------------------------------------------------------- clock

  function tick() {
    const now = new Date();
    $('time').textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    $('date').textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }

  // ---------------------------------------------------------------- start

  function start() {
    applyTheme();
    tick();
    setInterval(tick, 10000);

    render();
    if (!state.focus && current.rows.length) setFocus(current.rows[0][0].key, 'grid');

    // A rooted TV hands over the live list; a stock one refuses and the synced list stays.
    window.Luna.listLaunchPoints().then((res) => {
      const live = (res.launchPoints || []).filter((lp) => lp.id !== SELF_ID && !/^com\.webos\.app\.hdmi/.test(lp.id));
      if (!live.length) return;
      apps = live.map((lp) => ({
        key: lp.launchPointId || lp.id,
        id: lp.id,
        title: lp.title,
        icon: lp.largeIcon || lp.icon,
        bgColor: lp.iconColor || lp.bgColor,
        params: lp.params,
      }));
      render();
    }, () => {});

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      tick();
      if (state.panel) {
        const provider = providerFor(state.panel.app);
        if (provider) refreshPanel(provider, 'cache.' + state.panel.app.key);
      }
    });
  }

  start();
})();
