"""
Lightweight assertion-based checks (no pytest dependency) validating the
behaviors called out in design doc §8. Run directly: python3 test_assignment_engine.py
"""
from assignment_engine import Worker, Settings, Rating, make_zones, assign_night, suggest_redistribution, apply_redistribution

passed = 0
failed = 0

def check(label, cond):
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS  {label}")
    else:
        failed += 1
        print(f"  FAIL  {label}")


# Dairy/Frozen now hard-guarantee their headcount (3 and 2) via backfill from
# whoever's cheapest to pull by id (see assign_fixed_departments, §8 Step
# 0.5) — that's a real, deliberate behavior, but it means *every* test crew
# below is now implicitly 5 people short for whatever it was actually trying
# to test, unless something else is on the roster to absorb that draw first.
# DEPT_FILLER's ids start with "0" specifically so they always sort before
# any test-subject id in this file (digits sort before letters), guaranteeing
# they're who gets pulled — not the workers a given test is actually
# checking. Reused across tests; each assign_night() call resets
# hours_assigned_tonight/zones_assigned_tonight itself, so sharing the same
# Worker objects is safe.
DEPT_FILLER = [Worker(f"0dept{i}", f"DeptFiller{i}") for i in range(1, 6)]


print("Test 1: mutual partners end up together when both prefer the same zone")
settings = Settings(case_per_minute_rate=1.0)
zones = make_zones({"A": 150, "B": 180, "C": 400, "D": 210, "E": 190, "F": 170, "G": 160, "H": 90, "I": 300})
workers = [
    Worker("w1", "Alex", preferred_zones=["C"], preferred_partners=["w2"]),
    Worker("w2", "Brianna", preferred_zones=["C"], preferred_partners=["w1"]),
    Worker("w3", "Chris", preferred_zones=["A"]),
    Worker("w4", "Dana", preferred_zones=["A"]),
] + DEPT_FILLER
result = assign_night(workers, zones, settings)
c_assignment = result.assignments["C"]
check("Alex and Brianna both in zone C", set(c_assignment.worker_ids) == {"w1", "w2"})

print("\nTest 2: juice zone workload_hours ignores case count (fixed duration)")
zones2 = make_zones({z: 100 for z in "ABCDEFGH"} | {"I": 5000})  # absurd case count for I
workers2 = [Worker(f"w{i}", f"W{i}") for i in range(1, 19)] + DEPT_FILLER
result2 = assign_night(workers2, zones2, settings)
i_assignment = result2.assignments["I"]
check(f"Zone I workload_hours == juice_fixed_duration_hours ({settings.juice_fixed_duration_hours})",
      abs(i_assignment.workload_hours - settings.juice_fixed_duration_hours) < 0.001)

print("\nTest 3: group size never exceeds max_group_size even under heavy load")
zones3 = make_zones({"A": 5000, "B": 100, "C": 100, "D": 100, "E": 100, "F": 100, "G": 100, "H": 100, "I": 100})
workers3 = [Worker(f"w{i}", f"W{i}") for i in range(1, 30)]
result3 = assign_night(workers3, zones3, settings)
a_assignment = result3.assignments["A"]
check(f"Zone A group size <= max_group_size ({settings.max_group_size})",
      len(a_assignment.worker_ids) <= settings.max_group_size)

print("\nTest 4: fully-staffed, light-load night reports zero shortfall")
result4 = assign_night(workers2, zones2, settings)  # 18 workers + dept filler, 9 light zones
check("shortfall_hours == 0", result4.shortfall_hours < 0.001)

print("\nTest 5: severe under-staffing produces a non-zero, reported shortfall")
zones5 = make_zones({z: 400 for z in "ABCDEFGH"} | {"I": 500})
workers5 = [Worker(f"w{i}", f"W{i}") for i in range(1, 5)] + DEPT_FILLER  # only 4 real workers, 9 heavy zones
result5 = assign_night(workers5, zones5, settings)
check("shortfall_hours > 0", result5.shortfall_hours > 0)
check("a shortfall note was generated", any("Short-staffed" in n for n in result5.notes))

print("\nTest 6: every zone gets *some* assignment attempt (no crash, no silently skipped zone)")
check("all 11 zones present in assignments dict (9 grocery/juice + Dairy + Frozen)",
      set(result5.assignments.keys()) == {"A","B","C","D","E","F","G","H","I","J","K"})

