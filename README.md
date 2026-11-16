# Snack Counter Automation

Core logic for coordinating snack-box refills in the Oslo and Bengaluru offices: who buys, by when,
how much may be spent, and getting the volunteer reimbursed through HR. The chat tool and the HR
system are simulated (`src/fakes.ts`). Design rationale and trade-offs: [DESIGN.md](DESIGN.md).

TypeScript, zero runtime dependencies (dev only: typescript, vitest, tsx).

![design](image.png)

## Setup

Requires Node.js 22.12+ (or 24+) and npm.

```sh
git clone <repo-url> framskit && cd framskit   # or unzip the hand-in
npm install
npm test            # 48 tests
npm run typecheck   # tsc, strict mode
npm run demo        # walkthrough below
```

| Command                        | What it does                                   |
| ------------------------------ | ---------------------------------------------- |
| `npm test`                     | Run all tests once                             |
| `npx vitest`                   | Tests in watch mode                            |
| `npx vitest run -t "budget"`   | Only tests whose name matches "budget"         |
| `npm run typecheck`            | Type-check `src`, `test` and `demo`            |
| `npm run demo`                 | Run the demo scenario in `demo/demo.ts`        |

## Demo use case

`npm run demo` plays one week, Monday 16 November 2026, with a simulated clock:

Oslo volunteers: anna (in office Mon-Fri), bjorn (in office Tue-Thu), carla (on holiday), and
priya (Bengaluru employee visiting Oslo this week). Bengaluru: ravi.

1. Erik reports the Oslo box empty, chips ran out first. The system reserves budget and offers the
   job to anna with a cap of 1200 NOK. bjorn (working from home) and carla (holiday) are not asked.
2. A second "empty" report joins the same refill, so nobody else is asked to buy.
3. anna does not answer within 2 working hours; the offer moves to priya, who accepts.
4. priya gets a reminder, the deadline passes, and she is asked "did you buy?" before anyone
   else is. She says no.
5. On Tuesday bjorn is in the office, gets the offer, buys for 850 NOK. HR is down: the receipt is
   kept and the claim is retried on the next tick (no duplicate claim, no second buyer).
6. HR approves on Friday. Bengaluru does a refill for 2400 INR.
7. The monthly report shows budget, spent, approved, awaiting HR and what ran out per office, plus a
   combined total in NOK using a rate the caller supplies.

Excerpt of the output:

```
[Mon 12:00] Anna has not answered within 2 working hours
    DM  -> anna       No answer on refill-1; offering it to someone else.
    DM  -> priya      You're up to refill the OSLO snack box (refill-1). Spend up to 1200.00 NOK. Please accept or decline by Mon 16 Nov 14:00 (Europe/Oslo).
...
[Tue 12:00] Buy deadline passes: she is asked before anyone else is
    DM  -> priya      Did you buy snacks for refill-1? Submit the receipt, or answer "no" and it goes to someone else.
...
Monthly report 2026-11
    office      currency     budget      spent   approved  awaitingHR  remaining  ran out first
    OSLO        NOK         6000.00     850.00     850.00        0.00    5150.00  {"chips":1,"chocolate":1}
    BENGALURU   INR        15000.00    2400.00       0.00     2400.00   12600.00  {"biscuits":1}
    combined: 1138.00 NOK (caller-supplied rate: 1 INR = 0.12 NOK)
```

## Using the API

All amounts are integer minor units (øre / paise): `850_00` is 850.00 NOK.

```ts
import { RefillService, FakeChat, FakeHr, FakeClock, monthlyReport } from "./src/index.js";

const svc = new RefillService(offices, employees, chat, hr, clock /*, { acceptWindowMs, buyWindowMs, ... } */);

const r = svc.reportEmpty("OSLO", { reportedBy: "erik", ranOut: ["chips"] }); // OFFERED to one volunteer
svc.accept(r.id, r.assignee!);                    // or svc.decline(r.id, id)
svc.submitPurchase(r.id, r.assignee!, {
  amount: 850_00, currency: "NOK", receiptRef: "receipt.jpg", items: ["chips"],
});                                               // claim goes to HR
svc.tick();                                       // run periodically: deadlines, reminders, HR retries/sync
monthlyReport(svc, offices, "2026-11", { currency: "NOK", rates: { INR: 0.12 } });
```

| Method                                   | Chat action it represents                                  |
| ---------------------------------------- | ---------------------------------------------------------- |
| `reportEmpty(office, { ranOut })`        | "The box is empty" (repeats join the active refill)        |
| `accept(refillId, employeeId)`           | Offered volunteer accepts                                  |
| `decline(refillId, employeeId)`          | Holder gives it back; next person is offered immediately   |
| `confirmNotBought(refillId, employeeId)` | Answer "no" to "did you buy?"                              |
| `volunteer(refillId, employeeId)`        | Anyone takes an unassigned refill (first one wins)         |
| `submitPurchase(refillId, employeeId, p)`| Receipt + amount (also accepted late if nobody else bought)|
| `adminResolve(refillId, adminId, d)`     | Budget owner approves/rejects an over-cap receipt          |
| `tick()`                                 | Scheduler, e.g. every 5 minutes                            |

Errors are thrown as `DomainError` with a `code` such as `NOT_ASSIGNEE`, `ALREADY_TAKEN`,
`ALREADY_PURCHASED`, `OVER_BUDGET`, `INVALID_AMOUNT`, `NOT_ADMIN`. A receipt over the cap is not an
error: the refill moves to `AWAITING_ADMIN` and waits for the budget owner.

Defaults: accept within 2 working hours, buy within 1 working day (8 h), "did you buy?" answer within
2 working hours, reminder 2 working hours before the buy deadline, chase HR after 10 calendar days.
Working hours are 09:00-17:00 Mon-Fri in each office's time zone.

## Project layout

```
src/
  service.ts    refill lifecycle, budget reservation, HR retry/sync
  selection.ts  who is in the office and who gets asked (fairness ranking)
  time.ts       office-local working-time arithmetic (DST-aware, no dependencies)
  report.ts     monthly report per office/currency, optional combined total
  ports.ts      ChatPort and HrPort interfaces
  fakes.ts      simulated chat, HR (with outage switch) and clock
  types.ts      domain types and DomainError
test/           vitest tests: lifecycle, hand-offs, budget, selection, HR, report, time
demo/demo.ts    the walkthrough above
DESIGN.md       design document
```
