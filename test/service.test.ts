import { describe, expect, it } from "vitest";
import { HOUR, monthlyReport } from "../src/index.js";
import { OFFICES, blr, emp, errorCode, oslo, refillAndBuy, setup } from "./helpers.js";

const NOK = (amount: number, receiptRef = "img", items?: string[]) =>
  ({ amount, currency: "NOK" as const, receiptRef, ...(items ? { items } : {}) });
const team = () => [emp("a", "OSLO"), emp("b", "OSLO"), emp("c", "OSLO")];

describe("one refill, one buyer", () => {
  it("reporting empty twice yields one refill and one offer", () => {
    const { svc, chat } = setup(team());
    const r1 = svc.reportEmpty("OSLO");
    const r2 = svc.reportEmpty("OSLO");
    expect(r2.id).toBe(r1.id);
    expect(svc.allRefills()).toHaveLength(1);
    expect(chat.direct.filter((m) => m.text.includes("You're up"))).toHaveLength(1);
  });

  it("only the holder can accept or submit", () => {
    const { svc, hr } = setup(team());
    const r = svc.reportEmpty("OSLO");
    const other = ["a", "b", "c"].find((x) => x !== r.assignee)!;
    expect(errorCode(() => svc.accept(r.id, other))).toBe("NOT_ASSIGNEE");
    expect(errorCode(() => svc.submitPurchase(r.id, other, NOK(500_00)))).toBe("NOT_ASSIGNEE");
    expect(hr.claims.size).toBe(0);
  });

  it("two people cannot both take an open refill: first volunteer wins", () => {
    const { svc } = setup([emp("a", "OSLO", { isVolunteer: false }), emp("b", "OSLO", { isVolunteer: false })]);
    const r = svc.reportEmpty("OSLO");
    expect(r.status).toBe("OPEN");
    svc.volunteer(r.id, "a");
    expect(errorCode(() => svc.volunteer(r.id, "b"))).toBe("ALREADY_TAKEN");
    expect(r).toMatchObject({ status: "ACCEPTED", assignee: "a" });
  });

  it("a new empty report starts a new refill once the previous one is bought", () => {
    const { svc } = setup(team());
    const r = refillAndBuy(svc, "OSLO", 500_00);
    expect(svc.reportEmpty("OSLO").id).not.toBe(r.id);
  });
});

describe("offer -> accept -> buy, with working-hours deadlines", () => {
  it("an unanswered offer moves on after 2 working hours", () => {
    const { svc, clock } = setup(team());
    const r = svc.reportEmpty("OSLO");
    const first = r.assignee!;
    clock.set(oslo(16, 11, 59)); svc.tick();
    expect(r.assignee).toBe(first);
    clock.set(oslo(16, 12)); svc.tick();
    expect(r.assignee).not.toBe(first);
    expect(r.attempts[0]).toMatchObject({ employeeId: first, outcome: "OFFER_EXPIRED" });
  });

  it("the accept clock is paused overnight", () => {
    const { svc, clock } = setup(team(), oslo(16, 16, 30));
    const r = svc.reportEmpty("OSLO");
    const first = r.assignee;
    clock.set(oslo(17, 8, 0)); svc.tick();
    expect(r.assignee).toBe(first); // only 30 working minutes used
    clock.set(oslo(17, 10, 30)); svc.tick();
    expect(r.assignee).not.toBe(first);
  });

  it("decline passes immediately to a different person", () => {
    const { svc } = setup(team());
    const r = svc.reportEmpty("OSLO");
    const first = r.assignee!;
    svc.decline(r.id, first);
    expect(r.status).toBe("OFFERED");
    expect(r.assignee).not.toBe(first);
  });

  it("sends exactly one reminder before the buy deadline", () => {
    const { svc, clock, chat } = setup(team());
    const r = svc.reportEmpty("OSLO");
    const buyer = r.assignee!;
    svc.accept(r.id, buyer); // due Tue 10:00 (8 working hours)
    clock.set(oslo(17, 8, 30)); svc.tick(); // Tue 08:30, 1.5 working hours left: before office opens
    clock.set(oslo(17, 9)); svc.tick();
    clock.set(oslo(17, 9, 30)); svc.tick();
    expect(chat.directTo(buyer).filter((m) => m.text.startsWith("Reminder"))).toHaveLength(1);
  });
});