print("\nTest 7: incompatible workers never end up in the same group, even short-staffed")
settings7 = Settings(case_per_minute_rate=1.0)
zones7 = make_zones({z: 150 for z in "ABCDEFGH"} | {"I": 300})
w_bad1 = Worker("bad1", "Nobody-likes-me", incompatible_with=["bad2"])
w_bad2 = Worker("bad2", "TheOtherGuy")
few = [w_bad1, w_bad2, Worker("w3", "Filler1"), Worker("w4", "Filler2")] + DEPT_FILLER
result7 = assign_night(few, zones7, settings7)
violation = False
for a in result7.assignments.values():
    if "bad1" in a.worker_ids and "bad2" in a.worker_ids:
        violation = True
check("bad1 and bad2 never share a zone despite being short-staffed", not violation)

print("\nTest 8: 1st choice beats 2nd choice when they compete for the same zone")
settings8 = Settings(case_per_minute_rate=1.0)
zones8 = make_zones({z: 100 for z in "ABCDEFGH"} | {"I": 100})
# both want zone A as their top choice; only room for 2 there by default sizing
w_first = Worker("f1", "FirstChoicer", preferred_zones=["A", "B"])
w_second = Worker("f2", "SecondChoicer", preferred_zones=["B", "A"])  # A is only 2nd choice
w_second2 = Worker("f3", "SecondChoicer2", preferred_zones=["B", "A"])
filler = [Worker(f"x{i}", f"Filler{i}") for i in range(1, 14)]
crew = [w_first, w_second, w_second2] + filler + DEPT_FILLER
result8 = assign_night(crew, zones8, settings8)
a_zone = result8.assignments["A"]
check("worker whose #1 choice is A gets placed in A", "f1" in a_zone.worker_ids)

print("\nTest 9: redistribution suggests heaviest eligible zone for unassigned workers")
settings9 = Settings(case_per_minute_rate=1.0)
zones9 = make_zones({"A": 100, "B": 100, "C": 600, "D": 100, "E": 100, "F": 100, "G": 100, "H": 100, "I": 100})  # C targets 3, not maxed at 4, so it stays eligible for redistribution
crew9 = [Worker(f"w{i}", f"W{i}") for i in range(1, 26)] + DEPT_FILLER  # 25 real workers, only 20 needed by target sizing -> 5 spare
result9 = assign_night(crew9, zones9, settings9)
unassigned9 = [w for w in crew9 if not w.zones_assigned_tonight]
workers_by_id9 = {w.id: w for w in crew9}
suggestions9 = suggest_redistribution(unassigned9, zones9, result9.assignments, workers_by_id9, settings9)
check("at least one redistribution suggestion made", len(suggestions9) > 0)
check("heaviest eligible zone (C) is the first suggestion's target",
      suggestions9[0].zone_id == "C" if suggestions9 else False)

print("\nTest 10: redistribution never violates max_group_size or incompatibility")
over_size = any(
    len([s for s in suggestions9 if s.zone_id == zid]) + len(result9.assignments[zid].worker_ids) > settings9.max_group_size
    for zid in {s.zone_id for s in suggestions9}
)
check("no suggested zone would exceed max_group_size", not over_size)

print("\nTest 11: mutual partner pairs stay together even with zero zone preferences")
# regression test for the bug found via the real roster: when nobody has
# preferred_zones set, a zone's first pick has no group to score against,
# so mutual pairs could get silently split by list-order luck.
settings11 = Settings(case_per_minute_rate=1.0)
zones11 = make_zones({z: 200 for z in "ABCDEFGH"} | {"I": 200})
crew11 = [Worker(f"n{i}", f"NoPref{i}") for i in range(1, 13)]  # 12 generic no-preference workers
crew11 += [
    Worker("p1", "PairA1", preferred_partners=["p2"]),
    Worker("p2", "PairA2", preferred_partners=["p1"]),
    Worker("p3", "PairB1", preferred_partners=["p4"]),
    Worker("p4", "PairB2", preferred_partners=["p3"]),
] + DEPT_FILLER
result11 = assign_night(crew11, zones11, settings11)
by_zone11 = {zid: set(a.worker_ids) for zid, a in result11.assignments.items()}
def together(a, b):
    return any(a in ids and b in ids for ids in by_zone11.values())
check("PairA1 and PairA2 end up in the same zone", together("p1", "p2"))
check("PairB1 and PairB2 end up in the same zone", together("p3", "p4"))

