import type { WorkSchedule } from "./time.js";

export type OfficeId = "OSLO" | "BENGALURU";
export type Currency = "NOK" | "INR";

/** Money is always integer minor units (øre / paise) to avoid float errors. */
export interface Money {
  amount: number;
  currency: Currency;
}

export interface OfficeConfig extends WorkSchedule {
  id: OfficeId;
  currency: Currency;
  monthlyBudget: number; // minor units
  /** Typical purchase range; `max` is what gets reserved when a refill is offered. */
  typicalPurchase: { min: number; max: number };
  /** Budget owner; receives escalations. */
  adminId: string;
}

export interface DateRange {
  from: number; // epoch ms, inclusive
  to: number; // epoch ms, exclusive
}

export interface Employee {
  id: string;
  homeOffice: OfficeId;
  payrollCurrency: Currency;
  isVolunteer: boolean;
  /** Hybrid pattern: ISO weekdays (1 = Mon) this person is normally at their home office. */
  officeWeekdays: number[];
  /** Holiday / sick leave: not available to buy. */
  absences: DateRange[];
  /** Temporary stay at another office; counts as in-office there on working days. */
  visits: (DateRange & { office: OfficeId })[];
}

export type RefillStatus =
  | "OPEN" // box empty, nobody holds it (see waitingReason)
  | "OFFERED" // one volunteer asked; must accept within the accept window
  | "ACCEPTED" // committed; must buy within the buy window
  | "CONFIRMING" // buy window passed; asked "did you buy?" before handing off
  | "AWAITING_ADMIN" // bought, but over the cap/budget: no hand-offs, budget owner decides
  | "REJECTED_BY_ADMIN" // budget owner refused the over-cap receipt
  | "PURCHASED" // receipt recorded; HR has not yet accepted the claim (retried)
  | "CLAIM_SUBMITTED"
  | "APPROVED" // approved by HR; the payout itself happens in HR/payroll
  | "CLAIM_REJECTED_BY_HR";

export type AttemptOutcome =
  | "DECLINED"
  | "OFFER_EXPIRED"
  | "NOT_BOUGHT"
  | "NO_RESPONSE"
  | "STOOD_DOWN"
  | "BOUGHT";

export interface Attempt {
  employeeId: string;
  offeredAt: number;
  outcome?: AttemptOutcome;
}

export interface Purchase extends Money {
  buyer: string;
  purchasedAt: number;
  receiptRef: string;
  items: string[];
}

export interface Refill {
  id: string;
  office: OfficeId;
  status: RefillStatus;
  createdAt: number;
  reportedBy?: string;
  /** Snack feedback: what ran out first. */
  ranOut: string[];
  assignee?: string;
  deadline?: number;
  reminderAt?: number;
  reminded?: boolean;
  /** Spending limit told to the buyer; also the budget reservation while the refill is active. */
  cap?: number;
  waitingReason?: "NO_VOLUNTEER" | "BUDGET";
  /** Everyone who held this refill, in order. Nobody is offered the same refill twice. */
  attempts: Attempt[];
  purchase?: Purchase;
  hrClaimId?: string;
  claimSubmittedAt?: number;
  hrRetryNotified?: boolean;
  chased?: boolean;
}

export interface Clock {
  now(): number;
}

export type DomainErrorCode =
  | "NOT_ASSIGNEE"
  | "REFILL_NOT_FOUND"
  | "WRONG_STATE"
  | "ALREADY_TAKEN"
  | "ALREADY_PURCHASED"
  | "OVER_BUDGET"
  | "WRONG_CURRENCY"
  | "INVALID_AMOUNT"
  | "INVALID_RECEIPT"
  | "UNKNOWN_EMPLOYEE"
  | "NOT_ADMIN";

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
  }
}
