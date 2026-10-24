// Your Plex Watchlist (from plex.tv), with each title matched on your Plex server so the
// launcher can open it there. Written to the TV for the launcher's Watchlist row.
const PAGE = 40;

export async function fetchWatchlist(plex) {
  const token = `X-Plex-Token=${encodeURIComponent(plex.token)}`;
  const res = await fetch(`https://discover.provider.plex.tv/library/sections/watchlist/all?X-Plex-Container-Size=${PAGE}&${token}`,
    { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`plex.tv answered ${res.status}`);
  const items = (await res.json()).MediaContainer.Metadata || [];
  const out = [];
  for (const m of items) {
    let hit = null;
    try {
      const r = await fetch(`${plex.server}/library/all?guid=${encodeURIComponent(m.guid)}&${token}`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      if (r.ok) hit = ((await r.json()).MediaContainer.Metadata || [])[0] || null;
    } catch {
      // Unreachable server: the title is listed as not on it.
    }
    out.push({
      title: m.title,
      year: m.year || null,
      // On the server: its item, and artwork paths the launcher loads from the server.
      ratingKey: hit ? hit.ratingKey : null,
      art: hit ? hit.art || hit.thumb || null : null,
      // Not on the server: plex.tv's public artwork.
      publicArt: hit ? null : m.art || m.thumb || null,
    });
  }
  return out;
}