print("\nTest 12: a mutual pair WITH a stated zone preference gets that zone, not just the heaviest one")
# regression test for a Phase-0 bug: seeding mutual pairs together (heaviest
# zone first) must NOT override a pair's actual stated zone preference.
settings12 = Settings(case_per_minute_rate=1.0)
zones12 = make_zones({"A": 150, "B": 180, "C": 400, "D": 210, "E": 190, "F": 170, "G": 160, "H": 90, "I": 300})
crew12 = [
    Worker("m1", "Mutual1", preferred_zones=["C"], preferred_partners=["m2"]),
    Worker("m2", "Mutual2", preferred_zones=["C"], preferred_partners=["m1"]),
    Worker("s1", "AlsoWantsC1", preferred_zones=["C"]),
    Worker("s2", "AlsoWantsC2", preferred_zones=["C"]),
] + [Worker(f"y{i}", f"Filler{i}") for i in range(1, 15)] + DEPT_FILLER
result12 = assign_night(crew12, zones12, settings12)
c12 = result12.assignments["C"]
check("Mutual1 and Mutual2 (their stated #1 choice) both land in zone C, not a filler zone",
      "m1" in c12.worker_ids and "m2" in c12.worker_ids)

print("\nTest 13: a worker stacked across multiple zones has their cap overage counted once, not once per zone")
# regression test: compute_shortfall used to sum a stacked worker's overage
# once per zone they appeared in, wildly inflating the reported total.
from assignment_engine import compute_shortfall
settings13 = Settings(case_per_minute_rate=1.0)
zones13 = make_zones({z: 300 for z in "ABCDEFGH"} | {"I": 300})
crew13 = [Worker(f"w{i}", f"W{i}") for i in range(1, 3)] + DEPT_FILLER  # just 2 real workers, 9 zones -> heavy stacking
result13 = assign_night(crew13, zones13, settings13)
workers_by_id13 = {w.id: w for w in crew13}
shortfall13, affected13, over_by_worker13 = compute_shortfall(result13.assignments, workers_by_id13, settings13)
real_crew13 = [w for w in crew13 if w not in DEPT_FILLER]
manual_total13 = sum(max(0.0, w.hours_assigned_tonight - settings13.max_zone_hours_per_worker) for w in real_crew13)
check("reported shortfall total matches the sum of each worker's own overage (not multiplied per zone)",
      abs(shortfall13 - manual_total13) < 0.001)
check("shortfall total is not absurdly larger than any single worker's overage (would indicate double-counting)",
      shortfall13 <= manual_total13 + 0.001)

print("\nTest 14: a very light pair gets stacked onto a significantly heavier zone to balance the night")
settings14 = Settings(case_per_minute_rate=1.0)
zones14 = make_zones({"A": 40, "B": 500, "C": 100, "D": 100, "E": 100, "F": 100, "G": 100, "H": 100, "I": 100})
crew14 = [
    Worker("a1", "A1", preferred_zones=["A"]),
    Worker("a2", "A2", preferred_zones=["A"]),
    Worker("b1", "B1", preferred_zones=["B"]),
    Worker("b2", "B2", preferred_zones=["B"]),
]
for z in "CDEFGH":
    crew14.append(Worker(f"{z}1", f"{z}1", preferred_zones=[z]))
    crew14.append(Worker(f"{z}2", f"{z}2", preferred_zones=[z]))
crew14.append(Worker("i1", "I1", preferred_zones=["I"]))
crew14.append(Worker("i2", "I2", preferred_zones=["I"]))
crew14 += DEPT_FILLER
result14 = assign_night(crew14, zones14, settings14)
a_result14 = result14.assignments["A"]
b_result14 = result14.assignments["B"]
check("the very light pair (A1/A2) got lent out to help the much heavier zone B",
      "a1" in b_result14.worker_ids or "a2" in b_result14.worker_ids)
check("zone A still shows the 'lent_to_heavier_zone' flag",
      "lent_to_heavier_zone" in a_result14.flags)
check("nobody exceeds max_group_size on the heavy zone after balancing",
      len(b_result14.worker_ids) <= settings14.max_group_size)

print("\nTest 15: a struggling zone gets redistribution priority over a numerically heavier zone")
from assignment_engine import Zone, Assignment, STRUGGLE_FLAG
settings15 = Settings(case_per_minute_rate=1.0)
zone_a15 = Zone("A", "2 & 3", "grocery", case_count=80)
zone_b15 = Zone("B", "4 & 5", "grocery", case_count=300)
zones15 = [zone_a15, zone_b15]
a1_15, a2_15 = Worker("a1", "A1"), Worker("a2", "A2")
b1_15, b2_15 = Worker("b1", "B1"), Worker("b2", "B2")
extra15 = Worker("extra", "Extra")
workers_by_id15 = {w.id: w for w in [a1_15, a2_15, b1_15, b2_15, extra15]}
assignments15 = {
    "A": Assignment(zone_id="A", worker_ids=["a1", "a2"], workload_hours=0.67, flags=[STRUGGLE_FLAG]),
    "B": Assignment(zone_id="B", worker_ids=["b1", "b2"], workload_hours=2.5, flags=[]),
}
suggestions15 = suggest_redistribution([extra15], zones15, assignments15, workers_by_id15, settings15)
check("the extra worker is suggested for the struggling zone (A), not the merely-heavier zone (B)",
      len(suggestions15) == 1 and suggestions15[0].zone_id == "A")