describe("'did you buy?' before handing off", () => {
  const overdue = () => {
    const ctx = setup(team());
    const r = ctx.svc.reportEmpty("OSLO");
    const first = r.assignee!;
    ctx.svc.accept(r.id, first);
    ctx.clock.set(oslo(17, 10)); ctx.svc.tick(); // buy deadline reached
    return { ...ctx, r, first };
  };

  it("asks first instead of reassigning", () => {
    const { r, first, chat } = overdue();
    expect(r).toMatchObject({ status: "CONFIRMING", assignee: first });
    expect(chat.directTo(first).at(-1)!.text).toMatch(/Did you buy/);
  });

  it("'no' hands off immediately", () => {
    const { svc, r, first } = overdue();
    svc.confirmNotBought(r.id, first);
    expect(r.status).toBe("OFFERED");
    expect(r.assignee).not.toBe(first);
  });

  it("no answer hands off after the confirm window", () => {
    const { svc, r, first, clock } = overdue();
    clock.set(oslo(17, 12)); svc.tick();
    expect(r.assignee).not.toBe(first);
    expect(r.attempts[0]!.outcome).toBe("NO_RESPONSE");
  });

  it("a receipt while confirming is accepted", () => {
    const { svc, r, first } = overdue();
    svc.submitPurchase(r.id, first, NOK(500_00));
    expect(r.status).toBe("CLAIM_SUBMITTED");
  });

  it("late receipt after hand-off is accepted if the new holder has not bought; new holder stands down", () => {
    const { svc, r, first, clock, chat } = overdue();
    clock.set(oslo(17, 12)); svc.tick();
    const second = r.assignee!;
    svc.accept(r.id, second);
    svc.submitPurchase(r.id, first, NOK(500_00));
    expect(r.purchase!.buyer).toBe(first);
    expect(r.attempts.map((a) => a.outcome)).toEqual(["BOUGHT", "STOOD_DOWN"]);
    expect(chat.directTo(second).at(-1)!.text).toMatch(/No need to buy/);
  });

  it("a second purchase after someone already bought is refused and escalated to the admin", () => {
    const { svc, r, first, clock, chat } = overdue();
    clock.set(oslo(17, 12)); svc.tick();
    const second = r.assignee!;
    svc.submitPurchase(r.id, second, NOK(500_00));
    expect(errorCode(() => svc.submitPurchase(r.id, first, NOK(500_00)))).toBe("ALREADY_PURCHASED");
    expect(chat.directTo("admin-oslo").at(-1)!.text).toMatch(/also bought/);
  });

  it("when everyone has been tried the office is pinged once, not on every tick", () => {
    const { svc, chat, clock } = setup([emp("a", "OSLO")]);
    const r = svc.reportEmpty("OSLO");
    svc.decline(r.id, "a");
    for (let i = 0; i < 5; i++) { clock.advance(HOUR); svc.tick(); }
    expect(r.status).toBe("OPEN");
    expect(chat.office.filter((m) => m.text.includes("no volunteer available"))).toHaveLength(1);
  });
});

