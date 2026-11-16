import type { ChatPort, HrClaimRequest, HrClaimStatus, HrPort } from "./ports.js";
import type { Clock, OfficeId } from "./types.js";

export class FakeClock implements Clock {
  constructor(private t: number) {}
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
  set(t: number) {
    this.t = t;
  }
}

export class FakeChat implements ChatPort {
  direct: { to: string; text: string }[] = [];
  office: { office: OfficeId; text: string }[] = [];
  sendDirect(to: string, text: string) {
    this.direct.push({ to, text });
  }
  sendToOffice(office: OfficeId, text: string) {
    this.office.push({ office, text });
  }
  directTo(id: string) {
    return this.direct.filter((m) => m.to === id);
  }
}

export class FakeHr implements HrPort {
  claims = new Map<string, { req: HrClaimRequest; status: HrClaimStatus }>();
  private byKey = new Map<string, string>();
  private seq = 0;
  /** Test helper: number of upcoming createClaim calls that fail (HR outage). */
  failNext = 0;

  createClaim(req: HrClaimRequest) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("HR unavailable");
    }
    const existing = this.byKey.get(req.idempotencyKey);
    if (existing) return { claimId: existing };
    const claimId = `hr-${++this.seq}`;
    this.claims.set(claimId, { req, status: "PENDING" });
    this.byKey.set(req.idempotencyKey, claimId);
    return { claimId };
  }
  getClaimStatus(claimId: string) {
    const c = this.claims.get(claimId);
    if (!c) throw new Error(`unknown claim ${claimId}`);
    return c.status;
  }
  /** Test helper: simulates HR's 1-10 day approval. */
  setStatus(claimId: string, status: HrClaimStatus) {
    const c = this.claims.get(claimId);
    if (c) c.status = status;
  }
}
