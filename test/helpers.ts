import {
  FakeChat, FakeClock, FakeHr, RefillService, zonedTime,
  type DomainError, type Employee, type OfficeConfig, type OfficeId, type Options,
} from "../src/index.js";

export const WEEKDAYS = [1, 2, 3, 4, 5];

export const OFFICES: Record<OfficeId, OfficeConfig> = {
  OSLO: {
    id: "OSLO", currency: "NOK", monthlyBudget: 6_000_00, typicalPurchase: { min: 300_00, max: 1_200_00 },
    adminId: "admin-oslo", timeZone: "Europe/Oslo", startHour: 9, endHour: 17, workdays: WEEKDAYS,
  },
  BENGALURU: {
    id: "BENGALURU", currency: "INR", monthlyBudget: 15_000_00, typicalPurchase: { min: 500_00, max: 3_000_00 },
    adminId: "admin-blr", timeZone: "Asia/Kolkata", startHour: 9, endHour: 17, workdays: WEEKDAYS,
  },
};

/** Wall-clock time in Oslo (default Nov 2026). 2026-11-16 is a Monday. */
export const oslo = (day: number, hour: number, minute = 0, month = 11, year = 2026) =>
  zonedTime("Europe/Oslo", year, month, day, hour, minute);
export const blr = (day: number, hour: number, minute = 0, month = 11, year = 2026) =>
  zonedTime("Asia/Kolkata", year, month, day, hour, minute);

export const emp = (id: string, home: OfficeId, extra: Partial<Employee> = {}): Employee => ({
  id, homeOffice: home, payrollCurrency: home === "OSLO" ? "NOK" : "INR",
  isVolunteer: true, officeWeekdays: WEEKDAYS, absences: [], visits: [], ...extra,
});

export function setup(employees: Employee[], start = oslo(16, 10), opts: Partial<Options> = {}) {
  const clock = new FakeClock(start);
  const chat = new FakeChat();
  const hr = new FakeHr();
  const svc = new RefillService(OFFICES, employees, chat, hr, clock, opts);
  return { clock, chat, hr, svc, employees };
}

export const errorCode = (fn: () => unknown) => {
  try { fn(); } catch (e) { return (e as DomainError).code ?? String(e); }
  return "NO_ERROR";
};

/** Full happy path for one refill: report, accept, buy. */
export function refillAndBuy(svc: RefillService, office: OfficeId, amount: number) {
  const r = svc.reportEmpty(office);
  if (r.status !== "OFFERED") throw new Error(`expected OFFERED, got ${r.status}`);
  const buyer = r.assignee!;
  svc.accept(r.id, buyer);
  svc.submitPurchase(r.id, buyer, { amount, currency: OFFICES[office].currency, receiptRef: "img" });
  return r;
}
