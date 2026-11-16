/**
 * Walkthrough of one Oslo refill (with hand-offs and an HR outage) plus one Bengaluru refill,
 * ending with the monthly report. Run: npm run demo
 */
import {
  FakeClock, FakeHr, RefillService, monthlyReport, zonedTime,
  type ChatPort, type Employee, type OfficeConfig, type OfficeId,
} from "../src/index.js";

const WEEKDAYS = [1, 2, 3, 4, 5];
const OFFICES: Record<OfficeId, OfficeConfig> = {
  OSLO: {
    id: "OSLO", currency: "NOK", monthlyBudget: 6_000_00, typicalPurchase: { min: 300_00, max: 1_200_00 },
    adminId: "oslo-admin", timeZone: "Europe/Oslo", startHour: 9, endHour: 17, workdays: WEEKDAYS,
  },
  BENGALURU: {
    id: "BENGALURU", currency: "INR", monthlyBudget: 15_000_00, typicalPurchase: { min: 500_00, max: 3_000_00 },
    adminId: "blr-admin", timeZone: "Asia/Kolkata", startHour: 9, endHour: 17, workdays: WEEKDAYS,
  },
};

const oslo = (day: number, h: number, m = 0) => zonedTime("Europe/Oslo", 2026, 11, day, h, m);
const person = (id: string, home: OfficeId, extra: Partial<Employee> = {}): Employee => ({
  id, homeOffice: home, payrollCurrency: home === "OSLO" ? "NOK" : "INR",
  isVolunteer: true, officeWeekdays: WEEKDAYS, absences: [], visits: [], ...extra,
});

const employees: Employee[] = [
  person("anna", "OSLO"),
  person("bjorn", "OSLO", { officeWeekdays: [2, 3, 4] }), // works from home Mon and Fri
  person("carla", "OSLO", { absences: [{ from: oslo(9, 0), to: oslo(23, 0) }] }), // on holiday
  person("priya", "BENGALURU", { visits: [{ office: "OSLO", from: oslo(16, 0), to: oslo(21, 0) }] }), // visiting Oslo
  person("ravi", "BENGALURU"),
];

const clock = new FakeClock(oslo(16, 10)); // Monday 16 Nov 2026, 10:00 Oslo
const localTime = (tz: string) =>
  new Date(clock.now()).toLocaleString("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit" });

const chat: ChatPort = {
  sendDirect: (to, text) => console.log(`    DM  -> ${to.padEnd(10)} ${text}`),
  sendToOffice: (office, text) => console.log(`    #${office.toLowerCase()} ${text}`),
};
const hr = new FakeHr();
const svc = new RefillService(OFFICES, employees, chat, hr, clock);

/** Moves the clock (optional), prints a header in office-local time, then runs the periodic job. */
const step = (title: string, t?: number, tz = "Europe/Oslo") => {
  if (t !== undefined) clock.set(t);
  console.log(`\n[${localTime(tz)}] ${title}`);
  if (t !== undefined) svc.tick();
};

// ---- Oslo -------------------------------------------------------------------
step("Erik reports the Oslo box empty (chips ran out first)");
const r = svc.reportEmpty("OSLO", { reportedBy: "erik", ranOut: ["chips"] });
console.log(`    -> ${r.id} ${r.status}, offered to ${r.assignee} (bjorn works from home on Mondays, carla is on holiday)`);

step("Someone else reports it again: same refill, nobody else is asked");
console.log(`    -> ${svc.reportEmpty("OSLO", { ranOut: ["chocolate"] }).id}`);

step("Anna has not answered within 2 working hours", oslo(16, 12));
console.log(`    -> now offered to ${r.assignee} (visiting from Bengaluru)`);

step("Priya accepts");
svc.accept(r.id, "priya");

step("2 working hours before her deadline", oslo(17, 10));

step("Buy deadline passes: she is asked before anyone else is", oslo(17, 12));

step("Priya answers 'no'");
svc.confirmNotBought(r.id, "priya");
console.log(`    -> offered to ${r.assignee} (in the office on Tuesdays)`);

step("Bjorn accepts and submits an 850 NOK receipt, but HR is down");
svc.accept(r.id, "bjorn");
hr.failNext = 1;
svc.submitPurchase(r.id, "bjorn", { amount: 850_00, currency: "NOK", receiptRef: "receipt-001.jpg", items: ["chips", "fruit"] });
console.log(`    -> ${r.status}`);

step("Next tick: HR is back, the claim is retried", oslo(17, 12, 5));
console.log(`    -> ${r.status} (${r.hrClaimId})`);

hr.setStatus(r.hrClaimId!, "APPROVED");
step("HR approved the claim", oslo(20, 10));
console.log(`    -> attempts: ${r.attempts.map((a) => `${a.employeeId}=${a.outcome}`).join(", ")}`);

// ---- Bengaluru --------------------------------------------------------------
step("Bengaluru box empty; the buyer spends 2 400 INR", zonedTime("Asia/Kolkata", 2026, 11, 23, 11), "Asia/Kolkata");
const b = svc.reportEmpty("BENGALURU", { ranOut: ["biscuits"] });
svc.accept(b.id, b.assignee!);
svc.submitPurchase(b.id, b.assignee!, { amount: 2_400_00, currency: "INR", receiptRef: "receipt-002.jpg" });

// ---- Report -----------------------------------------------------------------
const report = monthlyReport(svc, OFFICES, "2026-11", { currency: "NOK", rates: { INR: 0.12 } });
const fmt = (n: number) => (n / 100).toFixed(2).padStart(10);
console.log(`\nMonthly report ${report.month}`);
console.log("    office      currency     budget      spent   approved  awaitingHR  remaining  ran out first");
for (const o of report.offices) {
  console.log(
    `    ${o.office.padEnd(11)} ${o.currency.padEnd(8)} ${fmt(o.budget)} ${fmt(o.spent)} ${fmt(o.approved)}  ${fmt(o.awaitingHr)} ${fmt(o.remaining)}  ${JSON.stringify(o.ranOut)}`,
  );
}
console.log(`    combined: ${(report.combined!.amount / 100).toFixed(2)} ${report.combined!.currency} (caller-supplied rate: 1 INR = 0.12 NOK)`);