describe("who gets picked", () => {
  it("skips people on holiday, non-volunteers, and people working from home today", () => {
    const { svc } = setup([
      emp("holiday", "OSLO", { absences: [{ from: oslo(16, 0), to: oslo(18, 0) }] }),
      emp("notvol", "OSLO", { isVolunteer: false }),
      emp("wfh-monday", "OSLO", { officeWeekdays: [2, 3, 4] }),
      emp("z-in-office", "OSLO"),
    ]);
    expect(svc.reportEmpty("OSLO").assignee).toBe("z-in-office");
  });

  it("outside hours, picks someone who will be in office on the next working day", () => {
    const { svc } = setup([emp("fridays", "OSLO", { officeWeekdays: [5] }), emp("mondays", "OSLO", { officeWeekdays: [1] })], oslo(20, 20));
    expect(svc.reportEmpty("OSLO").assignee).toBe("mondays"); // reported Fri 20:00
  });

  it("a visitor counts at the office they visit, not at home", () => {
    const { svc } = setup([
      emp("visitor", "OSLO", { visits: [{ office: "BENGALURU", from: oslo(1, 0), to: oslo(30, 0) }] }),
    ], blr(16, 10));
    expect(svc.reportEmpty("BENGALURU").assignee).toBe("visitor");
    expect(svc.reportEmpty("OSLO").status).toBe("OPEN");
  });

  it("an OPEN refill is offered on tick once a volunteer is back", () => {
    const { svc, clock } = setup([emp("a", "OSLO", { absences: [{ from: oslo(16, 0), to: oslo(17, 0) }] })]);
    const r = svc.reportEmpty("OSLO");
    expect(r.status).toBe("OPEN");
    clock.set(oslo(17, 9)); svc.tick();
    expect(r.assignee).toBe("a");
  });

  it("spreads the work across volunteers", () => {
    const { svc, clock } = setup(team());
    const buyers: string[] = [];
    for (let i = 0; i < 3; i++) {
      buyers.push(refillAndBuy(svc, "OSLO", 400_00).purchase!.buyer);
      clock.advance(HOUR);
    }
    expect(new Set(buyers).size).toBe(3);
  });

  it("prefers people who are not still waiting for money", () => {
    const { svc, hr } = setup([emp("a", "OSLO"), emp("b", "OSLO")]);
    const r1 = refillAndBuy(svc, "OSLO", 400_00); // a
    refillAndBuy(svc, "OSLO", 400_00); // b
    hr.setStatus(r1.hrClaimId!, "APPROVED");
    svc.tick(); // a is paid, b still waiting
    expect(svc.reportEmpty("OSLO").assignee).toBe("a");
  });
});

