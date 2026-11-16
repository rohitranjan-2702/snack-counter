import type { ChatPort, HrPort } from "./ports.js";
import { chooseBuyer } from "./selection.js";
import { DAY, HOUR, addWorkingTime, monthKey, nextWorkingStart } from "./time.js";
import {
  DomainError,
  type AttemptOutcome,
  type Clock,
  type Currency,
  type Employee,
  type OfficeConfig,
  type OfficeId,
  type Refill,
  type RefillStatus,
} from "./types.js";

export interface Options {
  /** Working time an offered volunteer has to accept or decline. */
  acceptWindowMs: number;
  /** Working time an accepted volunteer has to buy and submit the receipt. */
  buyWindowMs: number;
  /** Working time to answer "did you buy?" before the refill is handed on. */
  confirmWindowMs: number;
  /** Reminder is sent this much working time before the buy deadline. */
  reminderLeadMs: number;
  /** Calendar time after which a pending HR claim is chased (HR says 1-10 days). */
  hrChaseAfterMs: number;
}

export const DEFAULT_OPTIONS: Options = {
  acceptWindowMs: 2 * HOUR,
  buyWindowMs: 8 * HOUR, // one working day
  confirmWindowMs: 2 * HOUR,
  reminderLeadMs: 2 * HOUR,
  hrChaseAfterMs: 10 * DAY,
};

export interface PurchaseInput {
  amount: number; // minor units
  currency: Currency;
  receiptRef: string;
  items?: string[];
}

const ACTIVE: ReadonlySet<RefillStatus> = new Set(["OPEN", "OFFERED", "ACCEPTED", "CONFIRMING"]);
const HELD: ReadonlySet<RefillStatus> = new Set(["OFFERED", "ACCEPTED", "CONFIRMING"]);
export const COUNTS_AS_SPEND: ReadonlySet<RefillStatus> = new Set(["PURCHASED", "CLAIM_SUBMITTED", "APPROVED"]);

export const formatMoney = (amount: number, currency: Currency) => `${(amount / 100).toFixed(2)} ${currency}`;

/** Deadline in the office's local time, e.g. "Tue 17 Nov 12:00 (Europe/Oslo)". */
export const formatLocal = (t: number, office: OfficeConfig) =>
  `${new Date(t).toLocaleString("en-GB", {
    timeZone: office.timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  }).replace(",", "")} (${office.timeZone})`;

export class RefillService {
  private refills: Refill[] = [];
  private seq = 0;
  private readonly opts: Options;

