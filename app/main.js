// Minimal launcher: favorites, Plex rows, app grid and inputs, with a clock, weather, themes
// and a screensaver. Plain ES2017 with no optional chaining or newer APIs: webOS 5 runs Chromium 68.
(function () {
  'use strict';

  // Must match "id" in appinfo.json, so the launcher leaves itself out of the grid.
  const SELF_ID = 'com.minimal.launcher';
  const COLS = 6;
  const LONG_PRESS_MS = 600;
  const PLEX_REFRESH_MS = 10 * 60 * 1000;
  const WEATHER_REFRESH_MS = 15 * 60 * 1000;
  // How long a picture stays up in the screensaver; videos play through instead.
  const SLIDE_MS = 12000;

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
  const weatherCfg = data.weather && data.weather.latitude != null ? data.weather : null;
  const wallpaper = typeof data.wallpaper === 'string' ? { src: data.wallpaper, video: false } : data.wallpaper;
  // Minutes without a button press before the screensaver starts; 0 turns it off.
  const saverMinutes = data.screensaverMinutes == null ? 5 : data.screensaverMinutes;

  const THEMES = [
    { id: 'ambient', name: 'Ambient' },
    { id: 'aurora', name: 'Aurora' },
    { id: 'midnight', name: 'Midnight' },
  ];
  if (wallpaper) THEMES.push({ id: 'photo', name: 'Wallpaper' });
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
    favorites: store.get('favorites', data.favorites || []),
    showHidden: false,
    editing: null,   // key of the app being moved
    focus: null,     // key of the focused item, e.g. "app:netflix" or "continue:2"
    theme: store.get('theme', THEMES[0].id),
    rowIndex: {},    // where focus last was in each scrolling row, to land there again
    weather: null,
    plexRows: {
      continue: { items: store.get('cache.continue', []), error: null, loaded: false },
      recent: { items: store.get('cache.recent', []), error: null, loaded: false },
    },
  };

  let current = { sections: [], rows: [] };
  let lastPos = { r: 0, c: 0 };

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

  function appByKey(key) {
    return apps.filter((a) => a.key === key)[0] || null;
  }

  function isHidden(app) {
    return state.hidden.indexOf(app.key) !== -1;
  }

  function isFavorite(app) {
    return state.favorites.indexOf(app.key) !== -1;
  }

  function shown(app) {
    return state.showHidden || !isHidden(app) || app.key === state.editing;
  }

  function favoriteApps() {
    return state.favorites.map(appByKey).filter((a) => a && shown(a));
  }

  function gridApps() {
    return orderedApps().filter((a) => !isFavorite(a) && shown(a));
  }

  // The app the Plex cards open: the official Plex app unless config.json names another.
  function plexApp() {
    return plex ? apps.filter((a) => a.id === plex.appId)[0] || null : null;
  }

  function appItem(a) {
    return { key: 'app:' + a.key, kind: 'app', app: a };
  }

  function plexSection(id, title, emptyText) {
    const row = state.plexRows[id];
    let status = '';
    if (!row.items.length) status = row.error || (row.loaded ? emptyText : 'Loading…');
    return {
      id: id,
      title: title,
      source: 'Plex',
      scroll: true,
      status: status,
      isError: !!row.error && !row.items.length,
      items: row.items.map((it, i) => ({ key: id + ':' + i, kind: 'plex', item: it, row: title })),
    };
  }

  function layout() {
    const sections = [];
    const favs = favoriteApps();
    if (favs.length) sections.push({ id: 'favorites', title: 'Favorites', scroll: true, big: true, items: favs.map(appItem) });
    if (plex) {
      sections.push(plexSection('continue', 'Continue Watching', 'Nothing in progress'));
      sections.push(plexSection('recent', 'Recently Added', 'Nothing new'));
    }
    sections.push({ id: 'apps', title: favs.length ? 'All Apps' : 'Apps', items: gridApps().map(appItem) });
    sections.push({ id: 'inputs', title: 'Inputs', items: inputs.map((i) => ({ key: 'input:' + i.id, kind: 'input', input: i })) });

    const rows = [];
    sections.forEach((s) => {
      if (!s.items.length) return;
      if (s.scroll) rows.push({ section: s, items: s.items });
      else for (let i = 0; i < s.items.length; i += COLS) rows.push({ section: s, items: s.items.slice(i, i + COLS) });
    });
    return { sections: sections, rows: rows };
  }

  function findPos(key) {
    for (let r = 0; r < current.rows.length; r++) {
      for (let c = 0; c < current.rows[r].items.length; c++) {
        if (current.rows[r].items[c].key === key) return { r: r, c: c };
      }
    }
    return null;
  }

  function focusedItem() {
    const pos = findPos(state.focus);
    return pos ? current.rows[pos.r].items[pos.c] : null;
  }

  // ---------------------------------------------------------------- rendering

  const $ = (id) => document.getElementById(id);

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function nodeFor(key) {
    return document.querySelector('[data-key="' + String(key).replace(/["\\]/g, '\\$&') + '"]');
  }

  function fallbackLetter(box, title) {
    box.textContent = '';
    box.appendChild(el('span', 'tile-letter', (title || '?').charAt(0).toUpperCase()));
  }

  const HDMI_GLYPH = '<svg class="tile-glyph" viewBox="0 0 48 24" aria-hidden="true">' +
    '<path d="M3 4h42v9l-5 7H8l-5-7z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>' +
    '<path d="M12 10h24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>';

  function bindPointer(node, key) {
    node.addEventListener('mouseenter', () => {
      if (!state.editing) setFocus(key);
    });
    node.addEventListener('click', () => {
      if (state.editing) return;
      setFocus(key);
      activate();
    });
  }

  function renderTile(item, big) {
    const tile = el('div', big ? 'tile tile-big' : 'tile');
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
    bindPointer(tile, item.key);
    return tile;
  }

  function renderCard(item) {
    const card = el('div', 'card');
    card.dataset.key = item.key;
    const art = el('div', 'card-art');
    if (item.item.image) art.style.backgroundImage = 'url("' + item.item.image + '")';
    if (item.item.progress) {
      const bar = el('div', 'card-progress');
      const fill = el('span');
      fill.style.width = (item.item.progress * 100).toFixed(1) + '%';
      bar.appendChild(fill);
      art.appendChild(bar);
    }
    card.appendChild(art);
    card.appendChild(el('div', 'card-title', item.item.title));
    card.appendChild(el('div', 'card-sub', [item.item.subtitle, item.item.meta].filter(Boolean).join(' · ')));
    bindPointer(card, item.key);
    return card;
  }

  function render() {
    current = layout();
    // Build off-screen and swap in one step, so the page's scroll position survives;
    // the rows' sideways positions are carried over by hand.
    const scrolls = {};
    Array.prototype.forEach.call(document.querySelectorAll('.row'), (r) => { scrolls[r.dataset.section] = r.scrollLeft; });
    const content = el('div');
    content.id = 'content';

    current.sections.forEach((s) => {
      if (!s.items.length && !s.status && s.id !== 'apps') return;
      const sec = el('section', 'section');
      const head = el('h2', 'section-title', s.title);
      if (s.source) head.appendChild(el('span', 'section-source', s.source));
      if (s.status) head.appendChild(el('span', 'section-status' + (s.isError ? ' is-error' : ''), s.status));
      sec.appendChild(head);

      if (s.scroll) {
        if (s.items.length) {
          const row = el('div', 'row');
          row.dataset.section = s.id;
          s.items.forEach((item) => row.appendChild(item.kind === 'plex' ? renderCard(item) : renderTile(item, true)));
          sec.appendChild(row);
        }
      } else {
        const grid = el('div', 'grid');
        if (!s.items.length) grid.appendChild(el('p', 'empty', s.id === 'apps' && apps.length ? 'Every app is in Favorites.' : 'No apps yet. Run "npm run sync" on your computer, then "npm run deploy".'));
        s.items.forEach((item) => grid.appendChild(renderTile(item, false)));
        sec.appendChild(grid);
      }
      content.appendChild(sec);
    });

    const scroller = $('scroller');
    const old = $('content');
    if (old) scroller.replaceChild(content, old);
    else scroller.appendChild(content);
    Array.prototype.forEach.call(document.querySelectorAll('.row'), (r) => { r.scrollLeft = scrolls[r.dataset.section] || 0; });

    // Focus fell off the list (an app was hidden or a row emptied): take the item in its place.
    if (!findPos(state.focus) && current.rows.length) {
      const r = Math.min(lastPos.r, current.rows.length - 1);
      const c = Math.min(lastPos.c, current.rows[r].items.length - 1);
      state.focus = current.rows[r].items[c].key;
    }
    applyFocus();
  }

  function applyFocus() {
    const pos = findPos(state.focus);
    Array.prototype.forEach.call(document.querySelectorAll('.focused'), (n) => n.classList.remove('focused'));
    const node = nodeFor(state.focus);
    if (pos && node) {
      lastPos = pos;
      const row = current.rows[pos.r];
      if (row.section.scroll) state.rowIndex[row.section.id] = pos.c;
      node.classList.add('focused');
      if (node.parentNode.classList.contains('row')) keepInViewX(node.parentNode, node);
      // On a section's first row, bring its heading into view too.
      const firstRow = pos.r === 0 || current.rows[pos.r - 1].section !== row.section;
      const box = node.getBoundingClientRect();
      const sec = node.parentNode.parentNode;
      keepInViewY(firstRow ? sec.getBoundingClientRect().top : box.top, box.bottom);
    }
    const item = focusedItem();
    const color = item && item.kind === 'app' ? item.app.bgColor : null;
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
    const backdrop = $('backdrop');
    const photo = state.theme === 'photo' && wallpaper;
    backdrop.style.backgroundImage = photo && !wallpaper.video ? 'url("' + wallpaper.src + '")' : '';

    // A video wallpaper plays only while its theme is on, so it isn't decoding in the background.
    let video = backdrop.querySelector('video');
    if (photo && wallpaper.video && !video) {
      video = el('video', 'wall-video');
      video.muted = true;
      video.loop = true;
      video.autoplay = true;
      video.setAttribute('playsinline', '');
      video.src = wallpaper.src;
      backdrop.insertBefore(video, backdrop.firstChild);
      const played = video.play();
      if (played && played.catch) played.catch(() => {});
    } else if (!(photo && wallpaper.video) && video) {
      video.pause();
      backdrop.removeChild(video);
    }
  }

  function cycleTheme() {
    const i = THEMES.map((t) => t.id).indexOf(state.theme);
    const next = THEMES[(i + 1) % THEMES.length];
    state.theme = next.id;
    store.set('theme', next.id);
    applyTheme();
    toast('Theme: ' + next.name);
  }

  function rem(n) {
    return n * parseFloat(getComputedStyle(document.documentElement).fontSize);
  }

  // Scroll the page so the screen range [top, bottom] sits clear of the edges.
  function keepInViewY(top, bottom) {
    const scroller = $('scroller');
    const view = scroller.getBoundingClientRect();
    const margin = rem(3);
    if (top - margin < view.top) scroller.scrollTop -= view.top - (top - margin);
    else if (bottom + margin > view.bottom) scroller.scrollTop += Math.min(bottom + margin - view.bottom, top - margin - view.top);
  }

  function keepInViewX(row, node) {
    const view = row.getBoundingClientRect();
    const box = node.getBoundingClientRect();
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
      const app = appByKey(state.editing);
      add('key-text', isFavorite(app) ? '◀ ▶' : '◀ ▶ ▲ ▼', 'Move');
      add('key-green', '', isFavorite(app) ? 'Remove from Favorites' : 'Add to Favorites');
      add('key-red', '', isHidden(app) ? 'Unhide' : 'Hide');
      add('key-text', 'OK', 'Done');
      return;
    }
    const item = focusedItem();
    if (item && item.kind === 'app') {
      add('key-text', 'OK', 'Open');
      add('key-yellow', '', 'Edit (or hold OK)');
    } else if (item && item.kind === 'plex') {
      add('key-text', 'OK', 'Open ' + (plexApp() ? plexApp().title : 'Plex'));
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

  function setFocus(key) {
    state.focus = key;
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
    const item = focusedItem();
    if (!item) return;
    if (item.kind === 'input') {
      launch(item.input.appId, null, item.input.title);
    } else if (item.kind === 'plex') {
      // The app can't be told which item to play, so every card just opens it.
      const app = plexApp();
      launch(plex.appId, app ? app.params : null, app ? app.title : 'Plex');
    } else {
      launch(item.app.id, item.app.params, item.app.title);
    }
  }

  // Up and down land where you last were in a scrolling row, otherwise on the item
  // straight above or below.
  function moveFocus(dx, dy) {
    const pos = findPos(state.focus);
    if (!pos) return;
    const row = current.rows[pos.r];
    if (dx) {
      const c = pos.c + dx;
      if (c >= 0 && c < row.items.length) setFocus(row.items[c].key);
      return;
    }
    const r = pos.r + dy;
    if (r < 0 || r >= current.rows.length) return;
    const target = current.rows[r];
    const remembered = target.section.scroll ? state.rowIndex[target.section.id] : null;
    const c = remembered != null ? Math.min(remembered, target.items.length - 1) : nearestByX(target, nodeFor(state.focus));
    setFocus(target.items[c].key);
  }

  function nearestByX(row, from) {
    if (!from) return 0;
    const fb = from.getBoundingClientRect();
    const x = (fb.left + fb.right) / 2;
    let best = 0;
    let bestDist = Infinity;
    row.items.forEach((it, i) => {
      const n = nodeFor(it.key);
      if (!n) return;
      const b = n.getBoundingClientRect();
      const dist = Math.abs((b.left + b.right) / 2 - x);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    return best;
  }

  function startEdit() {
    const item = focusedItem();
    if (!item || item.kind !== 'app') return;
    state.editing = item.app.key;
    render();
  }

  function finishEdit() {
    state.editing = null;
    render();
  }

  function saveFavorites(list) {
    state.favorites = list;
    store.set('favorites', list);
  }

  function moveEditing(dx, dy) {
    const app = appByKey(state.editing);
    if (isFavorite(app)) {
      // Favorites are one row: only sideways moves.
      if (!dx) return;
      const shownKeys = favoriteApps().map((a) => a.key);
      const other = shownKeys[shownKeys.indexOf(app.key) + dx];
      if (!other) return;
      const list = state.favorites.slice();
      list[list.indexOf(app.key)] = other;
      list[state.favorites.indexOf(other)] = app.key;
      saveFavorites(list);
      render();
      return;
    }

    const visible = gridApps();
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

  function toggleFavorite(key) {
    const list = state.favorites.slice();
    const i = list.indexOf(key);
    if (i === -1) list.push(key);
    else list.splice(i, 1);
    saveFavorites(list);
    render();
    toast(i === -1 ? 'Added to Favorites' : 'Removed from Favorites');
  }

  function toggleHidden(key) {
    const i = state.hidden.indexOf(key);
    if (i === -1) state.hidden.push(key);
    else state.hidden.splice(i, 1);
    store.set('hidden', state.hidden);
    render();
  }

  // ---------------------------------------------------------------- Plex and weather

  function loadPlex() {
    if (!plex) return;
    [['continue', window.Plex.continueWatching], ['recent', window.Plex.recentlyAdded]].forEach((pair) => {
      const row = state.plexRows[pair[0]];
      pair[1](plex).then((items) => {
        row.items = items;
        row.error = null;
        row.loaded = true;
        store.set('cache.' + pair[0], items);
        render();
      }, (err) => {
        row.error = err.message;
        row.loaded = true;
        render();
      });
    });
  }

  function renderWeather() {
    const w = state.weather;
    [$('weather'), $('saver-weather')].forEach((node) => {
      node.textContent = '';
      if (!w) return;
      const icon = el('span', 'weather-icon');
      icon.innerHTML = window.Weather.icon(w.icon);
      node.appendChild(icon);
      node.appendChild(el('span', 'weather-temp', w.temp + '°'));
      const detail = el('span', 'weather-detail');
      detail.appendChild(el('span', null, w.label));
      detail.appendChild(el('span', null, 'H ' + w.high + '°  L ' + w.low + '°'));
      node.appendChild(detail);
    });
  }

  function loadWeather() {
    if (!weatherCfg) return;
    // On failure the last reading stays up until the next try.
    window.Weather.current(weatherCfg).then((w) => {
      state.weather = w;
      renderWeather();
    }, () => {});
  }

  // ---------------------------------------------------------------- screensaver

  const saver = { on: false, idle: null, timer: null, drift: null, deck: [], front: 0, lastVideo: false };
  const ownSlides = data.screensaver && data.screensaver.length ? data.screensaver : null;

  function resetIdle() {
    clearTimeout(saver.idle);
    if (saverMinutes > 0) saver.idle = setTimeout(startSaver, saverMinutes * 60000);
  }

  function saverSlides() {
    if (ownSlides) return ownSlides.map((s) => ({ src: s.src, video: s.video, caption: '' }));
    const out = [];
    [['continue', 'Continue Watching'], ['recent', 'Recently Added']].forEach((pair) => {
      state.plexRows[pair[0]].items.forEach((it) => {
        if (it.backdrop) out.push({ src: it.backdrop, caption: pair[1] + ' · ' + it.title });
      });
    });
    return out;
  }

  function shuffle(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  function nextSlide() {
    clearTimeout(saver.timer);
    if (!saver.on) return;
    if (!saver.deck.length) saver.deck = shuffle(saverSlides());
    if (!saver.deck.length) return;
    // Two videos in a row would flash black while the second loads, so slip a picture between.
    if (saver.deck[0].video && saver.lastVideo) {
      const i = saver.deck.map((sl) => sl.video).indexOf(false);
      if (i > 0) saver.deck.unshift(saver.deck.splice(i, 1)[0]);
    }
    const slide = saver.deck.shift();
    saver.lastVideo = slide.video;
    if (slide.video) playVideoSlide(slide);
    else showPictureSlide(slide);
  }

  // Swap only once the picture has loaded, so the fade never shows a half-drawn image.
  function showPictureSlide(slide) {
    const img = new Image();
    img.onload = () => {
      if (!saver.on) return;
      const layers = document.querySelectorAll('.saver-art');
      saver.front = 1 - saver.front;
      layers[saver.front].style.backgroundImage = 'url("' + slide.src + '")';
      layers[saver.front].classList.add('show');
      layers[1 - saver.front].classList.remove('show');
      hideSaverVideo();
      $('saver-caption').textContent = slide.caption;
      saver.timer = setTimeout(nextSlide, SLIDE_MS);
    };
    img.onerror = () => {
      saver.timer = setTimeout(nextSlide, 1000);
    };
    img.src = slide.src;
  }

  function playVideoSlide(slide) {
    const video = $('saver-video');
    let started = false;
    video.loop = false;
    video.onplaying = () => {
      if (started || !saver.on) return;
      started = true;
      video.classList.add('show');
      Array.prototype.forEach.call(document.querySelectorAll('.saver-art'), (n) => n.classList.remove('show'));
      $('saver-caption').textContent = slide.caption;
      // A short clip loops until a picture's worth of time has passed.
      if (!(video.duration * 1000 >= SLIDE_MS)) {
        video.loop = true;
        saver.timer = setTimeout(nextSlide, SLIDE_MS);
      }
    };
    video.onended = () => nextSlide();
    video.onerror = () => {
      saver.timer = setTimeout(nextSlide, 1000);
    };
    video.src = slide.src;
    const played = video.play();
    if (played && played.catch) played.catch(() => {
      saver.timer = setTimeout(nextSlide, 1000);
    });
  }

  // Fades the video out, then stops it so the TV isn't decoding it in the background.
  function hideSaverVideo() {
    const video = $('saver-video');
    if (!video.classList.contains('show')) return;
    video.classList.remove('show');
    setTimeout(() => {
      if (video.classList.contains('show')) return;
      video.pause();
      video.removeAttribute('src');
      video.load();
    }, 2000);
  }

  // Nudges the clock a little now and then so nothing sits in one spot for hours.
  function driftSaverInfo() {
    $('saver-info').style.transform = 'translate(' + Math.round(Math.random() * 40 - 20) + 'px, ' + Math.round(Math.random() * 30 - 15) + 'px)';
  }

  function wallVideo() {
    return $('backdrop').querySelector('video');
  }

  function startSaver() {
    if (document.hidden || state.editing) {
      resetIdle();
      return;
    }
    saver.on = true;
    saver.deck = [];
    saver.lastVideo = false;
    // One video at a time: the wallpaper rests while the screensaver runs.
    if (wallVideo()) wallVideo().pause();
    $('saver').classList.add('show');
    driftSaverInfo();
    saver.drift = setInterval(driftSaverInfo, 30000);
    nextSlide();
  }

  function stopSaver() {
    saver.on = false;
    clearTimeout(saver.timer);
    clearInterval(saver.drift);
    $('saver').classList.remove('show');
    Array.prototype.forEach.call(document.querySelectorAll('.saver-art'), (n) => n.classList.remove('show'));
    const video = $('saver-video');
    video.classList.remove('show');
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (wallVideo()) {
      const played = wallVideo().play();
      if (played && played.catch) played.catch(() => {});
    }
    resetIdle();
  }

  // ---------------------------------------------------------------- input

  const ok = { down: false, long: false, timer: null, swallow: false };

  function onOkPress() {
    if (state.editing) finishEdit();
    else activate();
  }

  function onOkHold() {
    const item = focusedItem();
    if (!state.editing && item && item.kind === 'app') startEdit();
    else onOkPress();
  }

  document.addEventListener('keydown', (e) => {
    const k = e.keyCode;
    resetIdle();
    // Any button wakes the screensaver and does nothing else.
    if (saver.on) {
      e.preventDefault();
      if (k === KEY.ENTER) ok.swallow = true;
      stopSaver();
      return;
    }

    if (k === KEY.ENTER) {
      e.preventDefault();
      // Holding OK repeats keydown; only the first one counts.
      if (!ok.down && !ok.swallow) {
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
      else if (k === KEY.GREEN || k === KEY.G) toggleFavorite(state.editing);
      else if (k === KEY.RED || k === KEY.R) toggleHidden(state.editing);
      else if (back || k === KEY.YELLOW || k === KEY.Y) finishEdit();
      return;
    }

    if (dx || dy) moveFocus(dx, dy);
    else if (k === KEY.YELLOW || k === KEY.Y) startEdit();
    else if ((k === KEY.GREEN || k === KEY.G) && (state.hidden.length || state.showHidden)) {
      state.showHidden = !state.showHidden;
      render();
    } else if (back && state.showHidden) {
      // This is the home screen: Back only undoes "show hidden apps" and otherwise stays put.
      state.showHidden = false;
      render();
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.keyCode !== KEY.ENTER) return;
    clearTimeout(ok.timer);
    if (ok.down && !ok.long && !ok.swallow) onOkPress();
    ok.down = false;
    ok.swallow = false;
  });

  // The Magic Remote's pointer counts as activity too.
  document.addEventListener('mousemove', () => {
    if (saver.on) stopSaver();
    else resetIdle();
  });

  // ---------------------------------------------------------------- clock

  function tick() {
    const now = new Date();
    const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const date = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    $('time').textContent = time;
    $('date').textContent = date;
    $('saver-time').textContent = time;
    $('saver-date').textContent = date;
  }

  // ---------------------------------------------------------------- start

  function start() {
    applyTheme();
    tick();
    setInterval(tick, 10000);

    render();
    if (!state.focus && current.rows.length) setFocus(current.rows[0].items[0].key);

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

    loadPlex();
    loadWeather();
    setInterval(loadPlex, PLEX_REFRESH_MS);
    setInterval(loadWeather, WEATHER_REFRESH_MS);
    resetIdle();

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (saver.on) stopSaver();
        clearTimeout(saver.idle);
        return;
      }
      tick();
      loadPlex();
      loadWeather();
      resetIdle();
    });
  }

  start();
})();