describe("budget is reserved at offer time", () => {
  it("the offer tells the buyer the cap (top of typical range)", () => {
    const { svc, chat } = setup(team());
    const r = svc.reportEmpty("OSLO");
    expect(r.cap).toBe(1_200_00);
    expect(chat.directTo(r.assignee!).at(-1)!.text).toContain("Spend up to 1200.00 NOK");
  });

  it("the cap shrinks to what is left of the budget", () => {
    const { svc } = setup(team());
    for (const amt of [1_200_00, 1_200_00, 1_200_00, 1_200_00, 700_00]) refillAndBuy(svc, "OSLO", amt); // 5 500
    expect(svc.reportEmpty("OSLO").cap).toBe(500_00);
  });

  it("no offer when less than a typical purchase is left; admin told; offered again next month", () => {
    const { svc, chat, clock } = setup(team());
    for (const amt of [1_200_00, 1_200_00, 1_200_00, 1_200_00, 1_000_00]) refillAndBuy(svc, "OSLO", amt); // 5 800
    const r = svc.reportEmpty("OSLO");
    expect(r).toMatchObject({ status: "OPEN", waitingReason: "BUDGET" });
    expect(chat.directTo("admin-oslo").at(-1)!.text).toMatch(/budget for 2026-11 is used up/);
    clock.set(oslo(1, 9, 0, 12)); svc.tick(); // Tue 1 Dec
    expect(r.status).toBe("OFFERED");
  });

  it("budget can be filled exactly, never exceeded", () => {
    const { svc } = setup(team());
    for (let i = 0; i < 5; i++) refillAndBuy(svc, "OSLO", 1_200_00);
    expect(svc.spent("OSLO", "2026-11")).toBe(6_000_00);
    expect(svc.reportEmpty("OSLO").waitingReason).toBe("BUDGET");
  });

  it("a receipt above the cap goes to the budget owner, nothing to HR, and is never handed on", () => {
    const { svc, hr, chat, clock } = setup(team());
    const r = svc.reportEmpty("OSLO");
    const buyer = r.assignee!;
    svc.accept(r.id, buyer);
    svc.submitPurchase(r.id, buyer, NOK(1_300_00));
    expect(r).toMatchObject({ status: "AWAITING_ADMIN", purchase: { buyer } });
    expect(hr.claims.size).toBe(0);
    expect(chat.directTo("admin-oslo").at(-1)!.text).toMatch(/approve or reject/);
    clock.set(oslo(19, 12)); svc.tick(); // well past every deadline
    expect(r.attempts).toHaveLength(1); // nobody else asked to buy
    expect(r.attempts[0]!.outcome).toBe("BOUGHT");
    expect(svc.spent("OSLO", "2026-11")).toBe(0); // not spend until approved
  });

  it("budget owner approval sends the claim; rejection closes it; only the owner may decide", () => {
    const { svc, hr } = setup(team());
    const r1 = svc.reportEmpty("OSLO");
    svc.submitPurchase(r1.id, r1.assignee!, NOK(1_300_00));
    expect(errorCode(() => svc.adminResolve(r1.id, "a", "APPROVE"))).toBe("NOT_ADMIN");
    svc.adminResolve(r1.id, "admin-oslo", "APPROVE");
    expect(r1.status).toBe("CLAIM_SUBMITTED");
    expect(hr.claims.size).toBe(1);

    const r2 = svc.reportEmpty("OSLO");
    svc.submitPurchase(r2.id, r2.assignee!, NOK(1_500_00));
    svc.adminResolve(r2.id, "admin-oslo", "REJECT");
    expect(r2.status).toBe("REJECTED_BY_ADMIN");
    expect(hr.claims.size).toBe(1);
  });

  it("the budget owner cannot approve past the monthly budget (hard limit)", () => {
    const { svc } = setup(team());
    for (let i = 0; i < 4; i++) refillAndBuy(svc, "OSLO", 1_200_00); // 4 800
    const r = svc.reportEmpty("OSLO"); // cap 1 200
    svc.submitPurchase(r.id, r.assignee!, NOK(1_300_00));
    expect(errorCode(() => svc.adminResolve(r.id, "admin-oslo", "APPROVE"))).toBe("OVER_BUDGET");
    expect(r.status).toBe("AWAITING_ADMIN");
  });

  it("submitted-but-unapproved claims count against the budget; HR rejections release it", () => {
    const { svc, hr } = setup(team());
    const r = refillAndBuy(svc, "OSLO", 1_000_00);
    expect(svc.spent("OSLO", "2026-11")).toBe(1_000_00);
    hr.setStatus(r.hrClaimId!, "REJECTED");
    svc.tick();
    expect(svc.spent("OSLO", "2026-11")).toBe(0);
  });

  it("budgets are per office and per office-local month", () => {
    const { svc, clock } = setup([emp("a", "OSLO"), emp("x", "BENGALURU")], blr(30, 16)); // Mon 30 Nov in Bengaluru
    refillAndBuy(svc, "BENGALURU", 3_000_00);
    clock.set(blr(1, 1, 30, 12)); // still 30 Nov in UTC, Dec in IST
    const r = svc.reportEmpty("BENGALURU");
    expect(r.assignee).toBe("x"); // offered for when the office opens
    svc.submitPurchase(r.id, "x", { amount: 500_00, currency: "INR", receiptRef: "img" });
    expect(svc.spent("BENGALURU", "2026-11")).toBe(3_000_00);
    expect(svc.spent("BENGALURU", "2026-12")).toBe(500_00);
    expect(svc.spent("OSLO", "2026-11")).toBe(0);
  });
});

describe("input validation", () => {
  it.each([
    [0, "INVALID_AMOUNT"], [-100, "INVALID_AMOUNT"], [12.5, "INVALID_AMOUNT"], [Number.NaN, "INVALID_AMOUNT"],
  ])("amount %s -> %s", (amount, code) => {
    const { svc } = setup(team());
    const r = svc.reportEmpty("OSLO");
    expect(errorCode(() => svc.submitPurchase(r.id, r.assignee!, NOK(amount)))).toBe(code);
  });

  it("rejects missing receipts and wrong currency", () => {
    const { svc } = setup(team());
    const r = svc.reportEmpty("OSLO");
    expect(errorCode(() => svc.submitPurchase(r.id, r.assignee!, NOK(500_00, "  ")))).toBe("INVALID_RECEIPT");
    expect(errorCode(() => svc.submitPurchase(r.id, r.assignee!, { amount: 500_00, currency: "INR", receiptRef: "img" }))).toBe("WRONG_CURRENCY");
  });
});

