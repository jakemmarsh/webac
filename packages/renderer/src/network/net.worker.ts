/// <reference lib="webworker" />
/**
 * RELEASE.gdle-30s-idle-drop — the worker that hosts the session connection
 * (@ac/network NetWorker.ts hostClientConnection; page side: NetWorkerClient).
 */
import { hostClientConnection, type NetPort } from '@ac/network';

hostClientConnection(self as unknown as NetPort);
