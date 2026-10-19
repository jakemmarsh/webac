export const REPORT_PATH: string;
export const MAX_REPORT_BYTES: number;
export function validateReport(body: unknown): Record<string, unknown> | null;
declare const worker: {
  fetch(request: Request, env: { ASSETS: { fetch(request: Request): Promise<Response> | Response } }): Promise<Response>;
};
export default worker;