describe("HR integration", () => {
  it("HR outage: purchase is kept, refill is NOT handed to someone else, claim retried once HR is back", () => {
    const { svc, hr, clock } = setup(team());
    hr.failNext = 2;
    const r = svc.reportEmpty("OSLO");
    const buyer = r.assignee!;
    svc.accept(r.id, buyer);
    svc.submitPurchase(r.id, buyer, NOK(500_00));
    expect(r.status).toBe("PURCHASED");
    clock.set(oslo(18, 12)); svc.tick(); // still failing, and well past every deadline
    expect(r).toMatchObject({ status: "PURCHASED", purchase: { buyer } });
    svc.tick();
    expect(r.status).toBe("CLAIM_SUBMITTED");
    expect(hr.claims.size).toBe(1);
    expect(svc.spent("OSLO", "2026-11")).toBe(500_00);
  });

  it("sends the right claim and tracks approval", () => {
    const { svc, hr } = setup(team());
    const r = refillAndBuy(svc, "OSLO", 750_00);
    expect(hr.claims.get(r.hrClaimId!)!.req).toMatchObject({
      idempotencyKey: r.id, employeeId: r.purchase!.buyer, amount: 750_00, currency: "NOK", receiptRef: "img",
    });
    svc.tick();
    expect(r.status).toBe("CLAIM_SUBMITTED");
    hr.setStatus(r.hrClaimId!, "APPROVED");
    svc.tick();
    expect(r.status).toBe("APPROVED");
  });

  it("chases a claim pending more than 10 days, once", () => {
    const { svc, clock, chat } = setup(team());
    refillAndBuy(svc, "OSLO", 500_00);
    clock.advance(9 * 24 * HOUR); svc.tick();
    expect(chat.directTo("admin-oslo")).toHaveLength(0);
    clock.advance(1 * 24 * HOUR); svc.tick(); svc.tick();
    expect(chat.directTo("admin-oslo").filter((m) => m.text.includes("pending over 10 days"))).toHaveLength(1);
  });

  it("a visitor's claim is in the receipt currency (HR converts to payroll)", () => {
    const { svc, hr } = setup([emp("v", "OSLO", { visits: [{ office: "BENGALURU", from: oslo(1, 0), to: oslo(30, 0) }] })], blr(16, 10));
    const r = refillAndBuy(svc, "BENGALURU", 1_200_00);
    expect(hr.claims.get(r.hrClaimId!)!.req).toMatchObject({ employeeId: "v", currency: "INR" });
  });
});

describe("monthly report", () => {
  const scenario = () => {
    const ctx = setup([emp("a", "OSLO"), emp("b", "OSLO"), emp("x", "BENGALURU")]);
    const { svc, hr, clock } = ctx;
    const r1 = svc.reportEmpty("OSLO", { ranOut: ["chips", "chocolate"] });
    svc.reportEmpty("OSLO", { ranOut: ["chips"] }); // same refill, more feedback
    svc.accept(r1.id, r1.assignee!);
    svc.submitPurchase(r1.id, r1.assignee!, NOK(500_00, "img", ["chips", "fruit"]));
    hr.setStatus(r1.hrClaimId!, "APPROVED");
    svc.tick();
    refillAndBuy(svc, "OSLO", 700_00);
    clock.set(blr(17, 10));
    refillAndBuy(svc, "BENGALURU", 2_500_00);
    return ctx;
  };

  it("keeps currencies separate and sums correctly", () => {
    const { svc } = scenario();
    const rep = monthlyReport(svc, OFFICES, "2026-11");
    expect(rep.totals).toEqual({ NOK: 1_200_00, INR: 2_500_00 });
    expect(rep.combined).toBeUndefined();
    expect(rep.offices.find((o) => o.office === "OSLO")).toMatchObject({
      spent: 1_200_00, approved: 500_00, awaitingHr: 700_00, remaining: 4_800_00, refills: 2,
      ranOut: { chips: 2, chocolate: 1 }, itemsBought: { chips: 1, fruit: 1 },
    });
  });

  it("adds one combined total when the caller supplies a rate", () => {
    const { svc } = scenario();
    const rep = monthlyReport(svc, OFFICES, "2026-11", { currency: "NOK", rates: { INR: 0.12 } });
    expect(rep.combined).toEqual({ currency: "NOK", amount: 1_200_00 + 300_00, rates: { INR: 0.12 } });
  });

  it("refuses to guess a missing rate", () => {
    const { svc } = scenario();
    expect(() => monthlyReport(svc, OFFICES, "2026-11", { currency: "NOK", rates: {} })).toThrow(/missing FX rate/);
  });
});