  constructor(
    private readonly offices: Record<OfficeId, OfficeConfig>,
    private readonly employees: readonly Employee[],
    private readonly chat: ChatPort,
    private readonly hr: HrPort,
    private readonly clock: Clock,
    opts: Partial<Options> = {},
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  // ---- queries -----------------------------------------------------------

  getRefill(id: string): Refill {
    const r = this.refills.find((x) => x.id === id);
    if (!r) throw new DomainError("REFILL_NOT_FOUND", `no refill ${id}`);
    return r;
  }

  allRefills(): readonly Refill[] {
    return this.refills;
  }

  /** Refills whose purchase counts as spend in `month` ("YYYY-MM", office-local). */
  purchasesIn(office: OfficeId, month: string): Refill[] {
    const tz = this.offices[office].timeZone;
    return this.refills.filter(
      (r) =>
        r.office === office &&
        r.purchase !== undefined &&
        COUNTS_AS_SPEND.has(r.status) &&
        monthKey(r.purchase.purchasedAt, tz) === month,
    );
  }

  spent(office: OfficeId, month: string): number {
    return this.purchasesIn(office, month).reduce((sum, r) => sum + r.purchase!.amount, 0);
  }

  // ---- lifecycle ---------------------------------------------------------

  /** Someone reports the box empty. Idempotent: at most one active refill per office. */
  reportEmpty(office: OfficeId, info: { reportedBy?: string; ranOut?: string[] } = {}): Refill {
    const existing = this.refills.find((r) => r.office === office && ACTIVE.has(r.status));
    if (existing) {
      existing.ranOut.push(...(info.ranOut ?? []));
      return existing;
    }
    const refill: Refill = {
      id: `refill-${++this.seq}`,
      office,
      status: "OPEN",
      createdAt: this.clock.now(),
      ranOut: [...(info.ranOut ?? [])],
      attempts: [],
      ...(info.reportedBy ? { reportedBy: info.reportedBy } : {}),
    };
    this.refills.push(refill);
    this.offerNext(refill);
    return refill;
  }

  /** Offered volunteer commits to buying. */
  accept(refillId: string, employeeId: string): Refill {
    const r = this.requireHolder(refillId, employeeId, ["OFFERED"]);
    this.startBuying(r);
    return r;
  }

  /** Anyone may take an OPEN refill (e.g. after the "no volunteer available" ping). First one wins. */
  volunteer(refillId: string, employeeId: string): Refill {
    const r = this.getRefill(refillId);
    this.employee(employeeId);
    if (HELD.has(r.status)) throw new DomainError("ALREADY_TAKEN", `${r.id} is held by someone else`);
    if (r.status !== "OPEN") throw new DomainError("WRONG_STATE", `${r.id} is ${r.status}`);
    const cap = this.computeCap(r.office);
    if (cap === null) throw new DomainError("OVER_BUDGET", `${r.office} budget is used up this month`);
    r.cap = cap;
    r.assignee = employeeId;
    delete r.waitingReason;
    r.attempts.push({ employeeId, offeredAt: this.clock.now() });
    this.startBuying(r);
    return r;
  }

  /** Holder gives the job back (e.g. sick); passes immediately to the next person. */
  decline(refillId: string, employeeId: string): Refill {
    const r = this.requireHolder(refillId, employeeId, [...HELD]);
    this.chat.sendDirect(employeeId, `Thanks, passing ${r.id} to someone else.`);
    this.release(r, "DECLINED");
    this.offerNext(r);
    return r;
  }

  /** Answer to "did you buy?": no. Hands on immediately instead of waiting for the window. */
  confirmNotBought(refillId: string, employeeId: string): Refill {
    const r = this.requireHolder(refillId, employeeId, ["CONFIRMING"]);
    this.release(r, "NOT_BOUGHT");
    this.offerNext(r);
    return r;
  }

  /**
   * Receipt submission. Allowed for the current holder, and for a *previous* holder as long as
   * nobody has bought yet (late receipt after a hand-off); the current holder is then told to stand down.
   */
  submitPurchase(refillId: string, employeeId: string, input: PurchaseInput): Refill {
    const r = this.getRefill(refillId);
    this.employee(employeeId);
    const office = this.offices[r.office];

    if (!ACTIVE.has(r.status)) {
      if (r.purchase && r.purchase.buyer !== employeeId) {
        this.chat.sendDirect(
          office.adminId,
          `${employeeId} also bought snacks for ${r.id}, already bought by ${r.purchase.buyer}. Please sort out reimbursement manually.`,
        );
        throw new DomainError("ALREADY_PURCHASED", `${r.id} was already bought by someone else`);
      }
      throw new DomainError("WRONG_STATE", `${r.id} is ${r.status}`);
    }
    const isHolder = HELD.has(r.status) && r.assignee === employeeId;
    const isPrevious = !isHolder && r.attempts.some((a) => a.employeeId === employeeId);
    if (!isHolder && !isPrevious) throw new DomainError("NOT_ASSIGNEE", `${r.id} is not yours`);

    validatePurchase(input, office);
    const now = this.clock.now();
    const cap = r.cap ?? this.computeCap(r.office) ?? 0;
    const fitsBudget = this.spent(r.office, monthKey(now, office.timeZone)) + input.amount <= office.monthlyBudget;

    // The snacks are bought either way: record the purchase and stop all hand-offs first.
    if (isPrevious && r.assignee) {
      this.chat.sendDirect(r.assignee, `No need to buy for ${r.id}: ${employeeId} already did. Thanks!`);
      this.release(r, "STOOD_DOWN");
    }
    this.closeAttempt(r, employeeId, "BOUGHT");
    this.clearHold(r);
    delete r.waitingReason;
    r.status = "PURCHASED";
    r.purchase = {
      amount: input.amount,
      currency: input.currency,
      buyer: employeeId,
      purchasedAt: now,
      receiptRef: input.receiptRef,
      items: [...(input.items ?? [])],
    };

    if (input.amount > cap || !fitsBudget) {
      // Over the agreed limit: nothing goes to HR until the budget owner decides.
      r.status = "AWAITING_ADMIN";
      const msg = `Receipt for ${r.id} is ${formatMoney(input.amount, input.currency)}, above the agreed limit of ${formatMoney(cap, office.currency)}.`;
      this.chat.sendDirect(employeeId, `${msg} Saved; the budget owner will decide on reimbursement.`);
      this.chat.sendDirect(office.adminId, `${msg} Bought by ${employeeId}; please approve or reject.`);
      return r;
    }
    this.trySubmitClaim(r);
    return r;
  }

  /**
   * Budget owner decides on an over-cap receipt. Approving may exceed the per-purchase cap but
   * never the monthly budget (hard limit); an over-budget receipt can only be rejected here.
   */
  adminResolve(refillId: string, adminId: string, decision: "APPROVE" | "REJECT"): Refill {
    const r = this.getRefill(refillId);
    const office = this.offices[r.office];
    if (adminId !== office.adminId) throw new DomainError("NOT_ADMIN", `${adminId} is not the ${r.office} budget owner`);
    if (r.status !== "AWAITING_ADMIN") throw new DomainError("WRONG_STATE", `${r.id} is ${r.status}`);
    const p = r.purchase!;
    if (decision === "REJECT") {
      r.status = "REJECTED_BY_ADMIN";
      this.chat.sendDirect(p.buyer, `The budget owner did not approve the claim for ${r.id}; they will contact you.`);
      return r;
    }
    const month = monthKey(p.purchasedAt, office.timeZone);
    if (this.spent(r.office, month) + p.amount > office.monthlyBudget) {
      throw new DomainError("OVER_BUDGET", `${r.office} budget for ${month} would be exceeded`);
    }
    r.status = "PURCHASED";
    this.trySubmitClaim(r);
    return r;
  }

  /** Periodic job (e.g. every 5 minutes): deadlines, reminders, retries, HR sync. */
  tick(): void {
    const now = this.clock.now();
    for (const r of this.refills) {
      switch (r.status) {
        case "OFFERED":
          if (r.deadline! <= now) {
            this.chat.sendDirect(r.assignee!, `No answer on ${r.id}; offering it to someone else.`);
            this.release(r, "OFFER_EXPIRED");
            this.offerNext(r);
          }
          break;
        case "ACCEPTED":
          if (r.deadline! <= now) {
            r.status = "CONFIRMING";
            r.deadline = addWorkingTime(now, this.opts.confirmWindowMs, this.offices[r.office]);
            this.chat.sendDirect(
              r.assignee!,
              `Did you buy snacks for ${r.id}? Submit the receipt, or answer "no" and it goes to someone else.`,
            );
          } else if (!r.reminded && r.reminderAt! <= now) {
            r.reminded = true;
            this.chat.sendDirect(r.assignee!, `Reminder: ${r.id} is due ${formatLocal(r.deadline!, this.offices[r.office])}.`);
          }
          break;
        case "CONFIRMING":
          if (r.deadline! <= now) {
            this.chat.sendDirect(r.assignee!, `No answer on ${r.id}; passed on. If you did buy, you can still submit the receipt.`);
            this.release(r, "NO_RESPONSE");
            this.offerNext(r);
          }
          break;
        case "OPEN":
          this.offerNext(r); // someone may be available now, or a new month has budget
          break;
        case "PURCHASED":
          this.trySubmitClaim(r);
          break;
        case "CLAIM_SUBMITTED":
          this.syncClaim(r, now);
          break;
        default:
          break;
      }
    }
  }

  // ---- internals ---------------------------------------------------------

  /** Largest amount this office can still commit this month, or null if below a typical purchase. */
  private computeCap(officeId: OfficeId): number | null {
    const office = this.offices[officeId];
    const remaining = office.monthlyBudget - this.spent(officeId, monthKey(this.clock.now(), office.timeZone));
    const cap = Math.min(office.typicalPurchase.max, remaining);
    return cap >= office.typicalPurchase.min ? cap : null;
  }

  private offerNext(r: Refill): void {
    const office = this.offices[r.office];
    const now = this.clock.now();
    const cap = this.computeCap(r.office);
    if (cap === null) return this.wait(r, "BUDGET");

    const tried = r.attempts.map((a) => a.employeeId);
    const buyer = chooseBuyer(office, this.employees, this.refills, tried, nextWorkingStart(now, office), now);
    if (!buyer) return this.wait(r, "NO_VOLUNTEER");

    r.status = "OFFERED";
    r.assignee = buyer.id;
    r.cap = cap;
    r.deadline = addWorkingTime(now, this.opts.acceptWindowMs, office);
    delete r.waitingReason;
    r.attempts.push({ employeeId: buyer.id, offeredAt: now });
    this.chat.sendDirect(
      buyer.id,
      `You're up to refill the ${r.office} snack box (${r.id}). Spend up to ${formatMoney(cap, office.currency)}. ` +
        `Please accept or decline by ${formatLocal(r.deadline, office)}.`,
    );
  }

  private startBuying(r: Refill): void {
    const office = this.offices[r.office];
    const now = this.clock.now();
    r.status = "ACCEPTED";
    r.deadline = addWorkingTime(now, this.opts.buyWindowMs, office);
    r.reminderAt = addWorkingTime(now, Math.max(0, this.opts.buyWindowMs - this.opts.reminderLeadMs), office);
    r.reminded = false;
    this.chat.sendDirect(
      r.assignee!,
      `Thanks! Please buy (max ${formatMoney(r.cap!, office.currency)}) and submit the receipt by ${formatLocal(r.deadline, office)}.`,
    );
  }

  /** Nothing can be offered right now. Notifies only when the reason changes (no spam every tick). */
  private wait(r: Refill, reason: "NO_VOLUNTEER" | "BUDGET"): void {
    this.clearHold(r);
    r.status = "OPEN";
    if (r.waitingReason === reason) return;
    r.waitingReason = reason;
    const office = this.offices[r.office];
    if (reason === "BUDGET") {
      const month = monthKey(this.clock.now(), office.timeZone);
      this.chat.sendDirect(office.adminId, `${r.office} snack budget for ${month} is used up; ${r.id} waits for next month or your decision.`);
      this.chat.sendToOffice(r.office, `Snack box is empty but this month's budget is used up (${r.id}).`);
    } else {
      this.chat.sendToOffice(r.office, `Snack box empty and no volunteer available (${r.id}). Can anyone take it?`);
    }
  }

  private release(r: Refill, outcome: AttemptOutcome): void {
    if (r.assignee) this.closeAttempt(r, r.assignee, outcome);
    this.clearHold(r);
    r.status = "OPEN";
  }

  private clearHold(r: Refill): void {
    delete r.assignee;
    delete r.deadline;
    delete r.reminderAt;
    delete r.reminded;
  }

  private closeAttempt(r: Refill, employeeId: string, outcome: AttemptOutcome): void {
    const attempt = [...r.attempts].reverse().find((a) => a.employeeId === employeeId);
    if (attempt) attempt.outcome = outcome;
  }

  /** Safe to call repeatedly: the refill id is HR's idempotency key. */
  private trySubmitClaim(r: Refill): void {
    const p = r.purchase!;
    try {
      const { claimId } = this.hr.createClaim({
        idempotencyKey: r.id,
        employeeId: p.buyer,
        amount: p.amount,
        currency: p.currency, // receipt currency; HR pays out in the employee's payroll currency (assumption)
        description: `Snacks for ${r.office} counter (${r.id})`,
        receiptRef: p.receiptRef,
      });
      r.hrClaimId = claimId;
      r.claimSubmittedAt = this.clock.now();
      r.status = "CLAIM_SUBMITTED";
      this.chat.sendDirect(p.buyer, `Claim submitted to HR for ${r.id}. Thank you!`);
    } catch {
      if (!r.hrRetryNotified) {
        r.hrRetryNotified = true;
        this.chat.sendDirect(p.buyer, `Receipt for ${r.id} saved. HR is unreachable right now; we'll retry automatically.`);
      }
    }
  }

  private syncClaim(r: Refill, now: number): void {
    let status;
    try {
      status = this.hr.getClaimStatus(r.hrClaimId!);
    } catch {
      return; // transient; next tick retries
    }
    const office = this.offices[r.office];
    const buyer = r.purchase!.buyer;
    if (status === "APPROVED") {
      r.status = "APPROVED";
      this.chat.sendDirect(buyer, `HR approved ${r.id}; payout follows with payroll.`);
    } else if (status === "REJECTED") {
      r.status = "CLAIM_REJECTED_BY_HR";
      this.chat.sendDirect(buyer, `HR rejected the claim for ${r.id}. The budget owner will follow up.`);
      this.chat.sendDirect(office.adminId, `HR rejected claim ${r.hrClaimId} for ${r.id} (${buyer}); please follow up.`);
    } else if (!r.chased && now - r.claimSubmittedAt! >= this.opts.hrChaseAfterMs) {
      r.chased = true;
      this.chat.sendDirect(office.adminId, `HR claim ${r.hrClaimId} for ${r.id} (${buyer}) has been pending over 10 days; please chase HR.`);
      this.chat.sendDirect(buyer, `Your claim for ${r.id} is taking long; the budget owner is chasing HR.`);
    }
  }

  private requireHolder(refillId: string, employeeId: string, states: RefillStatus[]): Refill {
    const r = this.getRefill(refillId);
    if (!states.includes(r.status)) throw new DomainError("WRONG_STATE", `${refillId} is ${r.status}`);
    if (r.assignee !== employeeId) throw new DomainError("NOT_ASSIGNEE", `${refillId} is held by someone else`);
    return r;
  }

  private employee(id: string): Employee {
    const e = this.employees.find((x) => x.id === id);
    if (!e) throw new DomainError("UNKNOWN_EMPLOYEE", id);
    return e;
  }
}

function validatePurchase(input: PurchaseInput, office: OfficeConfig): void {
  if (input.currency !== office.currency) {
    throw new DomainError("WRONG_CURRENCY", `${office.id} purchases are in ${office.currency}`);
  }
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new DomainError("INVALID_AMOUNT", `amount must be a positive whole number of minor units, got ${input.amount}`);
  }
  if (input.receiptRef.trim() === "") throw new DomainError("INVALID_RECEIPT", "a receipt image is required");
}
