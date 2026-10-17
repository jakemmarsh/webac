/**
 * Structured one-line JSON logs (RELEASE: public hosting). Every line is a
 * single JSON object — `{"t":"<iso>","level":"info","event":"session_close",...}`
 * — so CloudWatch (tools/aws-logs.sh) and any log shipper can filter on fields.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;
export type Logger = (level: LogLevel, event: string, fields?: LogFields) => void;

/** Serialize one log line. Errors become their message; bigint becomes a string. */
export function formatLogLine(level: LogLevel, event: string, fields: LogFields = {}, now: Date = new Date()): string {
  return JSON.stringify({ t: now.toISOString(), level, event, ...fields }, (_k, v) => {
    if (v instanceof Error) return v.message;
    if (typeof v === 'bigint') return v.toString();
    return v;
  });
}

/** The default logger: info/debug to stdout, warn/error to stderr. Debug lines
 *  only when `debug` is on (per-packet logging is real overhead). */
export function makeLogger(debug: boolean): Logger {
  return (level, event, fields) => {
    if (level === 'debug' && !debug) return;
    const line = formatLogLine(level, event, fields);
    if (level === 'warn' || level === 'error') console.error(line);
    else console.log(line);
  };
}

/** Wrap a logger so a given event logs at most once per intervalMs, adding a
 *  `suppressed` count of the calls swallowed since the last line. */
export function rateLimitedLog(log: Logger, intervalMs: number, now: () => number = Date.now): Logger {
  let last = -Infinity;
  let suppressed = 0;
  return (level, event, fields) => {
    const t = now();
    if (t - last >= intervalMs) {
      log(level, event, suppressed > 0 ? { ...fields, suppressed } : fields);
      last = t;
      suppressed = 0;
    } else {
      suppressed++;
    }
  };
}
