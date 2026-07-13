/**
 * Node-based port-parity checks for assignment_engine.js — mirrors the key
 * scenarios from test_assignment_engine.py to confirm the JS port behaves
 * the same as the Python original before any UI is built on top of it.
 * Run: node test_assignment_engine.js
 */
const AE = require("./assignment_engine.js");

let passed = 0,
  failed = 0;
function check(label, cond) {
  if (cond) {
    passed++;
    console.log("  PASS  " + label);
  } else {
    failed++;
    console.log("  FAIL  " + label);
  }
}

function W(id, name, extra) {
  return AE.makeWorker(Object.assign({ id, name }, extra || {}));
}

const DEPT_FILLER = [1, 2, 3, 4, 5].map(i => W(`0dept${i}`, `DeptFiller${i}`));

console.log("Test 1: mutual partners end up together when both prefer the same zone");
let settings = AE.makeSettings({ casePerMinuteRate: 1.0 });
let zones = AE.makeZones({ A: 150, B: 180, C: 400, D: 210, E: 190, F: 170, G: 160, H: 90, I: 300 });
let workers = [
  W("w1", "Alex", { preferredZones: ["C"], preferredPartners: ["w2"] }),
  W("w2", "Brianna", { preferredZones: ["C"], preferredPartners: ["w1"] }),
  W("w3", "Chris", { preferredZones: ["A"] }),
  W("w4", "Dana", { preferredZones: ["A"] }),
].concat(DEPT_FILLER);
let result = AE.assignNight(workers, zones, settings);
check("Alex and Brianna both in zone C", new Set(result.assignments["C"].workerIds).size === 2 && result.assignments["C"].workerIds.includes("w1") && result.assignments["C"].workerIds.includes("w2"));

console.log("\nTest 2: juice zone workload ignores case count (fixed duration)");
let zones2 = AE.makeZones(Object.assign({}, ...["A", "B", "C", "D", "E", "F", "G", "H"].map(z => ({ [z]: 100 })), { I: 5000 }));
let workers2 = Array.from({ length: 18 }, (_, i) => W(`w${i + 1}`, `W${i + 1}`)).concat(DEPT_FILLER);
let result2 = AE.assignNight(workers2, zones2, settings);
check(`Zone I workload == juiceFixedDurationHours (${settings.juiceFixedDurationHours})`, Math.abs(result2.assignments["I"].workloadHours - settings.juiceFixedDurationHours) < 0.001);

console.log("\nTest 3: group size never exceeds maxGroupSize even under heavy load");
let zones3 = AE.makeZones({ A: 5000, B: 100, C: 100, D: 100, E: 100, F: 100, G: 100, H: 100, I: 100 });
let workers3 = Array.from({ length: 29 }, (_, i) => W(`w${i + 1}`, `W${i + 1}`));
let result3 = AE.assignNight(workers3, zones3, settings);
check(`Zone A group size <= maxGroupSize (${settings.maxGroupSize})`, result3.assignments["A"].workerIds.length <= settings.maxGroupSize);

console.log("\nTest 5: severe under-staffing produces a non-zero, reported shortfall");
let zones5 = AE.makeZones(Object.assign({}, ...["A", "B", "C", "D", "E", "F", "G", "H"].map(z => ({ [z]: 400 })), { I: 500 }));
let workers5 = Array.from({ length: 4 }, (_, i) => W(`w${i + 1}`, `W${i + 1}`)).concat(DEPT_FILLER);
let result5 = AE.assignNight(workers5, zones5, settings);
check("shortfallHours > 0", result5.shortfallHours > 0);
check("a shortfall note was generated", result5.notes.some(n => n.includes("Short-staffed")));

console.log("\nTest 6: all 11 zones present");
check("all 11 zones present", new Set(Object.keys(result5.assignments)).size === 11);

