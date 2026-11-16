import type { RefillService } from "./service.js";
import { monthKey } from "./time.js";
import type { Currency, OfficeConfig, OfficeId } from "./types.js";

export interface OfficeLine {
  office: OfficeId;
  currency: Currency;
  budget: number;
  spent: number; // purchased + submitted + approved
  approved: number;
  awaitingHr: number;
  /** Bought over the cap, not yet decided by the budget owner; not counted in `spent`. */
  awaitingAdmin: number;
  remaining: number;
  refills: number;
  /** Snack feedback: how often each item was reported as running out first. */
  ranOut: Record<string, number>;
  /** What buyers said they bought. */
  itemsBought: Record<string, number>;
}

/** Caller-supplied FX: rates[c] = units of `currency` per 1 unit of c. Same minor-unit scale assumed (1/100). */
export interface FxSpec {
  currency: Currency;
  rates: Partial<Record<Currency, number>>;
}

export interface MonthlyReport {
  month: string;
  offices: OfficeLine[];
  totals: Partial<Record<Currency, number>>;
  combined?: { currency: Currency; amount: number; rates: Partial<Record<Currency, number>> };
}

const tally = (xs: string[]) => {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
};

const reportedInMonthBy = (svc: RefillService, o: OfficeConfig, month: string) =>
  svc.allRefills().filter((r) => r.office === o.id && r.purchase && monthKey(r.purchase.purchasedAt, o.timeZone) === month);

export function monthlyReport(
  svc: RefillService,
  offices: Record<OfficeId, OfficeConfig>,
  month: string,
  fx?: FxSpec,
): MonthlyReport {
  const lines: OfficeLine[] = Object.values(offices).map((o) => {
    const purchases = svc.purchasesIn(o.id, month);
    const sum = (pred: (s: string) => boolean) =>
      purchases.filter((r) => pred(r.status)).reduce((s, r) => s + r.purchase!.amount, 0);
    const spent = sum(() => true);
    const reported = svc.allRefills().filter((r) => r.office === o.id && monthKey(r.createdAt, o.timeZone) === month);
    return {
      office: o.id,
      currency: o.currency,
      budget: o.monthlyBudget,
      spent,
      approved: sum((s) => s === "APPROVED"),
      awaitingHr: sum((s) => s !== "APPROVED"),
      awaitingAdmin: reportedInMonthBy(svc, o, month)
        .filter((r) => r.status === "AWAITING_ADMIN")
        .reduce((s, r) => s + r.purchase!.amount, 0),
      remaining: o.monthlyBudget - spent,
      refills: purchases.length,
      ranOut: tally(reported.flatMap((r) => r.ranOut)),
      itemsBought: tally(purchases.flatMap((r) => r.purchase!.items)),
    };
  });

  const totals: Partial<Record<Currency, number>> = {};
  for (const l of lines) totals[l.currency] = (totals[l.currency] ?? 0) + l.spent;

  const report: MonthlyReport = { month, offices: lines, totals };
  if (fx) {
    let amount = 0;
    for (const [c, total] of Object.entries(totals) as [Currency, number][]) {
      const rate = c === fx.currency ? 1 : fx.rates[c];
      if (rate === undefined) throw new Error(`missing FX rate ${c} -> ${fx.currency}`);
      amount += total * rate;
    }
    report.combined = { currency: fx.currency, amount: Math.round(amount), rates: fx.rates };
  }
  return report;
}