print("\nTest 16: needs_improvement + new avoided when any other candidate exists, on-pace people preferred")
settings16 = Settings(case_per_minute_rate=1.0)
zones16 = make_zones({z: 150 for z in "ABCDEFGH"} | {"I": 150})
crew16 = [
    Worker("slow", "Slow", production_rating=Rating.NEEDS_IMPROVEMENT),
    Worker("newb", "Newb", production_rating=Rating.NEW),
] + [Worker(f"op{i}", f"OnPace{i}", production_rating=Rating.ON_PACE) for i in range(1, 17)] + DEPT_FILLER
result16 = assign_night(crew16, zones16, settings16)
workers_by_id16 = {w.id: w for w in crew16}
mismatch16 = False
for a in result16.assignments.values():
    ratings = {workers_by_id16[wid_].production_rating for wid_ in a.worker_ids}
    if Rating.NEEDS_IMPROVEMENT in ratings and Rating.NEW in ratings:
        mismatch16 = True
check("Slow (needs_improvement) and Newb (new) end up in different zones when 16 on-pace alternates exist",
      not mismatch16)

print("\nTest 17: clustered underperformers get split up across capable zones instead of dumped together")
settings17 = Settings(case_per_minute_rate=1.0)
zones17 = make_zones({"A": 520, "B": 263, "C": 91, "D": 482, "E": 494, "F": 189, "G": 260, "H": 421, "I": 399})
on_pace17 = [Worker(f"op{i}", f"OnPace{i}", production_rating=Rating.ON_PACE) for i in range(16)]
new17 = [Worker(f"nh{i}", f"New{i}", production_rating=Rating.NEW) for i in range(8)]
crew17 = on_pace17 + new17 + DEPT_FILLER
result17 = assign_night(crew17, zones17, settings17)
workers_by_id17 = {w.id: w for w in crew17}
clustered17 = [
    zid for zid, a in result17.assignments.items()
    if sum(1 for wid_ in a.worker_ids if workers_by_id17[wid_].production_rating != Rating.ON_PACE) >= 2
]
check("no zone ends up with 2+ new/needs_improvement workers clustered together, given enough on-pace donors",
      len(clustered17) == 0)
check("every new hire has at least one on_pace teammate",
      all(any(m.production_rating == Rating.ON_PACE for m in
              [workers_by_id17[wid_] for wid_ in a.worker_ids])
          for a in result17.assignments.values() if a.worker_ids))

print("\nTest 18: anchor-swap tries the NEXT donor zone when the first one is blocked, instead of giving up")
# regression test for the Vayne bug: a struggling zone must still get
# anchored even when the first-found donor zone contains an
# unsuitable_for_new_hires worker who blocks every possible struggler —
# the search has to move on to the next eligible donor zone rather than
# abandoning the whole pass.
from assignment_engine import Zone, Assignment, STRUGGLE_FLAG, anchor_struggling_zones
settings18 = Settings(case_per_minute_rate=1.0)
zone_a18 = Zone("A", "2 & 3", "grocery", case_count=200)
zone_b18 = Zone("B", "4 & 5", "grocery", case_count=200)
zone_c18 = Zone("C", "6 & 7", "grocery", case_count=200)
zones18 = [zone_a18, zone_b18, zone_c18]
new1_18 = Worker("new1", "New1", production_rating=Rating.NEW)
new2_18 = Worker("new2", "New2", production_rating=Rating.NEW)
vayne18 = Worker("vayne18", "VayneLike", unsuitable_for_new_hires=True)
skyler18 = Worker("skyler18", "SkylerLike")
d2a18 = Worker("d2a18", "Donor2A")
d2b18 = Worker("d2b18", "Donor2B")
workers_by_id18 = {w.id: w for w in [new1_18, new2_18, vayne18, skyler18, d2a18, d2b18]}
assignments18 = {
    "A": Assignment(zone_id="A", worker_ids=["new1", "new2"], workload_hours=1.0, flags=[STRUGGLE_FLAG]),
    "B": Assignment(zone_id="B", worker_ids=["vayne18", "skyler18"], workload_hours=1.0),
    "C": Assignment(zone_id="C", worker_ids=["d2a18", "d2b18"], workload_hours=1.0),
}
anchor_struggling_zones(zones18, assignments18, workers_by_id18, settings18)
check("zone A got anchored with an on_pace worker from zone C (not left clustered)",
      any(wid_ in ("d2a18", "d2b18") for wid_ in assignments18["A"].worker_ids))
