// /servers/: refreshes the player counts and "Works in webAC" cells from the bridge's live list.
// The page ships with a snapshot (what crawlers see); this only updates the numbers in place.
(() => {
  const table = document.querySelector('table.servers');
  if (!table || !window.fetch) return;
  const works = (s) => {
    if (s.compat === 'incompatible') return ['Blocks webAC', 'no'];
    if (s.online === false) return ['Offline now', 'warn'];
    if (s.registration) return [s.compat === 'beta' ? 'Register first (beta)' : 'Register first', 'warn'];
    return [s.compat === 'beta' ? 'Yes (beta)' : 'Yes', 'yes'];
  };
  const about = (n) => (n == null ? null : n < 50 ? n : Math.round(n / 10) * 10);
  fetch('https://bridge.playwebac.com/servers', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((feed) => {
      const byId = new Map(feed.servers.map((s) => [s.id, s]));
      for (const row of table.querySelectorAll('tr[data-world]')) {
        const s = byId.get(row.dataset.world);
        if (!s) continue;
        const pop = row.querySelector('[data-live="pop"]');
        const n = about(s.population);
        pop.textContent = n == null ? '–' : String(n);
        pop.classList.toggle('none', n == null);
        const cell = row.querySelector('[data-live="works"]');
        const [text, cls] = works(s);
        cell.textContent = text;
        cell.className = `works ${cls}`;
      }
      const stamp = document.querySelector('.updated time');
      if (stamp && feed.updatedAt) {
        stamp.dateTime = feed.updatedAt;
        stamp.textContent = `${new Date(feed.updatedAt).toISOString().slice(11, 16)} UTC (live)`;
      }
    })
    .catch(() => {});
})();
