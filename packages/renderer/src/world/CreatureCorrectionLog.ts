/**
 * BUG.ac1999-monster-jitter — a diagnostic line for a creature the server corrects far from where our
 * copy got to. A creature chase runs on both sides (the client simulates the MoveTo; the AC1999 server
 * corrects it with an 0xF748 every 0.2 s while it is mid-moveto), so a creature that jumps back and
 * forth is one of two things, and the line tells them apart:
 *  - the server's copy is held (pathing blocked, a face it cannot climb) while ours runs on: the
 *    `server=` positions stay put while `client=` runs ahead by the same distance each time;
 *  - the server's copy itself goes back and forth: the `server=` positions alternate.
 * The agent daemon keeps `[AC:Move]` lines in its log (tools/ac-agent/daemon.ts pageLogLine).
 */

/** A correction at least this far (m, horizontal) from our copy is reported. */
export const CORRECTION_REPORT_METRES = 1;
/** At most one line per object this often (ms). */
export const CORRECTION_REPORT_INTERVAL_MS = 1000;

export interface CorrectionSample {
  guid: number;
  name: string;
  /** The position's cell. */
  cell: number;
  /** The server's position and our copy's, AC global metres (x east, y north, z up). */
  server: { x: number; y: number; z: number };
  client: { x: number; y: number; z: number };
  movingTo: boolean;
  sliding: boolean;
  contact: boolean;
  /** What the body did with it (RemotePhysicsObject.receivePosition). */
  result: string;
}

const f1 = (v: number): string => v.toFixed(1);

/** The line for one correction, or null when it is not worth reporting. */
export function correctionLine(s: CorrectionSample): string | null {
  const d = Math.hypot(s.server.x - s.client.x, s.server.y - s.client.y);
  if (d < CORRECTION_REPORT_METRES) return null;
  return `[AC:Move] correction 0x${(s.guid >>> 0).toString(16)} "${s.name}" ${d.toFixed(2)} m: `
    + `server=(${f1(s.server.x)}, ${f1(s.server.y)}, ${f1(s.server.z)}) cell 0x${(s.cell >>> 0).toString(16)} `
    + `client=(${f1(s.client.x)}, ${f1(s.client.y)}, ${f1(s.client.z)}) `
    + `movingTo=${s.movingTo ? 1 : 0} sliding=${s.sliding ? 1 : 0} contact=${s.contact ? 1 : 0} ${s.result}`;
}

/** Throttles the lines per object. */
export class CreatureCorrectionLog {
  private readonly last = new Map<number, number>();

  constructor(private readonly emit: (line: string) => void = (l) => console.log(l)) {}

  report(s: CorrectionSample, now: number): void {
    const line = correctionLine(s);
    if (!line) return;
    const g = s.guid >>> 0;
    const prev = this.last.get(g);
    if (prev !== undefined && now - prev < CORRECTION_REPORT_INTERVAL_MS) return;
    this.last.set(g, now);
    if (this.last.size > 512) this.last.delete(this.last.keys().next().value!);
    this.emit(line);
  }
}