check("zone B (blocked by VayneLike) was left untouched, since it had no valid swap",
      set(assignments18["B"].worker_ids) == {"vayne18", "skyler18"})
check("zone A no longer flagged as struggling",
      STRUGGLE_FLAG not in assignments18["A"].flags)

print("\nTest 19: anchor-swap prefers not breaking a bonded donor pair when an unbonded donor is available")
settings19 = Settings(case_per_minute_rate=1.0)
zone_a19 = Zone("A", "2 & 3", "grocery", case_count=200)
zone_b19 = Zone("B", "4 & 5", "grocery", case_count=200)
zone_c19 = Zone("C", "6 & 7", "grocery", case_count=200)
zones19 = [zone_a19, zone_b19, zone_c19]
new1_19 = Worker("new1_19", "New1", production_rating=Rating.NEW)
new2_19 = Worker("new2_19", "New2", production_rating=Rating.NEW)
mutual_a19 = Worker("ma19", "MutualA", preferred_partners=["mb19"])
mutual_b19 = Worker("mb19", "MutualB", preferred_partners=["ma19"])
plain_c1_19 = Worker("pc1_19", "PlainC1")
plain_c2_19 = Worker("pc2_19", "PlainC2")
workers_by_id19 = {w.id: w for w in [new1_19, new2_19, mutual_a19, mutual_b19, plain_c1_19, plain_c2_19]}
assignments19 = {
    "A": Assignment(zone_id="A", worker_ids=["new1_19", "new2_19"], workload_hours=1.0, flags=[STRUGGLE_FLAG]),
    "B": Assignment(zone_id="B", worker_ids=["ma19", "mb19"], workload_hours=1.0),
    "C": Assignment(zone_id="C", worker_ids=["pc1_19", "pc2_19"], workload_hours=1.0),
}
anchor_struggling_zones(zones19, assignments19, workers_by_id19, settings19)
check("the bonded mutual pair (MutualA/MutualB) stays together in zone B, untouched",
      set(assignments19["B"].worker_ids) == {"ma19", "mb19"})
check("the unbonded pair in zone C was used to anchor zone A instead",
      any(wid_ in ("pc1_19", "pc2_19") for wid_ in assignments19["A"].worker_ids))

print("\nTest 20: fixed_department workers are always assigned to their department, every night")
settings20 = Settings(case_per_minute_rate=1.0)
zones20 = make_zones({z: 200 for z in "ABCDEFGH"} | {"I": 200})
frozen_a = Worker("fz_a", "FrozenA", fixed_department="frozen")
frozen_b = Worker("fz_b", "FrozenB", fixed_department="frozen")
filler20 = [Worker(f"z20_{i}", f"Z20Filler{i}") for i in range(16)]
crew20 = [frozen_a, frozen_b] + filler20
result20 = assign_night(crew20, zones20, settings20)
frozen_assignment20 = result20.assignments["K"]
check("both fixed_department=frozen workers are assigned to zone K (Frozen)",
      set(frozen_assignment20.worker_ids) == {"fz_a", "fz_b"})
check("Frozen shows the fixed_department flag",
      "fixed_department" in frozen_assignment20.flags)

print("\nTest 21: department_rotation_pool picks exactly the fixed headcount, and rotates deterministically by rotation_key")
settings21 = Settings(case_per_minute_rate=1.0)
dairy_pool_ids = ["dp0", "dp1", "dp2", "dp3"]

def _make_crew21():
    pool = [Worker(i, f"DairyPool{i}", department_rotation_pool="dairy") for i in dairy_pool_ids]
    filler = [Worker(f"z21_{i}", f"Z21Filler{i}") for i in range(16)]
    return pool + filler

zones21a = make_zones({z: 200 for z in "ABCDEFGH"} | {"I": 200})
result21a = assign_night(_make_crew21(), zones21a, settings21, rotation_key=0)
dairy_a = set(result21a.assignments["J"].worker_ids)
check("exactly 3 of the 4-person dairy pool assigned tonight (headcount is 3)", len(dairy_a) == 3)
check("all 3 picked are actually from the dairy pool", dairy_a <= set(dairy_pool_ids))

zones21b = make_zones({z: 200 for z in "ABCDEFGH"} | {"I": 200})
result21b = assign_night(_make_crew21(), zones21b, settings21, rotation_key=1)
dairy_b = set(result21b.assignments["J"].worker_ids)
check("a different rotation_key picks a different subset (someone's turn changed)",
      dairy_a != dairy_b)

