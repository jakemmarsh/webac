/**
 * BUG.locale-date-formatting-browser-dependent — pin timestamp display to a
 * fixed locale, matching retail's setlocale(0,"English") + strftime("%c").
 *
 * Retail (gmCharacterInfoUI::UpdatePlayerBirthAgeDeaths,
 * HouseSystem::ConvertTime — reference/client-eol/decomp/acclient-decompiled.c
 * :180129-180130, :429034-429038) pins the process locale once at client
 * init (:3067) and always renders the identical strftime("%c") string
 * regardless of the player's OS/browser language or region. A bare
 * `Date.toLocaleString()`/`toLocaleDateString()` instead follows the
 * browser's active Intl locale, so the same server timestamp renders
 * differently per player (e.g. MM/DD/YYYY in en-US vs DD.MM.YYYY in de-DE).
 *
 * VISUAL.house-tab-date-format — under the "English" (English_United States)
 * locale the MSVC CRT's %c is the locale's short date + long time,
 * "M/d/yyyy h:mm:ss tt": retail-ab world-house shows "10/12/2026 4:48:08 PM"
 * (the former weekday / month-name / 24-hour rendering was invented). Local
 * time, as strftime(localtime(...)).
 */
export function formatAcTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const h = d.getHours();
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${h % 12 === 0 ? 12 : h % 12}:${two(d.getMinutes())}:${two(d.getSeconds())} ${h < 12 ? 'AM' : 'PM'}`;
}
