import type { Currency, OfficeId } from "./types.js";

/** Chat tool (outbound only; inbound is handled by calling service methods). */
export interface ChatPort {
  sendDirect(employeeId: string, text: string): void;
  sendToOffice(office: OfficeId, text: string): void;
}

export type HrClaimStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface HrClaimRequest {
  /** Our refill id; HR must treat repeats as the same claim (retry safety). */
  idempotencyKey: string;
  employeeId: string;
  amount: number; // minor units
  currency: Currency; // currency of the receipt; HR pays out in payroll currency
  description: string;
  receiptRef: string;
}

export interface HrPort {
  createClaim(req: HrClaimRequest): { claimId: string };
  getClaimStatus(claimId: string): HrClaimStatus;
}