print("\nTest 22: Dairy/Frozen still hit their fixed headcount via backfill from the general pool when the dedicated/rotation people fall short")
settings22 = Settings(case_per_minute_rate=1.0)
zones22 = make_zones({z: 100 for z in "ABCDEFGH"} | {"I": 100})
crew22 = [Worker(f"w22_{i}", f"W22_{i}") for i in range(1, 21)]  # nobody has fixed_department or department_rotation_pool set
result22 = assign_night(crew22, zones22, settings22)
check("Dairy (zone J) still hits its target headcount of 3 via backfill", len(result22.assignments["J"].worker_ids) == 3)
check("Frozen (zone K) still hits its target headcount of 2 via backfill", len(result22.assignments["K"].worker_ids) == 2)
check("Dairy shows the backfill flag", "fixed_department_backfill" in result22.assignments["J"].flags)
check("Frozen shows the backfill flag", "fixed_department_backfill" in result22.assignments["K"].flags)
check("a note mentions Dairy needed help from the general pool",
      any("Dairy" in n and "general pool" in n for n in result22.notes))
check("a note mentions Frozen needed help from the general pool",
      any("Frozen" in n and "general pool" in n for n in result22.notes))

print("\nTest 23: a locked pair stays together even when they state different individual zone preferences")
settings23 = Settings(case_per_minute_rate=1.0)
zones23 = make_zones({"A": 150, "B": 150, "C": 400, "D": 210, "E": 190, "F": 170, "G": 160, "H": 90, "I": 300})
lock_a = Worker("lock_a", "LockA", preferred_zones=["A"], locked_with=["lock_b"])
lock_b = Worker("lock_b", "LockB", preferred_zones=["B"])  # conflicting preference; lock is checked bidirectionally
filler23a = [Worker(f"z23a_{i}", f"Z23FillerA{i}", preferred_zones=["A"]) for i in range(1, 3)]
filler23b = [Worker(f"z23b_{i}", f"Z23FillerB{i}", preferred_zones=["B"]) for i in range(1, 3)]
crew23 = [lock_a, lock_b] + filler23a + filler23b + DEPT_FILLER
result23 = assign_night(crew23, zones23, settings23)
by_zone23 = {zid: set(a.worker_ids) for zid, a in result23.assignments.items()}
together23 = any({"lock_a", "lock_b"} <= ids for ids in by_zone23.values())
check("LockA and LockB end up in the same zone despite conflicting individual zone preferences", together23)

print("\nTest 24: a hard-locked pair is never split apart by the anchor-swap pass, even as the only possible donor")
settings24 = Settings(case_per_minute_rate=1.0)
zone_a24 = Zone("A", "2 & 3", "grocery", case_count=200)
zone_b24 = Zone("B", "4 & 5", "grocery", case_count=200)
zones24 = [zone_a24, zone_b24]
new1_24 = Worker("new1_24", "New1", production_rating=Rating.NEW)
new2_24 = Worker("new2_24", "New2", production_rating=Rating.NEW)
lock_c = Worker("lock_c", "LockC", locked_with=["lock_d"])
lock_d = Worker("lock_d", "LockD")
workers_by_id24 = {w.id: w for w in [new1_24, new2_24, lock_c, lock_d]}
assignments24 = {
    "A": Assignment(zone_id="A", worker_ids=["new1_24", "new2_24"], workload_hours=1.0, flags=[STRUGGLE_FLAG]),
    "B": Assignment(zone_id="B", worker_ids=["lock_c", "lock_d"], workload_hours=1.0),
}
anchor_struggling_zones(zones24, assignments24, workers_by_id24, settings24)
check("the locked pair (LockC/LockD) stays together in zone B, untouched",
      set(assignments24["B"].worker_ids) == {"lock_c", "lock_d"})
check("zone A remains flagged struggling since the only donor was a locked pair with no valid swap",
      STRUGGLE_FLAG in assignments24["A"].flags)

print("\nTest 25: when the whole crew is too small to hit both fixed-department targets, Dairy/Frozen get as many people as exist and are flagged understaffed rather than silently short")
settings25 = Settings(case_per_minute_rate=1.0)
zones25 = make_zones({z: 100 for z in "ABCDEFGH"} | {"I": 100})
crew25 = [Worker(f"w25_{i}", f"W25_{i}") for i in range(1, 3)]  # only 2 workers total tonight, Dairy alone needs 3
result25 = assign_night(crew25, zones25, settings25)
total_dairy_frozen25 = len(result25.assignments["J"].worker_ids) + len(result25.assignments["K"].worker_ids)
check("every available worker gets pulled toward fixed departments before anything else runs",
      total_dairy_frozen25 == 2)
