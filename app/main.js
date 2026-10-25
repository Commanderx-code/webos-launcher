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
  // Each wallpaper is a theme of its own. data.js from before named wallpapers had just one.
  const wallpapers = data.wallpapers ||
    (data.wallpaper ? [Object.assign({ id: 'photo', name: 'Wallpaper', video: false }, typeof data.wallpaper === 'string' ? { src: data.wallpaper } : data.wallpaper)] : []);
  // Minutes without a button press before the screensaver starts; 0 turns it off. The sidebar's
  // setting wins over config.json's.
  function saverMinutes() {
    const set = state.settings.screensaverMinutes;
    if (set != null) return set;
    return data.screensaverMinutes == null ? 5 : data.screensaverMinutes;
  }

  const THEMES = [
    { id: 'ambient', name: 'Ambient' },
    { id: 'aurora', name: 'Aurora' },
    { id: 'midnight', name: 'Midnight' },
    { id: 'ocean', name: 'Ocean' },
    { id: 'sunset', name: 'Sunset' },
    { id: 'space', name: 'Starry space' },
  ];
  wallpapers.forEach((w) => THEMES.push({ id: w.id, name: w.name }));
  // "photo" was the one wallpaper's theme; it's now the first wallpaper.
  function migrateTheme(id) {
    return id === 'photo' && wallpapers.length ? wallpapers[0].id : id;
  }
  function wallpaperFor(id) {
    return wallpapers.filter((w) => w.id === id)[0] || null;
  }
  // Tile looks, picked in the sidebar apart from the theme: the apps' own icons, or glass tiles
  // with each logo in one color.
  const ICON_STYLES = [
    { id: 'standard', name: 'Standard' },
    { id: 'white', name: 'Glass, white', glass: true },
    { id: 'brand', name: 'Glass, brand colors', glass: true },
    { id: 'ice', name: 'Glass, ice blue', glass: true },
  ];
  // Night mode: from the chosen hour until 7 AM the launcher dims, and on a rooted TV the helper
  // (tv/helper) turns on the TV's Eye Comfort Mode and energy saving. The setting saved is the
  // id, the start hour as text, which the helper reads from the layout backup; its nightNow()
  // and NIGHT_ENDS must match isNight() and NIGHT_ENDS here.
  const NIGHT_MODES = [
    { id: 'off', name: 'Off', hour: null },
    { id: '21', name: '9 PM to 7 AM', hour: 21 },
    { id: '22', name: '10 PM to 7 AM', hour: 22 },
    { id: '23', name: '11 PM to 7 AM', hour: 23 },
    { id: '0', name: 'Midnight to 7 AM', hour: 0 },
  ];
  const NIGHT_ENDS = 7;
  // The glass's own color, also picked in the sidebar.
  const GLASS_TINTS = [
    { id: 'clear', name: 'Clear', color: 'rgba(20, 22, 30, 0.28)' },
    { id: 'smoke', name: 'Smoke', color: 'rgba(0, 0, 0, 0.55)' },
    { id: 'blue', name: 'Blue', color: 'rgba(40, 95, 210, 0.34)' },
    { id: 'purple', name: 'Purple', color: 'rgba(125, 60, 210, 0.34)' },
    { id: 'pink', name: 'Pink', color: 'rgba(225, 60, 150, 0.32)' },
    { id: 'red', name: 'Red', color: 'rgba(205, 30, 45, 0.34)' },
    { id: 'green', name: 'Green', color: 'rgba(25, 160, 110, 0.32)' },
    { id: 'gold', name: 'Gold', color: 'rgba(205, 150, 40, 0.32)' },
  ];
  const AMBIENT_FALLBACK = 'hsl(222, 30%, 24%)';

  // Order, hidden apps, Favorites and theme are kept in localStorage. A fresh install (nothing
  // stored) starts from the last backup instead: the one on the TV, else the one packaged.
  const LAYOUT_KEYS = ['order', 'hidden', 'favorites', 'theme', 'settings'];
  const LAYOUT_FILE = '/home/root/.config/minimal-launcher/layout.json';
  const packagedLayout = window.LAUNCHER_LAYOUT || {};

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
    order: store.get('order', packagedLayout.order || []),
    hidden: store.get('hidden', packagedLayout.hidden || []),
    favorites: store.get('favorites', packagedLayout.favorites || data.favorites || []),
    used: store.get('used', []),
    // Choices made in the sidebar: screensaverMinutes, clock24, units.
    settings: store.get('settings', packagedLayout.settings || {}),   // app IDs last on screen, newest first (from the TV helper)
    showHidden: false,
    editing: null,   // app key, or "input:<id>" for an input, of the tile being edited
    focus: null,     // key of the focused item, e.g. "app:netflix" or "continue:2"
    // config.json can set the starting theme; the blue button's choice wins after that.
    theme: migrateTheme(store.get('theme', packagedLayout.theme || data.theme || THEMES[0].id)),
    rowIndex: {},    // where focus last was in each scrolling row, to land there again
    weather: null,
    plexRows: {
      continue: { items: store.get('cache.continue', []), error: null, loaded: false },
      recent: { items: store.get('cache.recent', []), error: null, loaded: false },
      watchlist: { items: store.get('cache.watchlist', []), error: null, loaded: false },
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

  function inputByKey(key) {
    return key.indexOf('input:') === 0 ? inputs.filter((i) => 'input:' + i.id === key)[0] || null : null;
  }

  function inputItem(i) {
    return { key: 'input:' + i.id, kind: 'input', input: i };
  }

  // Favorites hold app keys, plus "input:<id>" for inputs pinned there.
  function favoriteItems() {
    return state.favorites.map((key) => {
      const input = inputByKey(key);
      if (input) return inputItem(input);
      const app = appByKey(key);
      return app && shown(app) ? appItem(app) : null;
    }).filter(Boolean);
  }

  // Recently used apps and inputs, as tiles of their own: "used:" keys keep them apart from the
  // same app's tile in another row, and they open but don't edit.
  function usedItems() {
    const out = [];
    state.used.forEach((id) => {
      if (out.length >= 6 || id === SELF_ID) return;
      const app = apps.filter((a) => a.id === id && shown(a))[0];
      if (app) out.push({ key: 'used:' + app.key, kind: 'app', app: app, used: true });
      const input = inputs.filter((i) => i.appId === id)[0];
      if (input) out.push({ key: 'used:input:' + input.id, kind: 'input', input: input, used: true });
    });
    return out;
  }

  function favoriteKey(item) {
    return item.kind === 'app' ? item.app.key : item.key;
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
    const favs = favoriteItems();
    if (favs.length) sections.push({ id: 'favorites', title: 'Favorites', scroll: true, big: true, items: favs });
    const used = usedItems();
    if (used.length) sections.push({ id: 'used', title: 'Recently Used', scroll: true, big: true, items: used });
    if (plex) {
      sections.push(plexSection('continue', 'Continue Watching', 'Nothing in progress'));
      // Only where the TV's file can be read (not in a desktop browser preview).
      if (data.rooted && window.Luna.available()) sections.push(plexSection('watchlist', 'Watchlist', 'Nothing saved'));
      sections.push(plexSection('recent', 'Recently Added', 'Nothing new'));
    }
    sections.push({ id: 'apps', title: favs.length ? 'All Apps' : 'Apps', items: gridApps().map(appItem) });
    sections.push({ id: 'inputs', title: 'Inputs', items: inputs.filter((i) => state.favorites.indexOf('input:' + i.id) === -1).map(inputItem) });

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

  // The logo as a one-color silhouette (white, brand color and ice blue), shown instead of the
  // icon by the glass icon styles.
  function addGlassIcon(box, glass) {
    if (!glass || !glass.brand) return;
    ['white', 'brand', 'ice'].forEach((kind) => {
      const img = el('img', 'tile-mono mono-' + kind);
      img.src = glass[kind];
      img.alt = '';
      box.appendChild(img);
    });
    box.classList.add('has-mono');
  }

  function renderTile(item, big) {
    const tile = el('div', big ? 'tile tile-big' : 'tile');
    tile.dataset.key = item.key;
    const box = el('div', 'tile-box');
    let title;

    if (item.kind === 'app') {
      const app = item.app;
      title = app.title;
      if (app.bgColor) box.style.setProperty('--tile-bg', app.bgColor);
      addGlassIcon(box, app.glass);
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
      if (item.input.bgColor) box.style.setProperty('--tile-bg', item.input.bgColor);
      addGlassIcon(box, item.input.glass);
      if (item.input.icon) {
        const img = el('img');
        img.src = item.input.icon;
        img.alt = '';
        img.onerror = () => { box.innerHTML = HDMI_GLYPH; };
        box.appendChild(img);
      } else {
        box.innerHTML = HDMI_GLYPH;
      }
      if (item.key === state.editing) {
        tile.classList.add('editing');
        box.appendChild(el('span', 'tile-badge tile-badge-edit', 'Editing'));
      }
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
    const icons = iconStyle();
    const app = $('app');
    const wallpaper = wallpaperFor(state.theme);
    // Every wallpaper shares the theme-photo look. sb-open stays, so the sidebar stays open when
    // the theme changes from its menu.
    app.className = 'theme-' + (wallpaper ? 'photo' : state.theme) + (window.Scenes.has(state.theme) ? ' painted' : '') +
      (icons.glass ? ' glass glass-' + icons.id : '') + (app.classList.contains('sb-open') ? ' sb-open' : '');
    app.style.setProperty('--glass-tint', glassTint().color);
    const backdrop = $('backdrop');

    // A painted scene is built when its theme comes on and removed when it goes.
    const scene = backdrop.querySelector('.scene');
    if (!scene || scene.dataset.theme !== state.theme) {
      if (scene) backdrop.removeChild(scene);
      let next = null;
      try {
        next = window.Scenes.build(state.theme);
      } catch (e) {
        // A broken scene leaves the plain background rather than a broken launcher.
      }
      if (next) {
        next.dataset.theme = state.theme;
        backdrop.insertBefore(next, backdrop.firstChild);
      }
    }
    backdrop.style.backgroundImage = wallpaper && !wallpaper.video ? 'url("' + wallpaper.src + '")' : '';

    // A video wallpaper plays only while its theme is on, so it isn't decoding in the background.
    let video = backdrop.querySelector('video');
    if (video && !(wallpaper && wallpaper.video && video.dataset.src === wallpaper.src)) {
      video.pause();
      // Lets go of the TV's video decoder now rather than whenever the element is collected.
      video.removeAttribute('src');
      video.load();
      backdrop.removeChild(video);
      video = null;
    }
    if (wallpaper && wallpaper.video && !video) {
      video = el('video', 'wall-video');
      video.dataset.src = wallpaper.src;
      video.muted = true;
      video.loop = true;
      video.autoplay = true;
      video.setAttribute('playsinline', '');
      video.src = wallpaper.src;
      backdrop.insertBefore(video, backdrop.firstChild);
      const played = video.play();
      if (played && played.catch) played.catch(() => {});
    }
  }

  function iconStyle() {
    return ICON_STYLES.filter((t) => t.id === state.settings.icons)[0] || ICON_STYLES[0];
  }

  // A setting that changes the look: saved, then shown.
  function setLook(key, id) {
    saveSetting(key, id);
    applyTheme();
  }

  function setIcons(id) {
    setLook('icons', id);
  }

  function cycleIcons() {
    const i = ICON_STYLES.indexOf(iconStyle());
    const next = ICON_STYLES[(i + 1) % ICON_STYLES.length];
    setIcons(next.id);
    toast('Icons: ' + next.name);
  }

  function setGlassTint(id) {
    setLook('glassTint', id);
  }

  function glassTint() {
    return GLASS_TINTS.filter((t) => t.id === state.settings.glassTint)[0] || GLASS_TINTS[0];
  }

  function setTheme(id) {
    state.theme = id;
    saveLayout('theme', id);
    applyTheme();
  }

  function cycleTheme() {
    const i = THEMES.map((t) => t.id).indexOf(state.theme);
    const next = THEMES[(i + 1) % THEMES.length];
    setTheme(next.id);
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
    if (sidebar.open) return;

    if (state.editing) {
      const app = appByKey(state.editing);
      const fav = state.favorites.indexOf(state.editing) !== -1;
      if (fav) add('key-text', '◀ ▶', 'Move');
      else if (app) add('key-text', '◀ ▶ ▲ ▼', 'Move');
      add('key-green', '', fav ? 'Remove from Favorites' : 'Add to Favorites');
      if (app) add('key-red', '', isHidden(app) ? 'Unhide' : 'Hide');
      add('key-text', 'OK', 'Done');
      return;
    }
    const item = focusedItem();
    if (item && item.kind === 'app') {
      add('key-text', 'OK', 'Open');
      if (!item.used) add('key-yellow', '', 'Edit (or hold OK)');
    } else if (item && item.kind === 'plex') {
      add('key-text', 'OK', 'Open ' + (plexApp() ? plexApp().title : 'Plex'));
    } else if (item) {
      add('key-text', 'OK', 'Switch input');
      if (!item.used) add('key-yellow', '', 'Edit (or hold OK)');
    }
    if (state.hidden.length) add('key-green', '', state.showHidden ? 'Leave out hidden apps' : 'Show hidden apps');
    add('key-red', '', 'Icons');
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

  // PlxNative opens a given title when launched with {"plex": {...}} (its docs/launch-links.md).
  // Before webOS 7.4 it only reads that on a cold start, so close it first.
  const PLXNATIVE = 'com.beb.plxnative';

  function openInPlex(item, row) {
    const app = plexApp();
    const title = app ? app.title : 'Plex';
    if (plex.appId !== PLXNATIVE || !item.ratingKey) {
      launch(plex.appId, app ? app.params : null, title);
      return;
    }
    const params = { plex: { ratingKey: String(item.ratingKey), action: row === 'continue' ? 'play' : 'open' } };
    if (plex.machineId) params.plex.server = plex.machineId;
    if (!window.Luna.available()) {
      toast(title + ' opens ' + item.title + ' here on the TV');
      return;
    }
    toast('Opening ' + item.title + '…');
    const closed = window.Luna.close(PLXNATIVE).catch(() => {
      if (!data.rooted) return null;
      return window.Luna.exec('script -q -c "luna-send -n 1 luna://com.webos.applicationManager/closeByAppId \'{\\"id\\":\\"' + PLXNATIVE + '\\"}\'" /dev/null < /dev/null').catch(() => null);
    });
    closed.then(() => new Promise((resolve) => setTimeout(resolve, 700)))
      .then(() => window.Luna.launch(PLXNATIVE, params))
      .catch((err) => toast("Couldn't open " + title + ': ' + err.message));
  }

  function activate() {
    const item = focusedItem();
    if (!item) return;
    if (item.kind === 'input') {
      launch(item.input.appId, null, item.input.title);
    } else if (item.kind === 'plex') {
      openInPlex(item.item, item.key.split(':')[0]);
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
      else if (c < 0) openSidebar();
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
    if (!item || item.used || (item.kind !== 'app' && item.kind !== 'input')) return;
    state.editing = favoriteKey(item);
    render();
  }

  function finishEdit() {
    state.editing = null;
    render();
  }

  function saveFavorites(list) {
    state.favorites = list;
    saveLayout('favorites', list);
  }

  function moveEditing(dx, dy) {
    const key = state.editing;
    if (state.favorites.indexOf(key) !== -1) {
      // Favorites are one row: only sideways moves.
      if (!dx) return;
      const shownKeys = favoriteItems().map(favoriteKey);
      const other = shownKeys[shownKeys.indexOf(key) + dx];
      if (!other) return;
      const list = state.favorites.slice();
      list[list.indexOf(key)] = other;
      list[state.favorites.indexOf(other)] = key;
      saveFavorites(list);
      render();
      return;
    }
    // Inputs keep the TV's order outside Favorites.
    if (!appByKey(key)) return;

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
    saveLayout('order', order);
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
    if (!appByKey(key)) return;
    const i = state.hidden.indexOf(key);
    if (i === -1) state.hidden.push(key);
    else state.hidden.splice(i, 1);
    saveLayout('hidden', state.hidden);
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
    const cfg = Object.assign({}, weatherCfg, state.settings.units ? { units: state.settings.units } : {});
    window.Weather.current(cfg).then((w) => {
      state.weather = w;
      renderWeather();
    }, () => {});
  }

  // ---------------------------------------------------------------- screensaver

  const saver = { on: false, idle: null, timer: null, drift: null, deck: [], front: 0, lastVideo: false, single: false };
  const ownSlides = data.screensaver && data.screensaver.length ? data.screensaver : null;
  // The sidebar's screensaver picker: all of your own pictures and videos, or just one.
  const SAVER_PICKS = ownSlides ? [{ id: 'all', name: 'All, shuffled' }].concat(ownSlides.map((sl) => ({ id: sl.id || sl.src, name: sl.name || sl.src }))) : [];

  function saverPick() {
    return SAVER_PICKS.filter((p) => p.id === state.settings.saverPick)[0] || SAVER_PICKS[0];
  }

  function resetIdle() {
    clearTimeout(saver.idle);
    if (saverMinutes() > 0) saver.idle = setTimeout(startSaver, saverMinutes() * 60000);
  }

  function saverSlides() {
    if (ownSlides) {
      const pick = saverPick().id;
      return ownSlides.filter((s) => pick === 'all' || (s.id || s.src) === pick).map((s) => ({ src: s.src, video: s.video, caption: '' }));
    }
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
      // A screensaver of one picture just stays up.
      if (!saver.single) saver.timer = setTimeout(nextSlide, SLIDE_MS);
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
      // A short clip loops until a picture's worth of time has passed, and a screensaver of one
      // video loops for good.
      if (saver.single) video.loop = true;
      else if (!(video.duration * 1000 >= SLIDE_MS)) {
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
    saver.single = saverSlides().length === 1;
    // One video at a time: the wallpaper rests while the screensaver runs.
    if (wallVideo()) wallVideo().pause();
    $('saver').classList.add('show');
    window.Scenes.pause();
    driftSaverInfo();
    saver.drift = setInterval(driftSaverInfo, 30000);
    nextSlide();
  }

  function stopSaver() {
    saver.on = false;
    clearTimeout(saver.timer);
    clearInterval(saver.drift);
    $('saver').classList.remove('show');
    window.Scenes.play();
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
    if (!state.editing && item && !item.used && (item.kind === 'app' || item.kind === 'input')) startEdit();
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

    if (sidebar.open) {
      e.preventDefault();
      // OK acts on the first keydown; the swallow keeps its keyup from reaching the grid.
      if (k === KEY.ENTER) {
        if (ok.down) return;
        ok.down = true;
        ok.swallow = true;
      }
      sidebarKey(k);
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
    // Red hides an app while editing; otherwise it switches the icons.
    if ((k === KEY.RED || k === KEY.R) && !state.editing) {
      cycleIcons();
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

  // ---------------------------------------------------------------- sidebar

  // A Roku-style menu that slides out from the left: inputs, launcher settings, the TV's HDMI
  // settings and system actions. Menus are functions, so values are current on every render.
  // stack holds the menus walked into, with the item each was opened from, to land back on it.
  // dropdown: the index of the item whose drop-down is open, if any.
  const sidebar = { open: false, stack: [], index: 0, armed: null, armedTimer: null, hdmi: null, dropdown: null };

  const SB_ICONS = {
    home: '<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/>',
    input: '<path d="M3 6h18v12H3z"/><path d="M8 21h8"/>',
    gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
    hdmi: '<path d="M2 8h20v5l-3 4H5l-3-4z"/><path d="M7 12h10"/>',
    power: '<path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/>',
    moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
    picture: '<path d="M3 5h18v12H3z"/><path d="M3 14l5-4 4 3 3-2 6 4"/>',
  };

  function sbIcon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + SB_ICONS[name] + '</svg>';
  }

  function saveSetting(key, value) {
    const next = Object.assign({}, state.settings);
    next[key] = value;
    state.settings = next;
    saveLayout('settings', next);
  }

  // A system call as root through the Homebrew Channel. The payload goes over base64, so no
  // shell quoting can break it.
  function rootLuna(uri, payload) {
    const b64 = btoa(JSON.stringify(payload));
    return window.Luna.exec('p=$(echo ' + b64 + ' | base64 -d); script -q -c "luna-send -n 1 ' + uri + " '$p'\" /dev/null < /dev/null")
      .then((res) => {
        const m = /\{[\s\S]*\}/.exec(res.stdoutString || '');
        const reply = m ? JSON.parse(m[0]) : {};
        if (reply.returnValue === false) throw new Error(reply.errorText || 'the TV refused');
        return reply;
      });
  }

  const HDMI_KEYS = ['uhdDeepColorHDMI1', 'uhdDeepColorHDMI2', 'uhdDeepColorHDMI3', 'uhdDeepColorHDMI4', 'hdmiPcMode', 'simplinkEnable', 'simplinkAutoPowerOn'];

  function loadHdmi() {
    rootLuna('luna://com.webos.settingsservice/getSystemSettings', { category: 'other', keys: HDMI_KEYS }).then((r) => {
      sidebar.hdmi = r.settings || {};
      renderSidebar();
    }, (err) => {
      sidebar.hdmi = { error: err.message };
      renderSidebar();
    });
  }

  function setTvSetting(key, value) {
    const settings = {};
    settings[key] = value;
    rootLuna('luna://com.webos.settingsservice/setSystemSettings', { category: 'other', settings: settings }).then(() => {
      sidebar.hdmi[key] = value;
      renderSidebar();
    }, (err) => toast("Couldn't change that: " + err.message));
  }

  function onOff(v) {
    return v === 'on' || v === true ? 'On' : 'Off';
  }

  function portOf(input) {
    const m = /HDMI_(\d)/.exec(input.id);
    return m ? Number(m[1]) : null;
  }

  function rootMenu() {
    const items = [
      { label: 'Home', icon: 'home', run: closeSidebar },
      { label: 'Inputs', icon: 'input', menu: inputsMenu },
      { label: 'Launcher settings', icon: 'gear', menu: settingsMenu },
    ];
    if (data.rooted) {
      items.splice(2, 0,
        { label: 'Picture & sound', icon: 'picture', menu: avMenu },
        { label: 'Sleep timer', icon: 'moon', value: sleepLabel(), run: cycleSleep });
      items.push({ label: 'HDMI settings', icon: 'hdmi', menu: hdmiMenu });
      items.push({ label: 'System', icon: 'power', menu: systemMenu });
    } else {
      items.push({ label: 'TV settings', icon: 'power', run: () => launch('com.palm.app.settings', null, 'Settings') });
    }
    return { title: 'Menu', items: items };
  }

  function inputsMenu() {
    return {
      title: 'Inputs',
      items: inputs.map((i) => ({ label: i.title, run: () => { closeSidebar(); launch(i.appId, null, i.title); } })),
    };
  }

  const SAVER_STEPS = [0, 2, 5, 10, 15, 30];

  // A sidebar item that opens as a drop-down of list; picked is the list's current entry.
  function choice(label, list, picked, pick) {
    return { label: label, value: picked ? picked.name : '', choices: list, current: picked ? picked.id : null, pick: pick };
  }

  function settingsMenu() {
    const s = state.settings;
    const theme = THEMES.filter((t) => t.id === state.theme)[0];
    const minutes = saverMinutes();
    return {
      title: 'Launcher settings',
      items: [
        choice('Theme', THEMES, theme, setTheme),
        choice('Icons', ICON_STYLES, iconStyle(), setIcons),
      ].concat(iconStyle().glass ? [
        choice('Glass color', GLASS_TINTS, glassTint(), setGlassTint),
      ] : [], [
        choice('Night mode', NIGHT_MODES, nightMode(), (id) => { saveSetting('night', id); tick(); }),
        {
          label: 'Screensaver',
          value: minutes ? 'After ' + minutes + ' min' : 'Off',
          run: () => {
            const i = SAVER_STEPS.indexOf(minutes);
            saveSetting('screensaverMinutes', SAVER_STEPS[(i + 1) % SAVER_STEPS.length]);
            resetIdle();
          },
        },
      ], SAVER_PICKS.length > 2 ? [
        choice('Screensaver shows', SAVER_PICKS, saverPick(), (id) => saveSetting('saverPick', id)),
      ] : [], [
        { label: 'Start the screensaver', run: () => { closeSidebar(); startSaver(); } },
        { label: 'Clock', value: s.clock24 ? '24-hour' : '12-hour', run: () => { saveSetting('clock24', !s.clock24); tick(); } },
        {
          label: 'Temperature',
          value: (s.units || (weatherCfg && weatherCfg.units) || 'fahrenheit') === 'celsius' ? '°C' : '°F',
          run: () => {
            const now = s.units || (weatherCfg && weatherCfg.units) || 'fahrenheit';
            saveSetting('units', now === 'celsius' ? 'fahrenheit' : 'celsius');
            loadWeather();
          },
        },
        { label: 'Hidden apps', value: state.showHidden ? 'Shown' : 'Left out', run: () => { state.showHidden = !state.showHidden; render(); } },
        { label: 'Reload the launcher', run: () => location.reload() },
      ]),
    };
  }

  function hdmiMenu() {
    if (!sidebar.hdmi) {
      loadHdmi();
      return { title: 'HDMI settings', items: [{ label: 'Reading the TV\'s settings…', disabled: true }] };
    }
    if (sidebar.hdmi.error) return { title: 'HDMI settings', items: [{ label: "Couldn't read them: " + sidebar.hdmi.error, disabled: true }] };
    const h = sidebar.hdmi;
    const items = inputs.filter((i) => portOf(i)).map((i) => ({ label: i.title, value: 'HDMI ' + portOf(i), menu: () => portMenu(i) }));
    items.push({ label: 'SIMPLINK (HDMI-CEC)', value: onOff(h.simplinkEnable), run: () => setTvSetting('simplinkEnable', h.simplinkEnable === 'on' ? 'off' : 'on') });
    items.push({ label: 'Auto power sync', value: onOff(h.simplinkAutoPowerOn), run: () => setTvSetting('simplinkAutoPowerOn', h.simplinkAutoPowerOn === 'on' ? 'off' : 'on') });
    return { title: 'HDMI settings', items: items };
  }

  function portMenu(input) {
    const n = portOf(input);
    const h = sidebar.hdmi;
    const deep = 'uhdDeepColorHDMI' + n;
    let pc = {};
    try {
      pc = JSON.parse(h.hdmiPcMode || '{}');
    } catch (e) {
      // Unreadable: treat every port as off.
    }
    return {
      title: input.title + ' · HDMI ' + n,
      items: [
        { label: 'Switch to ' + input.title, run: () => { closeSidebar(); launch(input.appId, null, input.title); } },
        { label: 'Deep Color (4K HDR)', value: onOff(h[deep]), run: () => setTvSetting(deep, h[deep] === 'on' ? 'off' : 'on') },
        {
          label: 'PC mode',
          value: onOff(pc['hdmi' + n]),
          run: () => {
            const next = Object.assign({}, pc);
            next['hdmi' + n] = !pc['hdmi' + n];
            setTvSetting('hdmiPcMode', JSON.stringify(next));
          },
        },
      ],
    };
  }

  function systemMenu() {
    return {
      title: 'System',
      items: [
        { label: 'LG settings', run: () => { closeSidebar(); launch('com.palm.app.settings', null, 'Settings'); } },
        {
          label: 'Turn off the TV',
          confirm: 'Press OK again to turn off',
          run: () => {
            // Dark at once, like the remote's power button; the TV takes a moment more to power
            // down. tv/bin/power-off also darkens the panel itself.
            document.body.classList.add('powering-off');
            // In case the TV stays on. Coming back on screen also clears it (start()).
            setTimeout(() => document.body.classList.remove('powering-off'), 15000);
            // Started on its own, so a slow shutdown can't outlast the call's time limit. Without
            // tv/bin installed, the plain power-off, started the same way.
            window.Luna.exec('P=/home/root/minimal-launcher/bin/power-off; if [ -x $P ]; then setsid $P > /dev/null 2>&1 < /dev/null & ' +
              'else setsid script -q -c "luna-send -n 1 luna://com.webos.service.tvpower/power/powerOff \'{\\"reason\\":\\"remoteKey\\"}\'" /dev/null > /dev/null 2>&1 < /dev/null & fi')
              .catch((err) => {
                document.body.classList.remove('powering-off');
                toast("Couldn't turn off: " + err.message);
              });
          },
        },
        {
          label: 'Reboot the TV',
          confirm: 'Press OK again to reboot',
          run: () => {
            toast('Rebooting…');
            window.Luna.exec('sync; reboot').catch(() => {});
          },
        },
      ],
    };
  }

  // ----- sleep timer: the TV-side helper turns the TV off when the time comes (tv/helper).

  const SLEEP_FILE = '/run/minimal-launcher/sleep.json';
  const SLEEP_STEPS = [30, 60, 90, 120];

  function loadSleep() {
    window.Luna.exec('cat ' + SLEEP_FILE).then((res) => {
      const at = JSON.parse(res.stdoutString).at;
      sidebar.sleepAt = at > Date.now() ? at : null;
      renderSidebar();
    }, () => {
      sidebar.sleepAt = null;
      renderSidebar();
    });
  }

  function sleepLeft() {
    return sidebar.sleepAt ? Math.max(1, Math.ceil((sidebar.sleepAt - Date.now()) / 60000)) : 0;
  }

  function sleepLabel() {
    return sleepLeft() ? sleepLeft() + ' min left' : 'Off';
  }

  // Each OK picks the next step up from the time left, then Off after the longest.
  function cycleSleep() {
    const left = sleepLeft();
    const next = SLEEP_STEPS.filter((m) => m > left + 1)[0] || 0;
    sidebar.sleepAt = next ? Date.now() + next * 60000 : null;
    const command = next
      ? 'mkdir -p /run/minimal-launcher && chmod 700 /run/minimal-launcher && echo \'{"at":' + sidebar.sleepAt + '}\' > ' + SLEEP_FILE
      : 'rm -f ' + SLEEP_FILE;
    window.Luna.exec(command).then(() => toast(next ? 'The TV turns off in ' + next + ' minutes' : 'Sleep timer off'),
      () => toast("Couldn't set the sleep timer"));
  }

  // ----- picture and sound modes, per input: LG keeps one of each for every input, and one
  // for the apps.

  const MODE_NAMES = {
    vivid: 'Vivid', normal: 'Standard', eco: 'Eco', cinema: 'Cinema', sports: 'Sports', game: 'Game',
    hdrEffect: 'HDR Effect', filmMaker: 'Filmmaker', expert1: 'Expert (bright room)', expert2: 'Expert (dark room)',
    aiSoundPlus: 'AI Sound Pro', aiSound: 'AI Sound', standard: 'Standard', movie: 'Cinema', news: 'Clear Voice', music: 'Music',
  };
  const AV_KEYS = { picture: 'pictureMode', sound: 'soundMode' };

  function modeName(v) {
    return MODE_NAMES[v] || v || '';
  }

  function avTargets() {
    return [{ id: 'default', label: 'Apps & launcher' }].concat(inputs.filter((i) => portOf(i)).map((i) => ({ id: 'hdmi' + portOf(i), label: i.title })));
  }

  function avDimension(kind, target) {
    return kind === 'picture' ? { input: target, _3dStatus: '2d', dynamicRange: 'sdr' } : { input: target };
  }

  function loadAv() {
    sidebar.av = { modes: {}, values: {} };
    const reads = [];
    ['picture', 'sound'].forEach((kind) => {
      reads.push(rootLuna('luna://com.webos.settingsservice/getSystemSettingValues', { category: kind, key: AV_KEYS[kind] })
        .then((r) => { sidebar.av.values[kind] = r.values.arrayExt.filter((v) => v.visible).map((v) => v.value); }));
      avTargets().forEach((t) => {
        reads.push(rootLuna('luna://com.webos.settingsservice/getSystemSettings', { category: kind, keys: [AV_KEYS[kind]], dimension: avDimension(kind, t.id) })
          .then((r) => { sidebar.av.modes[kind + ':' + t.id] = r.settings[AV_KEYS[kind]]; }));
      });
    });
    Promise.all(reads).then(() => { sidebar.av.ready = true; renderSidebar(); }, (err) => { sidebar.av.error = err.message; renderSidebar(); });
  }

  function avMenu() {
    if (!sidebar.av) loadAv();
    if (!sidebar.av.ready) {
      const label = sidebar.av.error ? "Couldn't read them: " + sidebar.av.error : 'Reading the TV\'s settings…';
      return { title: 'Picture & sound', items: [{ label: label, disabled: true }] };
    }
    return {
      title: 'Picture & sound',
      items: avTargets().map((t) => ({
        label: t.label,
        value: modeName(sidebar.av.modes['picture:' + t.id]),
        menu: () => ({
          title: t.label,
          items: ['picture', 'sound'].map((kind) => ({
            label: kind === 'picture' ? 'Picture mode' : 'Sound mode',
            value: modeName(sidebar.av.modes[kind + ':' + t.id]),
            menu: () => modeMenu(kind, t),
          })),
        }),
      })),
    };
  }

  function modeMenu(kind, target) {
    const key = kind + ':' + target.id;
    return {
      title: target.label + ' · ' + (kind === 'picture' ? 'picture' : 'sound'),
      items: (sidebar.av.values[kind] || []).map((v) => ({
        label: modeName(v),
        value: sidebar.av.modes[key] === v ? '✓' : '',
        run: () => {
          const settings = {};
          settings[AV_KEYS[kind]] = v;
          rootLuna('luna://com.webos.settingsservice/setSystemSettings', { category: kind, settings: settings, dimension: avDimension(kind, target.id) })
            .then(() => {
              sidebar.av.modes[key] = v;
              sidebarBack();
            }, (err) => toast("Couldn't change that: " + err.message));
        },
      })),
    };
  }

  // An item with choices opens as a drop-down: its choices sit under it in the same menu until
  // one is picked or Back closes it.
  function currentMenu() {
    const menu = sidebar.stack[sidebar.stack.length - 1].menu();
    const at = sidebar.dropdown == null ? -1 : sidebar.dropdown;
    const parent = menu.items[at];
    if (!parent || !parent.choices) return menu;
    const options = parent.choices.map((c) => ({
      label: c.name,
      option: true,
      value: c.id === parent.current ? '✓' : '',
      run: () => {
        parent.pick(c.id);
        closeDropdown();
      },
    }));
    return { title: menu.title, items: menu.items.slice(0, at + 1).concat(options, menu.items.slice(at + 1)) };
  }

  function openDropdown(it) {
    const at = sidebar.index;
    sidebar.dropdown = at;
    sidebar.index = at + 1 + Math.max(0, it.choices.map((c) => c.id).indexOf(it.current));
  }

  function closeDropdown() {
    sidebar.index = sidebar.dropdown;
    sidebar.dropdown = null;
  }

  function renderSidebar() {
    if (!sidebar.open) return;
    const menu = currentMenu();
    const usable = menu.items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i !== -1);
    if (usable.indexOf(sidebar.index) === -1) sidebar.index = usable.length ? usable[0] : 0;
    $('sb-title').textContent = menu.title;
    $('sb-back').style.visibility = sidebar.stack.length > 1 ? 'visible' : 'hidden';
    const list = $('sb-list');
    list.textContent = '';
    menu.items.forEach((it, i) => {
      const row = el('div', 'sb-item' + (i === sidebar.index ? ' focused' : '') + (it.disabled ? ' disabled' : '') +
        (sidebar.armed === it.label ? ' armed' : '') + (it.option ? ' sb-option' : '') + (i === sidebar.dropdown ? ' open' : ''));
      if (it.icon) {
        const icon = el('span', 'sb-icon');
        icon.innerHTML = sbIcon(it.icon);
        row.appendChild(icon);
      }
      row.appendChild(el('span', 'sb-label', it.label));
      const value = sidebar.armed === it.label ? it.confirm : it.value;
      if (value) row.appendChild(el('span', 'sb-value', value));
      if (it.menu) row.appendChild(el('span', 'sb-more', '›'));
      // The TV's fonts have no ▾, so it's the › turned.
      if (it.choices) row.appendChild(el('span', 'sb-more sb-drop', '›'));
      row.addEventListener('click', () => {
        sidebar.index = i;
        sidebarSelect();
      });
      list.appendChild(row);
    });
    $('sb-foot').textContent = sidebar.stack.length > 1 ? 'OK choose  ·  ◀ or BACK go back' : 'OK choose  ·  ▶ or BACK close';
    // Long lists (an open drop-down) scroll to keep the focused row in view.
    const row = list.children[sidebar.index];
    if (row) {
      if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
      else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
    }
  }

  function launchParams(detail) {
    try {
      return detail || JSON.parse((window.PalmSystem && window.PalmSystem.launchParams) || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  function openSidebar() {
    sidebar.open = true;
    sidebar.stack = [{ menu: rootMenu, from: 0 }];
    sidebar.index = 0;
    sidebar.dropdown = null;
    sidebar.hdmi = null;
    sidebar.av = null;
    sidebar.sleepAt = null;
    if (data.rooted && window.Luna.available()) loadSleep();
    $('sidebar').classList.add('open');
    $('sidebar').setAttribute('aria-hidden', 'false');
    $('app').classList.add('sb-open');
    renderSidebar();
    renderHints();
  }

  function closeSidebar() {
    sidebar.open = false;
    sidebar.armed = null;
    $('sidebar').classList.remove('open');
    $('sidebar').setAttribute('aria-hidden', 'true');
    $('app').classList.remove('sb-open');
    renderHints();
  }

  function sidebarSelect() {
    const it = currentMenu().items[sidebar.index];
    if (!it || it.disabled) return;
    if (it.choices) {
      if (sidebar.dropdown === sidebar.index) closeDropdown();
      else openDropdown(it);
    } else if (it.menu) {
      sidebar.stack.push({ menu: it.menu, from: sidebar.index });
      sidebar.index = 0;
      sidebar.armed = null;
    } else if (it.confirm && sidebar.armed !== it.label) {
      // Turning off and rebooting take a second OK within a few seconds.
      sidebar.armed = it.label;
      clearTimeout(sidebar.armedTimer);
      sidebar.armedTimer = setTimeout(() => {
        sidebar.armed = null;
        renderSidebar();
      }, 4000);
    } else {
      sidebar.armed = null;
      it.run();
    }
    renderSidebar();
  }

  function sidebarKey(k) {
    const menu = currentMenu();
    const back = k === KEY.BACK || k === KEY.BACKSPACE || k === KEY.ESC;
    if (k === KEY.UP || k === KEY.DOWN) {
      const dir = k === KEY.UP ? -1 : 1;
      let i = sidebar.index;
      do {
        i += dir;
      } while (i >= 0 && i < menu.items.length && menu.items[i].disabled);
      // An open drop-down keeps focus on its choices.
      const inDropdown = sidebar.dropdown == null || (menu.items[i] && menu.items[i].option);
      if (i >= 0 && i < menu.items.length && inDropdown) sidebar.index = i;
      sidebar.armed = null;
      renderSidebar();
    } else if (k === KEY.ENTER) {
      sidebarSelect();
    } else if (k === KEY.RIGHT) {
      const it = menu.items[sidebar.index];
      if (it && (it.menu || (it.choices && sidebar.dropdown == null))) sidebarSelect();
      else if (sidebar.stack.length === 1 && sidebar.dropdown == null) closeSidebar();
    } else if (back || k === KEY.LEFT) {
      if (sidebar.dropdown != null) {
        closeDropdown();
        renderSidebar();
      } else if (sidebar.stack.length > 1) sidebarBack();
      else if (back) closeSidebar();
    }
  }

  function sidebarBack() {
    sidebar.dropdown = null;
    sidebar.index = sidebar.stack.pop().from;
    sidebar.armed = null;
    renderSidebar();
  }

  // ---------------------------------------------------------------- clock

  function tick() {
    const now = new Date();
    const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: !state.settings.clock24 });
    const date = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    $('time').textContent = time;
    $('date').textContent = date;
    $('saver-time').textContent = time;
    $('saver-date').textContent = date;
    document.body.classList.toggle('night', isNight(now));
  }

  function nightMode() {
    return NIGHT_MODES.filter((m) => m.id === state.settings.night)[0] || NIGHT_MODES[0];
  }

  function isNight(now) {
    const from = nightMode().hour;
    if (from === null) return false;
    const hour = now.getHours();
    return from > NIGHT_ENDS ? hour >= from || hour < NIGHT_ENDS : hour >= from && hour < NIGHT_ENDS;
  }

  // ---------------------------------------------------------------- Plex Watchlist

  // Written to the TV by the computer's hourly sync (tools/watchlist.mjs); titles on the server
  // carry its ratingKey, so they open in PlxNative like the other Plex cards.
  function loadWatchlist() {
    if (!plex || !data.rooted || !window.Luna.available()) return;
    const row = state.plexRows.watchlist;
    window.Luna.exec('cat /home/root/.config/minimal-launcher/watchlist.json').then((res) => {
      row.items = (JSON.parse(res.stdoutString).items || []).map((w) => {
        const onServer = !!w.ratingKey;
        const image = onServer ? window.Plex.image(plex, w.art, 480, 270) : w.publicArt;
        return {
          title: w.title,
          subtitle: onServer ? (w.year ? String(w.year) : '') : 'Not on your Plex server',
          meta: '',
          progress: 0,
          image: image,
          backdrop: onServer ? window.Plex.image(plex, w.art, 1920, 1080) : w.publicArt,
          ratingKey: w.ratingKey,
        };
      });
      row.loaded = true;
      store.set('cache.watchlist', row.items);
      render();
    }, () => {
      row.loaded = true;
      render();
    });
  }

  // ---------------------------------------------------------------- recently used

  // The TV-side helper (tv/helper) writes which apps were on screen; read it when we show up.
  function loadUsed() {
    if (!data.rooted || !window.Luna.available()) return;
    window.Luna.exec('cat /home/root/.config/minimal-launcher/recent.json').then((res) => {
      const ids = (JSON.parse(res.stdoutString).apps || []).map((a) => a.id);
      if (ids.join() === state.used.join()) return;
      state.used = ids;
      store.set('used', ids);
      render();
    }, () => {});
  }

  // ---------------------------------------------------------------- layout backup

  function layoutNow() {
    return { order: state.order, hidden: state.hidden, favorites: state.favorites, theme: state.theme, settings: state.settings };
  }

  let backupTimer = null;
  function saveLayout(key, value) {
    store.set(key, value);
    clearTimeout(backupTimer);
    backupTimer = setTimeout(backupLayout, 2000);
  }

  // Copies the layout to a file on the TV, outside the app, so a reinstall can't lose it.
  // The hourly sync on the computer keeps a copy of that file too.
  function backupLayout() {
    if (!data.rooted || !window.Luna.available()) return;
    const json = JSON.stringify(Object.assign(layoutNow(), { savedAt: new Date().toISOString() }));
    const b64 = btoa(unescape(encodeURIComponent(json)));
    window.Luna.exec('mkdir -p ' + LAYOUT_FILE.replace(/\/[^/]*$/, '') + " && echo '" + b64 + "' | base64 -d > " +
      LAYOUT_FILE + '.tmp && mv ' + LAYOUT_FILE + '.tmp ' + LAYOUT_FILE).catch(() => {});
  }

  // With nothing stored yet (a fresh install), take the layout from the TV's backup file if
  // it's newer than the packaged one. Otherwise back up what's here.
  function restoreLayout() {
    const fresh = LAYOUT_KEYS.every((k) => store.get(k, null) === null);
    if (!data.rooted || !window.Luna.available()) return;
    if (!fresh) {
      backupLayout();
      return;
    }
    window.Luna.exec('cat ' + LAYOUT_FILE).then((res) => {
      const saved = JSON.parse(res.stdoutString);
      if (packagedLayout.savedAt && saved.savedAt && saved.savedAt < packagedLayout.savedAt) return;
      LAYOUT_KEYS.forEach((k) => {
        if (saved[k] == null) return;
        state[k] = saved[k];
        store.set(k, saved[k]);
      });
      applyTheme();
      render();
    }).catch(() => {
      backupLayout();
    });
  }

  // ---------------------------------------------------------------- start

  function start() {
    applyTheme();
    tick();
    setInterval(tick, 10000);

    render();
    if (!state.focus && current.rows.length) setFocus(current.rows[0].items[0].key);
    if (launchParams().sidebar) openSidebar();

    // If the TV hands over the live app list, use it to drop uninstalled apps and add new ones.
    // Synced apps keep their entries, with the names, icons and colors config.json gave them.
    window.Luna.listLaunchPoints().then((res) => {
      const exclude = (data.exclude || []).map((e) => e.toLowerCase());
      const live = (res.launchPoints || []).filter((lp) => lp.id !== SELF_ID && !/^com\.webos\.app\.hdmi/.test(lp.id) &&
        exclude.indexOf(String(lp.id).toLowerCase()) === -1 && exclude.indexOf(String(lp.title).toLowerCase()) === -1);
      if (!live.length) return;
      const synced = new Map(apps.map((a) => [a.key, a]));
      apps = live.map((lp) => synced.get(lp.launchPointId || lp.id) || {
        key: lp.launchPointId || lp.id,
        id: lp.id,
        title: lp.title,
        icon: lp.largeIcon || lp.icon,
        bgColor: lp.iconColor || lp.bgColor,
        params: lp.params,
      });
      render();
    }, () => {});
    restoreLayout();
    loadUsed();
    loadWatchlist();

    loadPlex();
    loadWeather();
    setInterval(loadPlex, PLEX_REFRESH_MS);
    setInterval(loadWeather, WEATHER_REFRESH_MS);
    resetIdle();

    // Reload once a night, between 3 and 5 AM, while the launcher is out of sight or
    // showing the screensaver, so weeks of running don't build up.
    setInterval(() => {
      const now = new Date();
      const today = now.toDateString();
      if (now.getHours() < 3 || now.getHours() >= 5 || store.get('reloadedOn', '') === today) return;
      if (!document.hidden && !saver.on) return;
      store.set('reloadedOn', today);
      location.reload();
    }, 10 * 60 * 1000);

    // Home or Exit with the launcher already on screen launches it again (LG Input Hook): that
    // goes back to the top of the home screen, whatever was open.
    // The remote's sidebar button (tv/bin/launcher-sidebar) launches it with { sidebar: true }
    // instead, which opens the sidebar, or closes it if it's open.
    document.addEventListener('webOSRelaunch', (e) => {
      document.body.classList.remove('powering-off');
      if (saver.on) stopSaver();
      if (launchParams(e.detail).sidebar) {
        if (sidebar.open) closeSidebar();
        else openSidebar();
        resetIdle();
        return;
      }
      if (sidebar.open) closeSidebar();
      if (state.editing) finishEdit();
      state.showHidden = false;
      render();
      if (current.rows.length && current.rows[0].items.length) setFocus(current.rows[0].items[0].key);
      $('scroller').scrollTop = 0;
      resetIdle();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (saver.on) stopSaver();
        // Coming back lands on the home screen, and the sidebar button then always opens it.
        if (sidebar.open) closeSidebar();
        clearTimeout(saver.idle);
        // A painted scene stops moving while another app is on screen.
        window.Scenes.pause();
        return;
      }
      document.body.classList.remove('powering-off');
      window.Scenes.play();
      tick();
      loadUsed();
      loadWatchlist();
      loadPlex();
      loadWeather();
      resetIdle();
    });
  }

  start();
})();
