/**
 * LinkStatusAverages — the retail client's packet-loss figure for the
 * Link Status panel (gmLinkStatusUI, "Packet loss for the last 10 sec: N%").
 *
 * Port of the decompiled EoL client (reference/client-eol, build ac1_sep13):
 *
 *  - `ClientNet::AddToPerfCounter @ 00542880` accumulates the current
 *    CLinkStatusSnapshot: PacketsSentCounter (9) → nPktsSent,
 *    RetransmitsSentCounter (10) → nPktsRetransmitted, the three
 *    *PacketsReceivedCounter (3/4/5) → nPktsReceived, AcksReceivedCounter
 *    (6) → nPktsNAKed.
 *      · SharedNet::SendPacket @ 00541ba0 adds (9, 1) for every packet sent
 *        — retransmissions included.
 *      · FlowQueue::TransmitAcks @ 005485b0 (resending the packets the
 *        server NAKed) adds (10, count resent).
 *      · SharedNet::SplitPacketData @ 00542e30 adds (3|4|5, 1) for every
 *        checksum-valid packet received.
 *      · Nothing in the EoL binary feeds counter 6 (no `push 6; call [vtbl]`
 *        site exists), so nPktsNAKed stays 0 in retail as well.
 *  - `ClientNet::ProcessConnection @ 00545450` (cs_Connected) takes a
 *    heartbeat once 2.0 s have passed since the last one: the snapshot goes
 *    to `CLinkStatusAverages::AddSnapshot @ 00546650` and is then zeroed.
 *  - AddSnapshot pushes each count into a `CAverager<unsigned short, 40>`
 *    (@ 005464b0) — a 40-sample ring that keeps a running total.
 *  - `CLinkStatusAverages::GetAveragePacketLoss @ 00546610`:
 *      total = received + sent; total <= 0 → 0;
 *      else (NAKed + retransmitted) / total, doubled (`fadd st0, st0`).
 *    LinkStatusHolder::OnHeartbeat @ 004113d0 stores it (as a float) for
 *    `LinkStatusHolder::GetPacketLossPercentage @ 00411370`. The value is
 *    this doubled RATIO — retail never multiplies it by 100 before the
 *    panel prints it followed by "%".
 */

/** ClientNet::ProcessConnection: heartbeat when local_time − last ≥ 2.0 s. */
export const LINK_STATUS_HEARTBEAT_MS = 2000;

/** CAverager<unsigned short, 40> — samples kept per counter. */
export const LINK_STATUS_AVERAGER_SAMPLES = 40;

/** One CLinkStatusSnapshot's packet counters (per heartbeat). */
export interface LinkStatusSnapshot {
  nPktsSent: number;
  nPktsRetransmitted: number;
  nPktsReceived: number;
  nPktsNAKed: number;
}

/** CAverager<unsigned short, N>::AddSample @ 005464b0 — a ring with a running total. */
class UShortAverager {
  private readonly samples: number[] = [];
  private idxFirst = 0;
  curTotal = 0;

  constructor(private readonly capacity: number) {}

  addSample(value: number): void {
    const v = value & 0xffff; // ushort sample
    if (this.samples.length === this.capacity) {
      this.curTotal -= this.samples[this.idxFirst];
      this.samples[this.idxFirst] = v;
      this.idxFirst = (this.idxFirst + 1) % this.capacity;
    } else {
      this.samples.push(v);
    }
    this.curTotal += v;
  }
}

export class LinkStatusAverages {
  private readonly sent = new UShortAverager(LINK_STATUS_AVERAGER_SAMPLES);
  private readonly retransmitted = new UShortAverager(LINK_STATUS_AVERAGER_SAMPLES);
  private readonly received = new UShortAverager(LINK_STATUS_AVERAGER_SAMPLES);
  private readonly naked = new UShortAverager(LINK_STATUS_AVERAGER_SAMPLES);

  /** The snapshot being accumulated since the last heartbeat (m_CurrentLinkStatus). */
  private current: LinkStatusSnapshot = LinkStatusAverages.emptySnapshot();
  private lastHeartbeatAt: number | null = null;
  /** LinkStatusHolder::m_fPacketLoss — refreshed on each heartbeat. */
  private packetLoss = 0;

  private static emptySnapshot(): LinkStatusSnapshot {
    return { nPktsSent: 0, nPktsRetransmitted: 0, nPktsReceived: 0, nPktsNAKed: 0 };
  }

  /** PacketsSentCounter (9): one packet went out (retransmissions included). */
  countSent(n: number = 1): void { this.current.nPktsSent += n; }
  /** RetransmitsSentCounter (10): packets resent for the server's NAK. */
  countRetransmitted(n: number = 1): void { this.current.nPktsRetransmitted += n; }
  /** *PacketsReceivedCounter (3/4/5): one packet arrived. */
  countReceived(n: number = 1): void { this.current.nPktsReceived += n; }

  /** CLinkStatusAverages::AddSnapshot @ 00546650 (packet-count averagers). */
  addSnapshot(s: LinkStatusSnapshot): void {
    this.sent.addSample(s.nPktsSent);
    this.retransmitted.addSample(s.nPktsRetransmitted);
    this.received.addSample(s.nPktsReceived);
    this.naked.addSample(s.nPktsNAKed);
  }

  /** CLinkStatusAverages::GetAveragePacketLoss @ 00546610. */
  getAveragePacketLoss(): number {
    const total = this.received.curTotal + this.sent.curTotal;
    if (total <= 0) return 0;
    const ratio = (this.naked.curTotal + this.retransmitted.curTotal) / total;
    return ratio + ratio;
  }

  /**
   * The cs_Connected heartbeat check of ClientNet::ProcessConnection: once
   * 2 s have passed since the last heartbeat, fold the current snapshot
   * into the averagers, zero it, and refresh the LinkStatusHolder value
   * (OnHeartbeat). The first call only arms the clock (retail's
   * localtimeLastHeartbeat_ starts at connection time). Returns true when a
   * heartbeat was taken.
   */
  heartbeat(nowMs: number): boolean {
    if (this.lastHeartbeatAt === null) { this.lastHeartbeatAt = nowMs; return false; }
    if (nowMs - this.lastHeartbeatAt < LINK_STATUS_HEARTBEAT_MS) return false;
    this.lastHeartbeatAt = nowMs;
    this.addSnapshot(this.current);
    this.current = LinkStatusAverages.emptySnapshot();
    this.packetLoss = Math.fround(this.getAveragePacketLoss());
    return true;
  }

  /** LinkStatusHolder::GetPacketLossPercentage @ 00411370 (as of the last heartbeat). */
  getPacketLossPercentage(): number {
    return this.packetLoss;
  }
}