check("the zone that couldn't reach target is flagged understaffed rather than silently short",
      "fixed_department_understaffed" in result25.assignments["J"].flags
      or "fixed_department_understaffed" in result25.assignments["K"].flags)

print("\nTest 26: stack_leftover_zones prefers a non-struggling donor over a cheaper struggling one")
# regression test for the "two new hires get tripled up" bug: a struggling
# zone (nobody senior to anchor it) must never be picked as a stacking
# donor just because its raw average hours happen to be the cheapest —
# piling more work onto the most vulnerable pair is exactly backwards.
from assignment_engine import stack_leftover_zones
settings26 = Settings(case_per_minute_rate=1.0)
zone_struggling26 = Zone("A", "2 & 3", "grocery", case_count=100)
zone_normal26 = Zone("B", "4 & 5", "grocery", case_count=100)
zone_leftover26 = Zone("C", "6 & 7", "grocery", case_count=100)
zones26 = [zone_struggling26, zone_normal26, zone_leftover26]
s1_26, s2_26 = Worker("s1_26", "S1", production_rating=Rating.NEW), Worker("s2_26", "S2", production_rating=Rating.NEW)
n1_26, n2_26 = Worker("n1_26", "N1"), Worker("n2_26", "N2")
for w in (s1_26, s2_26):
    w.hours_assigned_tonight = 1.0  # cheap — would normally look like the best donor
for w in (n1_26, n2_26):
    w.hours_assigned_tonight = 3.0  # pricier, but not struggling
workers_by_id26 = {w.id: w for w in [s1_26, s2_26, n1_26, n2_26]}
assignments26 = {
    "A": Assignment(zone_id="A", worker_ids=["s1_26", "s2_26"], workload_hours=1.0, flags=[STRUGGLE_FLAG]),
    "B": Assignment(zone_id="B", worker_ids=["n1_26", "n2_26"], workload_hours=3.0, flags=[]),
    "C": Assignment(zone_id="C", worker_ids=[], workload_hours=0.0, flags=[]),
}
stack_leftover_zones(zones26, assignments26, workers_by_id26, settings26)
check("leftover zone C got staffed by the non-struggling donor (B), not the cheaper struggling one (A)",
      set(assignments26["C"].worker_ids) == {"n1_26", "n2_26"})
check("the struggling zone (A) was left untouched, not piled on further",
      set(assignments26["A"].worker_ids) == {"s1_26", "s2_26"})

print("\nTest 27: stack_leftover_zones spreads sequential-stacking duty across different donors instead of reusing the same one")
settings27 = Settings(case_per_minute_rate=1.0)
zone_d1_27 = Zone("A", "2 & 3", "grocery", case_count=100)
zone_d2_27 = Zone("B", "4 & 5", "grocery", case_count=100)
zone_l1_27 = Zone("C", "6 & 7", "grocery", case_count=100)
zone_l2_27 = Zone("D", "8 & 9", "grocery", case_count=100)
zones27 = [zone_d1_27, zone_d2_27, zone_l1_27, zone_l2_27]
d1a_27, d1b_27 = Worker("d1a_27", "D1A"), Worker("d1b_27", "D1B")
d2a_27, d2b_27 = Worker("d2a_27", "D2A"), Worker("d2b_27", "D2B")
for w in (d1a_27, d1b_27):
    w.hours_assigned_tonight = 1.0  # cheapest — the natural first pick
for w in (d2a_27, d2b_27):
    w.hours_assigned_tonight = 5.0  # pricier, but the only other option
workers_by_id27 = {w.id: w for w in [d1a_27, d1b_27, d2a_27, d2b_27]}
assignments27 = {
    "A": Assignment(zone_id="A", worker_ids=["d1a_27", "d1b_27"], workload_hours=1.0, flags=[]),
    "B": Assignment(zone_id="B", worker_ids=["d2a_27", "d2b_27"], workload_hours=5.0, flags=[]),
    "C": Assignment(zone_id="C", worker_ids=[], workload_hours=0.0, flags=[]),
    "D": Assignment(zone_id="D", worker_ids=[], workload_hours=0.0, flags=[]),
}
stack_leftover_zones(zones27, assignments27, workers_by_id27, settings27)
check("the first leftover zone (C) got the cheapest donor (A)",
      set(assignments27["C"].worker_ids) == {"d1a_27", "d1b_27"})
