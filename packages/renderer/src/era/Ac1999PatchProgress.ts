/**
 * BUG.ac1999-slow-login-ddd-push — the line under the connecting screen's
 * Please Wait while an AC1999 server pushes its DAT patches at login.
 *
 * An AC1999 server serves its own patched portal.dat / cell.dat and sends a
 * client at any other iteration the whole difference before the character
 * list (Client.cpp CClient::UpdateLoginScreen → PlanDatSync → SendDatFile),
 * paced at max_bytes_per_tick (4000 bytes a 33 ms window, PacketController.cpp
 * FlushFragments). A browser with none of that server's patches stored (its
 * first 1999 login) waits 10-15 s on the connecting screen for ~700 KB, with
 * nothing said. The 1999 client drew the push's progress on its loading
 * screen (LoadingScreen_Tick @ 0x57a3d0: bytesDone / totalBytes); this shows
 * the same fraction in gmDataPatchUI's own words (PatchStatus: "Patching
 * data...", "<n>% of <total>K complete...", "Patching Done!").
 *
 * Only Connection1999 emits the events, and only when the server has files to
 * send, so an up-to-date 1999 login and every other era show nothing new.
 */
import type { DatPatchProgressEvent } from '@ac/network';
import { PatchStatus } from '../ui/PatchScreen.js';

export class Ac1999PatchProgress {
  private status: PatchStatus | null = null;
  private counted = 0;

  /** The status line for a progress event, or null when there is nothing to say. */
  onProgress(e: Pick<DatPatchProgressEvent, 'files' | 'filesDone' | 'bytes' | 'bytesDone'>): string | null {
    if (e.files <= 0) return null;
    // A begin (nothing received yet) starts a push: a new session's, or the first.
    if (!this.status || (e.filesDone === 0 && e.bytesDone === 0)) {
      this.status = new PatchStatus();
      this.counted = 0;
      this.status.onEvent({ kind: 'begin', expected: e.bytes });
    }
    if (e.bytesDone > this.counted) {
      this.status.onEvent({ kind: 'downloaded', bytes: e.bytesDone - this.counted });
      this.counted = e.bytesDone;
    }
    return this.status.label.text;
  }

  /** The push finished (the `datPatch1999` event): "Patching Done!", or null when no push ran. */
  onFinished(): string | null {
    if (!this.status) return null;
    const text = this.status.onEvent({ kind: 'end' })?.text ?? null;
    this.status = null;
    this.counted = 0;
    return text;
  }
}