console.log("\nTest 7: incompatible workers never end up in the same group, even short-staffed");
let zones7 = AE.makeZones(Object.assign({}, ...["A", "B", "C", "D", "E", "F", "G", "H"].map(z => ({ [z]: 150 })), { I: 300 }));
let bad1 = W("bad1", "Nobody-likes-me", { incompatibleWith: ["bad2"] });
let bad2 = W("bad2", "TheOtherGuy");
let few = [bad1, bad2, W("w3", "Filler1"), W("w4", "Filler2")].concat(DEPT_FILLER);
let result7 = AE.assignNight(few, zones7, settings);
let violation = Object.values(result7.assignments).some(a => a.workerIds.includes("bad1") && a.workerIds.includes("bad2"));
check("bad1 and bad2 never share a zone despite being short-staffed", !violation);

console.log("\nTest 8: 1st choice beats 2nd choice");
let zones8 = AE.makeZones(Object.assign({}, ...["A", "B", "C", "D", "E", "F", "G", "H", "I"].map(z => ({ [z]: 100 }))));
let f1 = W("f1", "FirstChoicer", { preferredZones: ["A", "B"] });
let f2 = W("f2", "SecondChoicer", { preferredZones: ["B", "A"] });
let f3 = W("f3", "SecondChoicer2", { preferredZones: ["B", "A"] });
let filler8 = Array.from({ length: 13 }, (_, i) => W(`x${i + 1}`, `Filler${i + 1}`));
let crew8 = [f1, f2, f3].concat(filler8, DEPT_FILLER);
let result8 = AE.assignNight(crew8, zones8, settings);
check("worker whose #1 choice is A gets placed in A", result8.assignments["A"].workerIds.includes("f1"));

console.log("\nTest 9: redistribution suggests heaviest eligible zone for unassigned workers");
let zones9 = AE.makeZones({ A: 100, B: 100, C: 600, D: 100, E: 100, F: 100, G: 100, H: 100, I: 100 });
let crew9 = Array.from({ length: 25 }, (_, i) => W(`w${i + 1}`, `W${i + 1}`)).concat(DEPT_FILLER);
let result9 = AE.assignNight(crew9, zones9, settings);
let unassigned9 = crew9.filter(w => w.zonesAssignedTonight.length === 0);
let workersById9 = Object.fromEntries(crew9.map(w => [w.id, w]));
let suggestions9 = AE.suggestRedistribution(unassigned9, zones9, result9.assignments, workersById9, settings);
check("at least one redistribution suggestion made", suggestions9.length > 0);
check("heaviest eligible zone (C) is the first suggestion's target", suggestions9.length && suggestions9[0].zoneId === "C");

console.log("\nTest 11: mutual partner pairs stay together even with zero zone preferences");
let zones11 = AE.makeZones(Object.assign({}, ...["A", "B", "C", "D", "E", "F", "G", "H"].map(z => ({ [z]: 200 })), { I: 200 }));
let crew11 = Array.from({ length: 12 }, (_, i) => W(`n${i + 1}`, `NoPref${i + 1}`));
crew11 = crew11.concat([
  W("p1", "PairA1", { preferredPartners: ["p2"] }),
  W("p2", "PairA2", { preferredPartners: ["p1"] }),
  W("p3", "PairB1", { preferredPartners: ["p4"] }),
  W("p4", "PairB2", { preferredPartners: ["p3"] }),
], DEPT_FILLER);
let result11 = AE.assignNight(crew11, zones11, settings);
function together(ids, a, b) {
  return Object.values(ids).some(a_ => a_.workerIds.includes(a) && a_.workerIds.includes(b));
}
check("PairA1 and PairA2 end up in the same zone", together(result11.assignments, "p1", "p2"));
check("PairB1 and PairB2 end up in the same zone", together(result11.assignments, "p3", "p4"));