check("the second leftover zone (D) got the OTHER donor (B), not a repeat of A",
      set(assignments27["D"].worker_ids) == {"d2a_27", "d2b_27"})

print("\nTest 28: rebalance_overstaffed_zones lends a single spare hand from an overstaffed zone to the heaviest zone")
# regression test for the "Aisle 8&9 has 4 people at 2.2h while another zone
# sits at 5+" bug: Step 2.4's group-growth pass can leave a zone overstaffed
# relative to how the rest of the night turns out, with nothing to un-grow
# it. This pass should notice and move one person across.
from assignment_engine import rebalance_overstaffed_zones, workload_hours_for
settings28 = Settings(case_per_minute_rate=1.0)
zone_heavy28 = Zone("A", "2 & 3", "grocery", case_count=600)   # 10h total -> 5.0h/person at 2 workers, well over the 4h target
zone_light28 = Zone("B", "4 & 5", "grocery", case_count=400)   # 6.67h total -> 1.67h/person at 4 workers, well under target
zones28 = [zone_heavy28, zone_light28]
h1_28, h2_28 = Worker("h1_28", "H1"), Worker("h2_28", "H2")
l1_28, l2_28, l3_28, l4_28 = (Worker(f"l{i}_28", f"L{i}") for i in range(1, 5))
heavy_group28 = [h1_28, h2_28]
light_group28 = [l1_28, l2_28, l3_28, l4_28]
workers_by_id28 = {w.id: w for w in heavy_group28 + light_group28}
heavy_workload28 = workload_hours_for(zone_heavy28, heavy_group28, settings28)
light_workload28 = workload_hours_for(zone_light28, light_group28, settings28)
for w in heavy_group28:
    w.hours_assigned_tonight = heavy_workload28
for w in light_group28:
    w.hours_assigned_tonight = light_workload28
assignments28 = {
    "A": Assignment(zone_id="A", worker_ids=[w.id for w in heavy_group28], workload_hours=heavy_workload28),
    "B": Assignment(zone_id="B", worker_ids=[w.id for w in light_group28], workload_hours=light_workload28),
}
rebalance_overstaffed_zones(zones28, assignments28, workers_by_id28, settings28)
check("the heavy zone (A) gained a spare hand from the overstaffed zone (B)",
      len(assignments28["A"].worker_ids) == 3)
check("the overstaffed zone (B) still has at least a pair left, never dropped below 2",
      len(assignments28["B"].worker_ids) >= 2)
check("the heavy zone's workload actually decreased after the move",
      assignments28["A"].workload_hours < heavy_workload28)
check("both ends are flagged (lent_spare_hand / received_spare_hand), never a silent change",
      "lent_spare_hand" in assignments28["B"].flags and "received_spare_hand" in assignments28["A"].flags)

print("\nTest 29: rebalance_overstaffed_zones never pulls a spare hand out of a zone already flagged struggling")
settings29 = Settings(case_per_minute_rate=1.0)
zone_heavy29 = Zone("A", "2 & 3", "grocery", case_count=600)
zone_struggling29 = Zone("B", "4 & 5", "grocery", case_count=400)
zones29 = [zone_heavy29, zone_struggling29]
h1_29, h2_29 = Worker("h1_29", "H1"), Worker("h2_29", "H2")
new_workers29 = [Worker(f"nw{i}_29", f"NW{i}", production_rating=Rating.NEW) for i in range(1, 5)]
workers_by_id29 = {w.id: w for w in [h1_29, h2_29] + new_workers29}
heavy_workload29 = workload_hours_for(zone_heavy29, [h1_29, h2_29], settings29)
struggling_workload29 = workload_hours_for(zone_struggling29, new_workers29, settings29)
for w in (h1_29, h2_29):
    w.hours_assigned_tonight = heavy_workload29
for w in new_workers29:
    w.hours_assigned_tonight = struggling_workload29
assignments29 = {
    "A": Assignment(zone_id="A", worker_ids=["h1_29", "h2_29"], workload_hours=heavy_workload29),
    "B": Assignment(zone_id="B", worker_ids=[w.id for w in new_workers29], workload_hours=struggling_workload29,
                     flags=[STRUGGLE_FLAG]),
}
rebalance_overstaffed_zones(zones29, assignments29, workers_by_id29, settings29)
check("the struggling zone (B) is left untouched, all 4 members still there",
      len(assignments29["B"].worker_ids) == 4)
check("the heavy zone (A) got no help since its only numerically-light option was struggling",
      len(assignments29["A"].worker_ids) == 2)

print(f"\n{'='*40}\n{passed} passed, {failed} failed\n{'='*40}")

import sys
sys.exit(1 if failed else 0)
