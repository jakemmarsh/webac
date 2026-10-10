/**
 * VirindiTank's meta views (its wiki's Meta_Views page): the XML a meta's
 * Create View action carries. A view has a width, height and title; it holds
 * `layout` and `button` controls, each with left / top / width / height /
 * name; a button has text, an actionexpr (a meta expression) and a setstate.
 * Parsed with a small tag reader so it runs the same in the browser and Node.
 */
export interface MetaViewButton { name: string; left: number; top: number; width: number; height: number; text: string; actionexpr?: string; setstate?: string }
export interface MetaView { title: string; width: number; height: number; buttons: MetaViewButton[] }

const attrs = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_][\w-]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1].toLowerCase()] = (m[3] ?? m[4] ?? '').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return out;
};
const num = (v: string | undefined, d: number): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/** The view, or null when the XML has no <view>. */
export function parseMetaView(xml: string): MetaView | null {
  const view = /<view\b([^>]*)>/i.exec(xml);
  if (!view) return null;
  const va = attrs(view[1]);
  const buttons: MetaViewButton[] = [];
  for (const m of xml.matchAll(/<control\b([^>]*?)\/?>/gi)) {
    const a = attrs(m[1]);
    if ((a.type ?? '').toLowerCase() !== 'button') continue;
    buttons.push({
      name: a.name ?? '', left: num(a.left, 0), top: num(a.top, 0), width: num(a.width, 60), height: num(a.height, 20), text: a.text ?? '',
      ...(a.actionexpr ? { actionexpr: a.actionexpr } : {}), ...(a.setstate ? { setstate: a.setstate } : {}),
    });
  }
  return { title: va.title ?? '', width: num(va.width, 300), height: num(va.height, 200), buttons };
}