console.log("\nTest 20: fixed_department workers are always assigned to their department");
let zones20 = AE.makeZones(Object.assign({}, ...["A", "B", "C", "D", "E", "F", "G", "H"].map(z => ({ [z]: 200 })), { I: 200 }));
let frozenA = W("fz_a", "FrozenA", { fixedDepartment: "frozen" });
let frozenB = W("fz_b", "FrozenB", { fixedDepartment: "frozen" });
let filler20 = Array.from({ length: 16 }, (_, i) => W(`z20_${i}`, `Z20Filler${i}`));
let crew20 = [frozenA, frozenB].concat(filler20);
let result20 = AE.assignNight(crew20, zones20, settings);
check(
  "both fixed_department=frozen workers assigned to zone K",
  result20.assignments["K"].workerIds.length === 2 && result20.assignments["K"].workerIds.includes("fz_a") && result20.assignments["K"].workerIds.includes("fz_b")
);
check("Frozen shows fixed_department flag", result20.assignments["K"].flags.includes("fixed_department"));

console.log("\nTest 22: Dairy/Frozen hit fixed headcount via backfill when dedicated/rotation people fall short");
let zones22 = AE.makeZones(Object.assign({}, ...["A", "B", "C", "D", "E", "F", "G", "H"].map(z => ({ [z]: 100 })), { I: 100 }));
let crew22 = Array.from({ length: 20 }, (_, i) => W(`w22_${i + 1}`, `W22_${i + 1}`));
let result22 = AE.assignNight(crew22, zones22, settings);
check("Dairy hits target headcount of 3 via backfill", result22.assignments["J"].workerIds.length === 3);
check("Frozen hits target headcount of 2 via backfill", result22.assignments["K"].workerIds.length === 2);
check("Dairy shows backfill flag", result22.assignments["J"].flags.includes("fixed_department_backfill"));
check("Frozen shows backfill flag", result22.assignments["K"].flags.includes("fixed_department_backfill"));

console.log("\nTest 23: a locked pair stays together despite conflicting individual zone preferences");
let zones23 = AE.makeZones({ A: 150, B: 150, C: 400, D: 210, E: 190, F: 170, G: 160, H: 90, I: 300 });
let lockA = W("lock_a", "LockA", { preferredZones: ["A"], lockedWith: ["lock_b"] });
let lockB = W("lock_b", "LockB", { preferredZones: ["B"] });
let filler23a = [1, 2].map(i => W(`z23a_${i}`, `Z23FillerA${i}`, { preferredZones: ["A"] }));
let filler23b = [1, 2].map(i => W(`z23b_${i}`, `Z23FillerB${i}`, { preferredZones: ["B"] }));
let crew23 = [lockA, lockB].concat(filler23a, filler23b, DEPT_FILLER);
let result23 = AE.assignNight(crew23, zones23, settings);
let together23 = Object.values(result23.assignments).some(a => a.workerIds.includes("lock_a") && a.workerIds.includes("lock_b"));
check("LockA and LockB end up in the same zone", together23);

console.log("\nTest 26: stack_leftover donor selection avoids struggling zone (via full assignNight scenario)");
// A minimal short-staffed scenario built to reproduce the "two new hires
// tripled up" bug pattern: force a struggling pair into one zone, then make
// sure other empty zones don't repeatedly pile onto them when a
// non-struggling option exists.
let zones26 = AE.makeZones({ A: 50, B: 50, C: 50, D: 50, E: 50, F: 50, G: 50, H: 50, I: 50 });
let newA = W("newA", "NewA", { productionRating: "new" });
let newB = W("newB", "NewB", { productionRating: "new" });
let onA = W("onA", "OnA");
let onB = W("onB", "OnB");
let onC = W("onC", "OnC");
let onD = W("onD", "OnD");
let crew26 = [newA, newB, onA, onB, onC, onD];
let result26 = AE.assignNight(crew26, zones26, settings);
let strugglingZone26 = Object.entries(result26.assignments).find(([zid, a]) => a.workerIds.includes("newA") && a.workerIds.includes("newB"));
let newAZoneCount = 0;
for (const a of Object.values(result26.assignments)) if (a.workerIds.includes("newA")) newAZoneCount++;
check("new hires are not stacked across more than 2 zones total tonight", newAZoneCount <= 2);

console.log(`\n${"=".repeat(40)}\n${passed} passed, ${failed} failed\n${"=".repeat(40)}`);
process.exit(failed ? 1 : 0);
