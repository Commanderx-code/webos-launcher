// Reads Continue Watching from a Plex Media Server.
window.Plex = (function () {
  'use strict';

  const TIMEOUT_MS = 8000;
  const PAGE = { 'X-Plex-Container-Start': 0, 'X-Plex-Container-Size': 20 };

  function serverUrl(cfg, path, params) {
    const query = Object.keys(params || {}).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    query.push('X-Plex-Token=' + encodeURIComponent(cfg.token));
    return cfg.server.replace(/\/+$/, '') + path + '?' + query.join('&');
  }

  // The token goes in the query and Accept is a safelisted header, so this is a simple
  // cross-origin request with no preflight.
  function getJSON(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    return fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal })
      .then((res) => {
        if (!res.ok) {
          const err = new Error('Plex answered ' + res.status);
          err.status = res.status;
          throw err;
        }
        return res.json();
      }, (err) => {
        throw new Error(err.name === 'AbortError' ? "Plex server didn't answer" : "Can't reach the Plex server");
      })
      .finally(() => clearTimeout(timer));
  }

  function image(cfg, path, width, height) {
    if (!path) return null;
    return serverUrl(cfg, '/photo/:/transcode', { width: width, height: height, minSize: 1, upscale: 1, url: path });
  }

  function toItem(cfg, m) {
    const episode = m.type === 'episode';
    const left = m.duration ? Math.max(1, Math.round((m.duration - (m.viewOffset || 0)) / 60000)) : null;
    return {
      title: episode ? m.grandparentTitle : m.title,
      subtitle: episode ? 'S' + m.parentIndex + ' · E' + m.index + '  ' + m.title : (m.year ? String(m.year) : ''),
      meta: m.viewOffset ? (left ? left + ' min left' : '') : 'Up next',
      progress: m.viewOffset && m.duration ? Math.min(1, m.viewOffset / m.duration) : 0,
      image: image(cfg, episode ? (m.thumb || m.grandparentArt) : (m.art || m.thumb), 480, 270),
      ratingKey: m.ratingKey,
    };
  }

  // Newer servers have the merged Continue Watching hub; older ones only On Deck.
  function continueWatching(cfg) {
    return getJSON(serverUrl(cfg, '/hubs/continueWatching/items', PAGE))
      .catch((err) => {
        if (err.status === 400 || err.status === 404) return getJSON(serverUrl(cfg, '/library/onDeck', PAGE));
        throw err;
      })
      .then((json) => ((json.MediaContainer && json.MediaContainer.Metadata) || []).map((m) => toItem(cfg, m)));
  }

  return { continueWatching: continueWatching };
})();
