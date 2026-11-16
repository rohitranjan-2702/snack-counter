import { DAY, localParts } from "./time.js";
import type { Employee, OfficeConfig, Refill } from "./types.js";

const FAIRNESS_WINDOW = 90 * DAY;

const within = (t: number, r: { from: number; to: number }) => t >= r.from && t < r.to;

/** Is this person physically at `office` at time t? (hybrid pattern, holidays, visits) */
export function isAtOffice(e: Employee, office: OfficeConfig, t: number): boolean {
  if (e.absences.some((r) => within(t, r))) return false;
  const visit = e.visits.find((v) => within(t, v));
  if (visit) return visit.office === office.id;
  return e.homeOffice === office.id && e.officeWeekdays.includes(localParts(t, office.timeZone).weekday);
}

/**
 * Picks the next buyer for an office.
 * Eligible: volunteer, at the office at `availableAt` (the next working moment), not already tried for this refill.
 * Order (fair share first):
 *   1. fewest unreimbursed purchases (don't pile on people still waiting for money)
 *   2. fewest offers in last 90 days  (declining still uses up your turn)
 *   3. longest since last offer
 *   4. id                             (deterministic)
 */
export function chooseBuyer(
  office: OfficeConfig,
  employees: readonly Employee[],
  refills: readonly Refill[],
  exclude: readonly string[],
  availableAt: number,
  now: number,
): Employee | null {
  const stat = (id: string) => {
    let pending = 0;
    let recent = 0;
    let last = -Infinity;
    for (const r of refills) {
      if (r.purchase?.buyer === id && ["AWAITING_ADMIN", "PURCHASED", "CLAIM_SUBMITTED"].includes(r.status)) pending++;
      for (const a of r.attempts) {
        if (a.employeeId !== id) continue;
        if (now - a.offeredAt <= FAIRNESS_WINDOW) recent++;
        last = Math.max(last, a.offeredAt);
      }
    }
    return { pending, recent, last };
  };

  const candidates = employees
    .filter((e) => e.isVolunteer && !exclude.includes(e.id) && isAtOffice(e, office, availableAt))
    .map((e) => ({ e, s: stat(e.id) }));

  candidates.sort(
    (a, b) =>
      a.s.pending - b.s.pending ||
      a.s.recent - b.s.recent ||
      a.s.last - b.s.last ||
      a.e.id.localeCompare(b.e.id),
  );
  return candidates[0]?.e ?? null;
}
