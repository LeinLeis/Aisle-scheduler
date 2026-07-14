/**
 * Aisle Freight Scheduler — Assignment Algorithm (JavaScript port)
 *
 * Faithful, function-for-function port of assignment_engine.py so the
 * browser-based screens can run the real scheduling algorithm entirely
 * client-side — no server involved. Field names on Worker/Zone match the
 * camelCase schema already used by worker_roster.html's localStorage data
 * (preferredZones, preferredPartners, incompatibleWith, incompatibilityNotes,
 * productionRating, unsuitableForNewHires, lockedWith, fixedDepartment,
 * departmentRotationPool), so roster JSON can be consumed directly with no
 * transformation step.
 *
 * Every function here mirrors its Python counterpart in assignment_engine.py
 * one-to-one — same phases, same ordering, same flags/notes — so behavior
 * (including every regression fix from the Python test suite) carries over.
 *
 * ---------------------------------------------------------------------
 * Rule precedence — when two rules below pull in different directions,
 * this is the order that wins. Every pass in this file is written to
 * respect the rules above it, never just the one it's directly
 * implementing:
 *   1. Locked pairs are never split, and never bought at grocery's expense
 *      either. Hardest rule in the file — seeded into zones before
 *      anything else runs (fillZones), and every later pass that moves
 *      people around (backfill, rebalancing, the new-hire safety net, the
 *      light-aisle merge) checks isLockedPair first and refuses the move
 *      rather than break one. Dairy (3) and Frozen (2) are real
 *      commitments, not soft targets — every body they take beyond what
 *      they actually need is a body grocery didn't get, and grocery is
 *      the side that's chronically short. So if a locked pair can't fit
 *      together within a fixed department's actual open seats, neither
 *      department is forced to take them (as a broken half OR as
 *      overstaffing) — they're left for fillZones instead, where they'll
 *      most likely land together in grocery, and the fixed department
 *      just runs a seat short for the night (fixed_department_understaffed,
 *      never silent).
 *   2. Incompatibilities are never placed together (isIncompatible)  —
 *      equally hard, checked everywhere a group gets a new member.
 *   3. Nobody works truly alone if it can be avoided — a "new" hire never,
 *      a light aisle prefers merging with another light aisle into one
 *      shared team over leaving either as a solo assignment.
 *   4. Each zone's target hours (grocery's pre-lunch window, Juice's cap,
 *      Dairy/Frozen's fixed duration) are the thing every fill/grow/
 *      rebalance pass is aiming at once rules 1-3 are satisfied.
 *   5. Preferred zones and preferred partners are honored as soft
 *      tie-breakers wherever they don't conflict with anything above.
 * ---------------------------------------------------------------------
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AssignmentEngine = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MAX_ZONE_PREFERENCES = 3;
  const STRUGGLE_FLAG = "likely_to_struggle_multiple_underperformers";

  // ---------------------------------------------------------------------
  // Generic tuple-style comparator — mirrors Python's lexicographic tuple
  // comparison used everywhere a `key=lambda w: (...)` sort appears.
  // ---------------------------------------------------------------------
  function compareArrays(a, b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    return 0;
  }

  // ---------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------
  function makeSettings(overrides) {
    return Object.assign(
      {
        casePerMinuteRate: 1.0,
        maxZoneHoursPerWorker: 5.5,
        // Shift starts 10:20pm. Before the 2:00am lunch there's a 15-min
        // midnight break, so actual working time available is 100min
        // (10:20pm-12:00am) + 105min (12:15am-2:00am) = 205min = ~3h25m.
        // Grocery's target is pinned to that real pre-lunch window (not a
        // round number) so every balancing pass below — adaptive group
        // sizing, overstaffed/light-zone rebalancing — is all aiming at
        // "done before lunch" instead of an arbitrary 4-hour ceiling.
        groceryTargetHours: 205 / 60,
        maxGroupSize: 4,
        needsImprovementEfficiencyFactor: 0.75,
        newHireEfficiencyFactor: 0.5,
        // Water gallons in Infants and in the juice aisle itself don't come
        // in on the daily truck, so they never show up in a case count —
        // but juice workers still have to stock them, and it normally adds
        // about another hour on top of the juice aisle's own case-driven
        // workload. This is a flat addition, not divided across headcount —
        // it's roughly the same amount of physical restocking no matter how
        // many people are there to share it.
        juiceHiddenTaskHours: 1.0,
        // Hard ceiling on a juice worker's total night, hidden hour
        // included. Juice already eats most of a shift on its own, so this
        // leaves very little room for a second aisle — by design. This is
        // also juice's growth target: the algorithm adds people to juice
        // until its real computed time (case-driven + hidden hour) fits
        // under this number, same as grocery grows toward its own target.
        juiceMaxTotalHours: 5.0,
        dairyFixedDurationHours: 4.0,
        frozenFixedDurationHours: 4.0,
        lightLoadThreshold: 0.5,
      },
      overrides || {}
    );
  }

  function efficiency(settings, rating) {
    if (rating === "on_pace") return 1.0;
    if (rating === "needs_improvement") return settings.needsImprovementEfficiencyFactor;
    if (rating === "new") return settings.newHireEfficiencyFactor;
    return 1.0;
  }

  // ---------------------------------------------------------------------
  // Worker — normalizes a roster entry into the shape the algorithm needs,
  // plus per-night bookkeeping fields (hoursAssignedTonight,
  // zonesAssignedTonight), reset at the top of every assignNight() call.
  // ---------------------------------------------------------------------
  function makeWorker(w) {
    return {
      id: w.id,
      name: w.name,
      active: w.active !== false,
      preferredZones: (w.preferredZones || []).slice(0, MAX_ZONE_PREFERENCES),
      preferredPartners: w.preferredPartners || [],
      incompatibleWith: w.incompatibleWith || [],
      incompatibilityNotes: w.incompatibilityNotes || {},
      productionRating: w.productionRating || "on_pace",
      unsuitableForNewHires: !!w.unsuitableForNewHires,
      lockedWith: w.lockedWith || [],
      fixedDepartment: w.fixedDepartment || null,
      departmentRotationPool: w.departmentRotationPool || null,
      // Zones this worker is never placed in, full stop — a harder rule
      // than a preference, checked everywhere a worker gets a NEW zone
      // added to their night (fillZones, backfill, every rebalance/merge
      // pass). fixedDepartment/departmentRotationPool are trusted as
      // deliberate individual opt-ins and aren't re-checked against this
      // list — if both are set on the same worker that's a roster data
      // contradiction to fix at the source, not something the algorithm
      // second-guesses.
      excludedZones: w.excludedZones || [],
      hoursAssignedTonight: 0,
      zonesAssignedTonight: [],
    };
  }

  // ---------------------------------------------------------------------
  // Zone
  // ---------------------------------------------------------------------
  const ZONE_DEFS = [
    { id: "A", aisles: "2 & 3", department: "grocery", estimationMethod: "case_rate", fixedHeadcount: null },
    { id: "B", aisles: "4 & 5", department: "grocery", estimationMethod: "case_rate", fixedHeadcount: null },
    { id: "C", aisles: "6 & 7", department: "grocery", estimationMethod: "case_rate", fixedHeadcount: null },
    { id: "D", aisles: "8 & 9", department: "grocery", estimationMethod: "case_rate", fixedHeadcount: null },
    { id: "E", aisles: "10 & 11", department: "grocery", estimationMethod: "case_rate", fixedHeadcount: null },
    { id: "F", aisles: "12 & 13", department: "grocery", estimationMethod: "case_rate", fixedHeadcount: null },
    { id: "G", aisles: "14 & 15", department: "grocery", estimationMethod: "case_rate", fixedHeadcount: null },
    { id: "H", aisles: "19", department: "grocery", estimationMethod: "case_rate", fixedHeadcount: null },
    { id: "I", aisles: "20, 21 & 22", department: "juice", estimationMethod: "case_rate", fixedHeadcount: null },
    { id: "J", aisles: "Dairy", department: "dairy", estimationMethod: "fixed_duration", fixedHeadcount: 3 },
    { id: "K", aisles: "Frozen", department: "frozen", estimationMethod: "fixed_duration", fixedHeadcount: 2 },
  ];

  // Real-world habit, not just a hours calculation: Aisle 2(3) + Aisle 8(9)
  // (zones A + D) and Aisle 14(15) + Aisle 19 (zones G + H) are the pairs
  // that actually get doubled up on the floor on a short-staffed night —
  // they're light often enough, and close enough together, that a 3-person
  // team can realistically cover both. mergeLightSoloZones (Step 2.55)
  // reaches for one of these specific pairings first when a merge is
  // possible, before falling back to "whichever other light zone has the
  // least work" for anything outside these two known combos.
  const PREFERRED_LIGHT_MERGE_PAIRS = [
    ["A", "D"],
    ["G", "H"],
  ];
  function isPreferredMergePair(zid1, zid2) {
    return PREFERRED_LIGHT_MERGE_PAIRS.some(([x, y]) => (x === zid1 && y === zid2) || (x === zid2 && y === zid1));
  }

  function makeZones(caseCounts) {
    caseCounts = caseCounts || {};
    return ZONE_DEFS.map(z => Object.assign({}, z, { caseCount: caseCounts[z.id] || 0 }));
  }

  function zoneLabel(zone) {
    if (zone.department === "dairy" || zone.department === "frozen") return zone.aisles;
    return `Aisle ${zone.aisles}`;
  }

  function zoneTotalHours(zone, settings) {
    return zone.caseCount / settings.casePerMinuteRate / 60.0;
  }

  // ---------------------------------------------------------------------
  // Assignment record — one per zone per night
  // ---------------------------------------------------------------------
  function makeAssignment(zoneId) {
    return { zoneId, workerIds: [], workloadHours: 0, flags: [] };
  }
  function addFlag(a, text) {
    if (!a.flags.includes(text)) a.flags.push(text);
  }

  // ---------------------------------------------------------------------
  // Core hour math
  // ---------------------------------------------------------------------
  function effectiveCapacity(workers, settings) {
    return workers.reduce((sum, w) => sum + efficiency(settings, w.productionRating), 0);
  }

  function workloadHoursFor(zone, workers, settings) {
    if (zone.estimationMethod === "fixed_duration") {
      if (zone.department === "dairy") return settings.dairyFixedDurationHours;
      if (zone.department === "frozen") return settings.frozenFixedDurationHours;
    }
    const cap = workers.length ? effectiveCapacity(workers, settings) : 1.0;
    const caseDrivenHours = zoneTotalHours(zone, settings) / cap;
    // Juice's real workload is the truck/case-driven portion (now genuinely
    // case-rate, same math as grocery) PLUS a flat hour for the water-gallon
    // restock task that never appears in a case count — that hour doesn't
    // shrink just because more people showed up, so it's added after the
    // capacity division, not inside it.
    return zone.department === "juice" ? caseDrivenHours + settings.juiceHiddenTaskHours : caseDrivenHours;
  }

  function targetHoursFor(zone, settings) {
    if (zone.department === "grocery") return settings.groceryTargetHours;
    if (zone.department === "juice") return settings.juiceMaxTotalHours;
    return settings.maxZoneHoursPerWorker;
  }

  function targetGroupSize(zone, settings) {
    if (zone.estimationMethod === "fixed_duration") {
      return zone.fixedHeadcount != null ? zone.fixedHeadcount : 2;
    }
    let n = 2;
    while (true) {
      const hours = zoneTotalHours(zone, settings) / n;
      if (hours > targetHoursFor(zone, settings) && n < settings.maxGroupSize) {
        n++;
        continue;
      }
      break;
    }
    return n;
  }

  // ---------------------------------------------------------------------
  // Preference / balance scoring
  // ---------------------------------------------------------------------
  function zonePrefRank(worker, zoneId) {
    const idx = worker.preferredZones.indexOf(zoneId);
    return idx === -1 ? 99 : idx;
  }

  function partnerBonus(candidate, group) {
    let best = 0;
    for (const w of group) {
      const candidateLikes = candidate.preferredPartners.includes(w.id);
      const wLikes = w.preferredPartners.includes(candidate.id);
      if (candidateLikes && wLikes) best = Math.min(best, -2);
      else if (candidateLikes || wLikes) best = Math.min(best, -1);
    }
    return best;
  }

  function isIncompatible(a, b) {
    if (a.incompatibleWith.includes(b.id) || b.incompatibleWith.includes(a.id)) return true;
    if (a.productionRating === "new" && b.unsuitableForNewHires) return true;
    if (b.productionRating === "new" && a.unsuitableForNewHires) return true;
    return false;
  }

  function isLockedPair(a, b) {
    return a.lockedWith.includes(b.id) || b.lockedWith.includes(a.id);
  }

  // Hard "never assign here" — checked everywhere a worker is about to
  // pick up a NEW zone for the night. Doesn't apply to a zone they're
  // already assigned to via fixedDepartment/departmentRotationPool (a
  // deliberate individual opt-in, trusted as-is) or one they're already
  // working (nothing here ever removes someone from a zone).
  function isExcludedZone(worker, zoneId) {
    return worker.excludedZones.includes(zoneId);
  }

  function incompatibilityNote(a, b) {
    if (a.incompatibilityNotes && a.incompatibilityNotes[b.id]) return a.incompatibilityNotes[b.id];
    if (b.incompatibilityNotes && b.incompatibilityNotes[a.id]) return b.incompatibilityNotes[a.id];
    return null;
  }

  // zoneId is optional — pass it wherever the candidates are being
  // considered for one specific zone, so isExcludedZone gets checked
  // alongside isIncompatible in a single pass.
  function filterCompatible(candidates, group, zoneId) {
    return candidates.filter(c => !group.some(w => isIncompatible(c, w)) && (zoneId === undefined || !isExcludedZone(c, zoneId)));
  }

  function ratingMismatchPenalty(candidate, group) {
    const existingRatings = new Set(group.map(w => w.productionRating));
    if (candidate.productionRating === "needs_improvement" && existingRatings.has("new")) return 10;
    if (candidate.productionRating === "new" && existingRatings.has("needs_improvement")) return 10;
    return 0;
  }

  function candidateScore(candidate, zone, currentGroup) {
    const lockedBonus = currentGroup.some(m => isLockedPair(candidate, m)) ? -1 : 0;
    const pBonus = partnerBonus(candidate, currentGroup);
    const ratingMismatch = zone.department === "grocery" ? ratingMismatchPenalty(candidate, currentGroup) : 0;
    const nonOnPaceInGroup = currentGroup.filter(w => w.productionRating !== "on_pace").length;
    let ratingPenalty = 0;
    if (zone.department === "grocery" && candidate.productionRating !== "on_pace" && nonOnPaceInGroup >= 1) {
      ratingPenalty = 1;
    }
    return [lockedBonus, pBonus, ratingMismatch, zonePrefRank(candidate, zone.id), ratingPenalty];
  }

  // ---------------------------------------------------------------------
  // Step 2 — fully-staffed fill (also the base routine short-staffed
  // nights use; it just runs out of workers sooner)
  // ---------------------------------------------------------------------
  function fillZones(zones, pool, settings, assignments, rotationKey) {
    const zoneById = Object.fromEntries(zones.map(z => [z.id, z]));
    const targets = {};
    zones.forEach(z => { targets[z.id] = targetGroupSize(z, settings); });
    const remaining = {};
    zones.forEach(z => {
      // Dairy/Frozen are fully handled by assignFixedDepartments before
      // this function ever runs. Juice competes here like any grocery
      // zone — see the baseline-first pass below.
      remaining[z.id] = z.department === "dairy" || z.department === "frozen" ? 0 : targets[z.id];
    });
    const assignedIds = new Set();
    Object.values(assignments).forEach(a => a.workerIds.forEach(wid => assignedIds.add(wid)));

    function groupFor(zid) {
      return pool.filter(w => assignments[zid].workerIds.includes(w.id));
    }

    const idToWorker = Object.fromEntries(pool.map(w => [w.id, w]));
    const seedOrder = [...zones].sort((a, b) =>
      compareArrays([a.department === "grocery" ? 0 : 1, -targets[a.id]], [b.department === "grocery" ? 0 : 1, -targets[b.id]])
    );

    function lockedPairsAvailable() {
      const pairs = [];
      const seen = new Set();
      for (const w of pool) {
        if (assignedIds.has(w.id)) continue;
        for (const otherId of w.lockedWith) {
          if (assignedIds.has(otherId) || otherId === w.id) continue;
          const other = idToWorker[otherId];
          if (other) {
            const key = [w.id, otherId].sort().join("|");
            if (!seen.has(key)) {
              seen.add(key);
              pairs.push([w, other]);
            }
          }
        }
      }
      return pairs;
    }

    function seedLockedPairInto(a, b, zid) {
      if (!(zid in remaining) || remaining[zid] < 2) return false;
      if (isExcludedZone(a, zid) || isExcludedZone(b, zid)) return false;
      const group = groupFor(zid);
      if (isIncompatible(a, b)) return false;
      if (group.some(m => isIncompatible(a, m) || isIncompatible(b, m))) return false;
      const assignment = assignments[zid];
      assignment.workerIds.push(a.id, b.id);
      assignedIds.add(a.id);
      assignedIds.add(b.id);
      remaining[zid] -= 2;
      return true;
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const [a, b] of lockedPairsAvailable()) {
        const candidateZones = a.preferredZones.concat(b.preferredZones);
        for (const zid of candidateZones) {
          if (seedLockedPairInto(a, b, zid)) {
            changed = true;
            break;
          }
        }
        if (changed) break;
      }
    }

    for (const zone of seedOrder) {
      while (true) {
        const pairs = lockedPairsAvailable();
        if (!pairs.length) break;
        const [a, b] = pairs[0];
        if (!seedLockedPairInto(a, b, zone.id)) break;
      }
    }

    function mutualPairsAvailable() {
      const pairs = [];
      const seen = new Set();
      for (const w of pool) {
        if (assignedIds.has(w.id) || w.preferredZones.length) continue;
        for (const otherId of w.preferredPartners) {
          if (assignedIds.has(otherId) || otherId === w.id) continue;
          const other = idToWorker[otherId];
          if (other && !other.preferredZones.length && other.preferredPartners.includes(w.id)) {
            const key = [w.id, otherId].sort().join("|");
            if (!seen.has(key)) {
              seen.add(key);
              pairs.push([w, other]);
            }
          }
        }
      }
      return pairs;
    }

    for (const zone of seedOrder) {
      const group = groupFor(zone.id);
      while (remaining[zone.id] >= 2) {
        const candidates = mutualPairsAvailable().filter(
          ([a, b]) =>
            !isIncompatible(a, b) &&
            !group.some(m => isIncompatible(a, m) || isIncompatible(b, m)) &&
            !isExcludedZone(a, zone.id) &&
            !isExcludedZone(b, zone.id)
        );
        if (!candidates.length) break;
        const [a, b] = candidates[0];
        const assignment = assignments[zone.id];
        assignment.workerIds.push(a.id, b.id);
        assignedIds.add(a.id);
        assignedIds.add(b.id);
        group.push(a, b);
        remaining[zone.id] -= 2;
      }
    }

    const maxRank = pool.reduce((m, w) => Math.max(m, w.preferredZones.length), 0);
    for (let rank = 0; rank < maxRank; rank++) {
      const byZone = {};
      for (const w of pool) {
        if (assignedIds.has(w.id) || rank >= w.preferredZones.length) continue;
        const zid = w.preferredZones[rank];
        if (zid in remaining && remaining[zid] > 0) {
          (byZone[zid] = byZone[zid] || []).push(w);
        }
      }
      for (const zid of Object.keys(byZone)) {
        const zone = zoneById[zid];
        const assignment = assignments[zid];
        const group = groupFor(zid);
        let candidates = byZone[zid].filter(c => !assignedIds.has(c.id));
        candidates = filterCompatible(candidates, group, zid);
        candidates.sort((a, b) => compareArrays(candidateScore(a, zone, group), candidateScore(b, zone, group)));
        while (remaining[zid] > 0 && candidates.length) {
          const pick = candidates.shift();
          if (assignedIds.has(pick.id)) continue;
          assignment.workerIds.push(pick.id);
          assignedIds.add(pick.id);
          group.push(pick);
          remaining[zid] -= 1;
          candidates = filterCompatible(candidates, group, zid);
          candidates.sort((a, b) => compareArrays(candidateScore(a, zone, group), candidateScore(b, zone, group)));
        }
      }
    }

    const competingUnrotated = zones.filter(z => z.department !== "dairy" && z.department !== "frozen");

    // ---------------------------------------------------------------------
    // Baseline pass — every competing zone (grocery + Juice) gets its first
    // 2 people before any zone is allowed to grow past 2. One seat at a
    // time, round-robin across zones, rather than fully draining the pool
    // into the heaviest zone before the next one gets a look — that
    // ordering is exactly what let a zone at the back of the queue (Juice,
    // on a heavy night) end up with nobody at all. Round-robin means a
    // pool shortfall lands as "a few zones one short of their pair"
    // instead of "whoever's last in line gets zero."
    //
    // The sweep order itself used to be fixed every single pass (always
    // A, B, C, ... I) — which just relocates the same problem one level
    // up: whichever zone is LAST in that fixed order is systematically the
    // one still waiting when the pool runs dry mid-sweep by a small
    // margin, night after night, since ZONE_DEFS always lists Juice last.
    // Rotating the sweep's starting point by a daily key means a pool
    // that's short by one or two lands on a different zone each night
    // instead of reliably picking on the same one.
    // ---------------------------------------------------------------------
    if (rotationKey === undefined || rotationKey === null) rotationKey = todayRotationKey();
    const rotateStart = competingUnrotated.length
      ? ((rotationKey % competingUnrotated.length) + competingUnrotated.length) % competingUnrotated.length
      : 0;
    const competing = competingUnrotated.slice(rotateStart).concat(competingUnrotated.slice(0, rotateStart));

    const BASELINE_HEADCOUNT = 2;
    let stillNeedsBaseline = true;
    while (stillNeedsBaseline) {
      stillNeedsBaseline = false;
      for (const zone of competing) {
        const group = groupFor(zone.id);
        if (group.length >= BASELINE_HEADCOUNT || remaining[zone.id] <= 0) continue;
        const rawLeftover = pool.filter(w => !assignedIds.has(w.id));
        const leftover = filterCompatible(rawLeftover, group, zone.id);
        if (!leftover.length) continue;
        leftover.sort((a, b) => compareArrays(candidateScore(a, zone, group), candidateScore(b, zone, group)));
        const pick = leftover[0];
        const assignment = assignments[zone.id];
        if (pick.preferredZones.length && !pick.preferredZones.includes(zone.id)) {
          addFlag(assignment, "preference_override");
        }
        assignment.workerIds.push(pick.id);
        assignedIds.add(pick.id);
        group.push(pick);
        remaining[zone.id] -= 1;
        stillNeedsBaseline = true;
      }
    }

    // ---------------------------------------------------------------------
    // Grow pass — with every zone's baseline settled (or the pool
    // exhausted trying), whatever's left of the crew goes to whichever
    // zones still need more to reach their real case-driven target,
    // heaviest need first — "heaviest" measured by each zone's actual
    // projected overage (current workload minus ITS OWN target, using the
    // group it has after the baseline pass above), not a department/
    // target-size proxy. The previous comparator sorted every grocery zone
    // ahead of Juice unconditionally (department === "grocery" ? 0 : 1)
    // before ever looking at magnitude, then broke ties by raw target
    // GROUP SIZE rather than current workload — so a grocery zone sitting
    // only slightly over its ~3.4h target could out-rank Juice sitting
    // hours past its own 5h cap for whatever idle bodies were left (a real
    // incident: a 3.69h aisle got reinforced while Juice sat over 6h
    // untouched). Juice's growth-target comment elsewhere in this file
    // says it's meant to compete "same as grocery" for exactly this
    // reason; this sort is what actually delivers that instead of just
    // claiming it.
    // ---------------------------------------------------------------------
    const ordered = [...competing].sort((a, b) => {
      const overageA = workloadHoursFor(a, groupFor(a.id), settings) - targetHoursFor(a, settings);
      const overageB = workloadHoursFor(b, groupFor(b.id), settings) - targetHoursFor(b, settings);
      return overageB - overageA;
    });

    for (const zone of ordered) {
      const assignment = assignments[zone.id];
      const group = groupFor(zone.id);
      let blockedByIncompatibility = false;
      while (remaining[zone.id] > 0) {
        const rawLeftover = pool.filter(w => !assignedIds.has(w.id));
        let leftover = filterCompatible(rawLeftover, group, zone.id);
        if (!leftover.length) {
          if (rawLeftover.length) blockedByIncompatibility = true;
          break;
        }
        leftover.sort((a, b) => compareArrays(candidateScore(a, zone, group), candidateScore(b, zone, group)));
        const pick = leftover[0];
        if (pick.preferredZones.length && !pick.preferredZones.includes(zone.id)) {
          addFlag(assignment, "preference_override");
        }
        assignment.workerIds.push(pick.id);
        assignedIds.add(pick.id);
        group.push(pick);
        remaining[zone.id] -= 1;
      }
      // Juice used to be exempt here, back when its time never moved
      // regardless of headcount — now that it's real case-rate, a lone
      // juice worker on a heavy night is exactly as understaffed as a lone
      // grocery worker would be, so it gets the same flag.
      if (group.length < 2) {
        addFlag(assignment, "understaffed_below_pair");
      }
      if (blockedByIncompatibility) addFlag(assignment, "incompatibility_conflict");

      const idleLeftover = pool.filter(w => !assignedIds.has(w.id));
      const beforeIds = new Set(idleLeftover.map(w => w.id));
      recomputeAndMaybeGrow(zone, group, assignment, idleLeftover, settings);
      const afterIds = new Set(idleLeftover.map(w => w.id));
      for (const id of beforeIds) {
        if (!afterIds.has(id)) assignedIds.add(id);
      }

      const nonOnPace = group.filter(w => w.productionRating !== "on_pace");
      if (nonOnPace.length >= 2) addFlag(assignment, STRUGGLE_FLAG);

      for (const w of group) {
        w.hoursAssignedTonight += assignment.workloadHours;
        w.zonesAssignedTonight.push(zone.id);
      }
    }
  }

  function recomputeAndMaybeGrow(zone, group, assignment, pool, settings) {
    assignment.workloadHours = workloadHoursFor(zone, group, settings);
    if (zone.estimationMethod === "fixed_duration") return;
    const target = targetHoursFor(zone, settings);
    while (assignment.workloadHours > target && group.length < settings.maxGroupSize) {
      const candidates = filterCompatible(pool, group, zone.id);
      if (!candidates.length) break;
      candidates.sort((a, b) => compareArrays(candidateScore(a, zone, group), candidateScore(b, zone, group)));
      const pick = candidates[0];
      group.push(pick);
      const idx = pool.indexOf(pick);
      if (idx >= 0) pool.splice(idx, 1);
      assignment.workerIds.push(pick.id);
      addFlag(assignment, "reinforced");
      assignment.workloadHours = workloadHoursFor(zone, group, settings);
    }
  }

  // ---------------------------------------------------------------------
  // Step 2.55 — a light aisle that only got 1 person out of the baseline
  // fill shouldn't work it alone. Rather than pulling in a spare hand from
  // wherever (which just relocates the shortage), pair the aisle with
  // ANOTHER light aisle and cover both with one shared 3-person team —
  // same total headcount as "1 alone + 1 normal pair" would have used,
  // nobody isolated. Applies to zones that were always going to need just
  // 2 people at most (targetGroupSize <= 2, i.e. genuinely light) — PLUS
  // the specific zones in PREFERRED_LIGHT_MERGE_PAIRS (A/D, G/H), even on
  // a night their own case count doesn't clear that bar. Aisle 2's zone
  // (A) carries coffee (aisle 3) and Aisle 8's zone (D) carries soup —
  // both real, daily-truck items — so neither zone is reliably "light" by
  // the numbers the way a pure case-count filter would judge it, but
  // they're still the two aisles that actually get doubled up on the
  // floor by habit, real item mix or not. A zone with no known preferred
  // partner still needs the strict light-by-the-numbers test to trigger
  // this pass at all — a heavy zone that happened to come up short on
  // some other night needs an actual partner of its own (protectSoloNewHires
  // / the plain understaffed flag), not to borrow someone else's crew.
  // ---------------------------------------------------------------------
  function mergeLightSoloZones(zones, assignments, workersById, settings) {
    const lightZones = zones.filter(
      z => z.department !== "dairy" && z.department !== "frozen" && targetGroupSize(z, settings) <= 2
    );
    const hasPreferredPartner = z => zones.some(other => other.id !== z.id && isPreferredMergePair(z.id, other.id));
    // Trigger set: genuinely-light zones, plus the known real-world pair
    // members (A, D, G, H) even when this particular night's case count
    // keeps them out of the strict "light" bucket — see comment above.
    const soloTriggerZones = zones.filter(
      z => z.department !== "dairy" && z.department !== "frozen" && (targetGroupSize(z, settings) <= 2 || hasPreferredPartner(z))
    );

    function eligiblePartner(z, soloWorker) {
      const a = assignments[z.id];
      if (!a || a.workerIds.length !== 2 || a.flags.includes(STRUGGLE_FLAG)) return null;
      if (isExcludedZone(soloWorker, z.id)) return null;
      const group = a.workerIds.map(id => workersById[id]);
      if (group.some(m => isIncompatible(m, soloWorker))) return null;
      return { zone: z, a };
    }

    let changed = true;
    while (changed) {
      changed = false;
      const soloZone = soloTriggerZones.find(z => (assignments[z.id] || {}).workerIds && assignments[z.id].workerIds.length === 1);
      if (!soloZone) break;

      const soloAssignment = assignments[soloZone.id];
      const soloWorker = workersById[soloAssignment.workerIds[0]];
      if (!soloWorker) break;

      // The known real-world partner (PREFERRED_LIGHT_MERGE_PAIRS) doesn't
      // have to be light itself to qualify. Aisle 8's soup/canned freight
      // is real, daily work — but Aisle 2's crew has next to nothing of
      // its own on a night the truck skips bread and Little Debbie's, so
      // folding that person into 8's actual freight is still the right
      // move whether or not 8 alone would independently clear the "light"
      // bar. Only fall back to "some other light zone, least loaded
      // first" when there's no known preferred partner, or it isn't
      // usable tonight (busy elsewhere, incompatible, struggling).
      const preferred = zones
        .filter(z => z.department !== "dairy" && z.department !== "frozen" && z.id !== soloZone.id && isPreferredMergePair(soloZone.id, z.id))
        .map(z => eligiblePartner(z, soloWorker))
        .filter(Boolean);
      const others = lightZones
        .filter(z => z.id !== soloZone.id && !isPreferredMergePair(soloZone.id, z.id))
        .map(z => eligiblePartner(z, soloWorker))
        .filter(Boolean)
        .sort((x, y) => x.a.workloadHours - y.a.workloadHours);
      const candidates = preferred.concat(others);

      if (!candidates.length) break; // nothing safe to pair with — the solo-new-hire safety net (Step 3.5) is the fallback

      let merged = false;
      for (const { zone: partnerZone, a: partnerAssignment } of candidates) {
        const partnerWorkers = partnerAssignment.workerIds.map(id => workersById[id]);
        // The merge is bidirectional — partnerWorkers pick up soloZone
        // just as much as soloWorker picks up partnerZone (eligiblePartner
        // already checked soloWorker's side).
        if (partnerWorkers.some(w => isExcludedZone(w, soloZone.id))) continue;
        const team = [soloWorker, ...partnerWorkers];
        const teamIds = team.map(w => w.id);

        const oldSoloWorkload = soloAssignment.workloadHours;
        const oldPartnerWorkload = partnerAssignment.workloadHours;
        const projectedSolo = workloadHoursFor(soloZone, team, settings);
        const projectedPartner = workloadHoursFor(partnerZone, team, settings);

        // Hour-cap check — the same 3 people now cover both aisles
        // (sequentially, one shift), so it's their existing base for the
        // night MINUS what they're about to have recomputed, PLUS both
        // zones' new totals, same accounting stackLeftoverZones uses for
        // doubling someone up onto a second zone.
        const fitsSolo = soloWorker.hoursAssignedTonight - oldSoloWorkload + projectedSolo + projectedPartner <= settings.maxZoneHoursPerWorker;
        const fitsPartners = partnerWorkers.every(
          w => w.hoursAssignedTonight - oldPartnerWorkload + projectedSolo + projectedPartner <= settings.maxZoneHoursPerWorker
        );
        if (!fitsSolo || !fitsPartners) continue; // would push someone over cap — try the next candidate instead of giving up

        soloAssignment.workerIds = [...teamIds];
        partnerAssignment.workerIds = [...teamIds];
        soloAssignment.workloadHours = projectedSolo;
        partnerAssignment.workloadHours = projectedPartner;

        const idx = soloAssignment.flags.indexOf("understaffed_below_pair");
        if (idx >= 0) soloAssignment.flags.splice(idx, 1);
        addFlag(soloAssignment, "merged_light_pair_team");
        addFlag(partnerAssignment, "merged_light_pair_team");

        soloWorker.hoursAssignedTonight = soloWorker.hoursAssignedTonight - oldSoloWorkload + projectedSolo + projectedPartner;
        soloWorker.zonesAssignedTonight.push(partnerZone.id);
        for (const w of partnerWorkers) {
          w.hoursAssignedTonight = w.hoursAssignedTonight - oldPartnerWorkload + projectedSolo + projectedPartner;
          w.zonesAssignedTonight.push(soloZone.id);
        }

        merged = true;
        break;
      }
      if (!merged) break;

      changed = true;
    }
  }

  // ---------------------------------------------------------------------
  // Step 2.65 — split up clustered underperformers
  // ---------------------------------------------------------------------
  function anchorStrugglingZones(zones, assignments, workersById, settings) {
    const zoneById = Object.fromEntries(zones.map(z => [z.id, z]));
    const allZoneIds = zones.filter(z => z.department !== "dairy" && z.department !== "frozen").map(z => z.id);

    function groupFor(zid) {
      return assignments[zid].workerIds.map(wid => workersById[wid]);
    }

    function findSwapFor(targetZid) {
      const targetGroup = groupFor(targetZid);
      let best = null;
      for (const donorZid of allZoneIds) {
        if (donorZid === targetZid) continue;
        const donorGroup = groupFor(donorZid);
        if (donorGroup.length < 2 || !donorGroup.every(w => w.productionRating === "on_pace")) continue;
        for (const donorPick of donorGroup) {
          if (targetGroup.some(m => isIncompatible(donorPick, m))) continue;
          if (isExcludedZone(donorPick, targetZid)) continue;
          const remainingDonor = donorGroup.filter(m => m.id !== donorPick.id);
          if (remainingDonor.some(m => isLockedPair(donorPick, m))) continue;
          for (const strugglerPick of targetGroup) {
            if (strugglerPick.productionRating === "on_pace") continue;
            if (remainingDonor.some(m => isIncompatible(strugglerPick, m))) continue;
            if (isExcludedZone(strugglerPick, donorZid)) continue;
            const remainingTarget = targetGroup.filter(m => m.id !== strugglerPick.id);
            if (remainingTarget.some(m => isLockedPair(strugglerPick, m))) continue;
            const bondCost =
              Math.abs(partnerBonus(donorPick, remainingDonor)) +
              Math.abs(partnerBonus(strugglerPick, targetGroup.filter(m => m.id !== strugglerPick.id)));
            if (best === null || bondCost < best[0]) {
              best = [bondCost, donorZid, donorPick, strugglerPick];
            }
          }
        }
      }
      return best;
    }

    for (let i = 0; i < allZoneIds.length * settings.maxGroupSize; i++) {
      let targetZid = null;
      for (const zid of allZoneIds) {
        const nonOnPace = groupFor(zid).filter(w => w.productionRating !== "on_pace");
        if (nonOnPace.length >= 2) {
          targetZid = zid;
          break;
        }
      }
      if (targetZid === null) break;
      const swap = findSwapFor(targetZid);
      if (swap === null) break;
      const [, donorZid, donorPick, strugglerPick] = swap;
      const donorZone = zoneById[donorZid];
      const targetZone = zoneById[targetZid];

      assignments[targetZid].workerIds.splice(assignments[targetZid].workerIds.indexOf(strugglerPick.id), 1);
      assignments[targetZid].workerIds.push(donorPick.id);
      assignments[donorZid].workerIds.splice(assignments[donorZid].workerIds.indexOf(donorPick.id), 1);
      assignments[donorZid].workerIds.push(strugglerPick.id);

      donorPick.zonesAssignedTonight = donorPick.zonesAssignedTonight.filter(z => z !== donorZid).concat([targetZid]);
      strugglerPick.zonesAssignedTonight = strugglerPick.zonesAssignedTonight.filter(z => z !== targetZid).concat([donorZid]);

      const newTargetGroup = groupFor(targetZid);
      const newDonorGroup = groupFor(donorZid);
      const newTargetWorkload = workloadHoursFor(targetZone, newTargetGroup, settings);
      const newDonorWorkload = workloadHoursFor(donorZone, newDonorGroup, settings);
      assignments[targetZid].workloadHours = newTargetWorkload;
      assignments[donorZid].workloadHours = newDonorWorkload;

      for (const w of newTargetGroup) w.hoursAssignedTonight = newTargetWorkload;
      for (const w of newDonorGroup) w.hoursAssignedTonight = newDonorWorkload;

      addFlag(assignments[targetZid], "anchored_with_on_pace_worker");
      addFlag(assignments[donorZid], "lent_on_pace_anchor");

      const stillClustered = newTargetGroup.filter(w => w.productionRating !== "on_pace").length >= 2;
      if (!stillClustered) {
        const idx = assignments[targetZid].flags.indexOf(STRUGGLE_FLAG);
        if (idx >= 0) assignments[targetZid].flags.splice(idx, 1);
      }
      if (newDonorGroup.filter(w => w.productionRating !== "on_pace").length >= 2) {
        addFlag(assignments[donorZid], STRUGGLE_FLAG);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Step 2.7 — overstaffed-zone rebalance (lend a single spare hand)
  // ---------------------------------------------------------------------
  function rebalanceOverstaffedZones(zones, assignments, workersById, settings) {
    const zoneById = Object.fromEntries(zones.map(z => [z.id, z]));
    // Grocery-only, deliberately. Used to be "anything not fixed_duration"
    // as a shorthand for grocery, back when Juice was the only other
    // case-rate zone lumped in with dairy/frozen's fixed_duration — now
    // that Juice computes real case-driven hours too, that shorthand would
    // silently pull Juice into grocery's lend/merge machinery using
    // grocery's own target and thresholds, which isn't right for it (Juice
    // has its own target and its own rules about picking up second aisles).
    const groceryIds = zones.filter(z => z.department === "grocery").map(z => z.id);

    for (let i = 0; i < groceryIds.length; i++) {
      const heavyCandidates = groceryIds.filter(
        zid =>
          assignments[zid].workerIds.length &&
          assignments[zid].workerIds.length < settings.maxGroupSize &&
          assignments[zid].workloadHours > settings.groceryTargetHours
      );
      if (!heavyCandidates.length) break;
      let heavyZid = heavyCandidates[0];
      for (const zid of heavyCandidates.slice(1)) {
        if (assignments[zid].workloadHours > assignments[heavyZid].workloadHours) heavyZid = zid;
      }
      const heavyAssignment = assignments[heavyZid];
      const heavyZone = zoneById[heavyZid];
      let heavyGroup = heavyAssignment.workerIds.map(wid => workersById[wid]);

      let donorIds = groceryIds.filter(
        zid =>
          zid !== heavyZid &&
          assignments[zid].workerIds.length > 2 &&
          !needsExtraHelp(zid, assignments) &&
          // A merged light-pair team (rule 3) is deliberately the same 3
          // people covering 2 zones together — pulling one out here only
          // touches THIS zone's copy of the roster, not the other zone's,
          // which would silently desync the two and overwrite that
          // worker's zonesAssignedTonight/hoursAssignedTonight record of
          // the merge (see mergeLightSoloZones). Rule 3 outranks rule 4's
          // hour-balancing here, so these teams are off-limits as donors.
          !assignments[zid].flags.includes("merged_light_pair_team") &&
          assignments[zid].workloadHours < settings.groceryTargetHours
      );
      donorIds.sort((a, b) => assignments[a].workloadHours - assignments[b].workloadHours);

      let moved = false;
      for (const donorZid of donorIds) {
        const donorAssignment = assignments[donorZid];
        const donorZone = zoneById[donorZid];
        const donorGroup = donorAssignment.workerIds.map(wid => workersById[wid]);
        const movable = [...donorGroup].sort(
          (a, b) =>
            Math.abs(partnerBonus(a, donorGroup.filter(m => m.id !== a.id))) -
            Math.abs(partnerBonus(b, donorGroup.filter(m => m.id !== b.id)))
        );
        for (const candidate of movable) {
          if (heavyGroup.some(m => isIncompatible(candidate, m))) continue;
          if (isExcludedZone(candidate, heavyZid)) continue;
          const remainingDonor = donorGroup.filter(m => m.id !== candidate.id);
          if (remainingDonor.some(m => isLockedPair(candidate, m))) continue;
          const projectedHeavy = workloadHoursFor(heavyZone, heavyGroup.concat([candidate]), settings);
          const projectedDonor = workloadHoursFor(donorZone, remainingDonor, settings);
          if (projectedHeavy >= heavyAssignment.workloadHours) continue;
          if (projectedHeavy > settings.maxZoneHoursPerWorker) continue;
          if (projectedDonor > settings.maxZoneHoursPerWorker) continue;

          donorAssignment.workerIds.splice(donorAssignment.workerIds.indexOf(candidate.id), 1);
          heavyAssignment.workerIds.push(candidate.id);
          candidate.zonesAssignedTonight = [heavyZid];
          candidate.hoursAssignedTonight = projectedHeavy;
          donorAssignment.workloadHours = projectedDonor;
          heavyAssignment.workloadHours = projectedHeavy;
          for (const w of remainingDonor) w.hoursAssignedTonight = projectedDonor;
          for (const w of heavyGroup) w.hoursAssignedTonight = projectedHeavy;
          addFlag(donorAssignment, "lent_spare_hand");
          addFlag(heavyAssignment, "received_spare_hand");
          heavyGroup.push(candidate);
          moved = true;
          break;
        }
        if (moved) break;
      }
      if (!moved) break;
    }
  }

  // ---------------------------------------------------------------------
  // Step 2.72 — free a hand for a genuinely heavy zone by consolidating a
  // known light pair (rule-5 soft preference, opt-in only — this never
  // fires just because a pairing is "usual," only when a specific zone is
  // over target and nobody with real slack (>2 already) is available to
  // lend). 4(5) and 6(7) commonly run heavy enough to want a 3rd; 2(3) and
  // 8(9), or 14(15) and 19, are the pairs that get consolidated to free
  // that 3rd body — same 3-covers-2 math as mergeLightSoloZones, just
  // triggered by "a heavy zone could use the help" instead of "one of the
  // pair got left solo." Every zone here starts at a completely normal,
  // fully-staffed 2-person baseline; nobody is short-handed by this move,
  // it's a genuine reallocation choice, which is exactly why it only runs
  // after rebalanceOverstaffedZones already tried (and failed to find) an
  // easier donor with slack to spare.
  // ---------------------------------------------------------------------
  function freeDonorFromPreferredPair(zones, assignments, workersById, settings) {
    const zoneById = Object.fromEntries(zones.map(z => [z.id, z]));
    const groceryIds = zones.filter(z => z.department === "grocery").map(z => z.id);

    function tryPairFor(heavyZid) {
      const heavyAssignment = assignments[heavyZid];
      const heavyZone = zoneById[heavyZid];
      const heavyGroup = heavyAssignment.workerIds.map(wid => workersById[wid]);

      for (const [p1, p2] of PREFERRED_LIGHT_MERGE_PAIRS) {
        if (p1 === heavyZid || p2 === heavyZid) continue;
        const a1 = assignments[p1];
        const a2 = assignments[p2];
        if (!a1 || !a2) continue;
        // Only touches a completely ordinary, already-fully-staffed pair —
        // not a solo zone (that's mergeLightSoloZones's job), not already
        // merged, not struggling.
        if (a1.workerIds.length !== 2 || a2.workerIds.length !== 2) continue;
        if (a1.flags.includes(STRUGGLE_FLAG) || a2.flags.includes(STRUGGLE_FLAG)) continue;
        if (a1.flags.includes("merged_light_pair_team") || a2.flags.includes("merged_light_pair_team")) continue;

        const zone1 = zoneById[p1];
        const zone2 = zoneById[p2];
        const fromP1 = a1.workerIds.map(id => workersById[id]);
        const fromP2 = a2.workerIds.map(id => workersById[id]);
        const four = fromP1.concat(fromP2);
        const oldP1Workload = a1.workloadHours;
        const oldP2Workload = a2.workloadHours;

        for (const donor of four) {
          const remainingThree = four.filter(w => w.id !== donor.id);
          // Splitting the donor off can't create a fresh incompatibility or
          // lock break among the three staying behind, or between the donor
          // and the heavy zone's existing crew.
          if (remainingThree.some((m, i) => remainingThree.slice(i + 1).some(n => isIncompatible(m, n)))) continue;
          if (remainingThree.some(m => isLockedPair(donor, m))) continue;
          if (heavyGroup.some(m => isIncompatible(donor, m))) continue;
          // Each of the three staying behind is about to pick up whichever
          // of p1/p2 they weren't already on — can't do that if they've
          // flagged it Won't Work. Same for the donor picking up the heavy
          // zone.
          if (remainingThree.some(w => isExcludedZone(w, fromP1.includes(w) ? p2 : p1))) continue;
          if (isExcludedZone(donor, heavyZid)) continue;

          const projectedP1 = workloadHoursFor(zone1, remainingThree, settings);
          const projectedP2 = workloadHoursFor(zone2, remainingThree, settings);
          const projectedHeavy = workloadHoursFor(heavyZone, heavyGroup.concat([donor]), settings);
          if (projectedHeavy >= heavyAssignment.workloadHours) continue;
          if (projectedHeavy > settings.maxZoneHoursPerWorker) continue;

          const donorOldWorkload = fromP1.includes(donor) ? oldP1Workload : oldP2Workload;
          const donorFits = donor.hoursAssignedTonight - donorOldWorkload + projectedHeavy <= settings.maxZoneHoursPerWorker;
          if (!donorFits) continue;
          const teamFits = remainingThree.every(w => {
            const oldWorkload = fromP1.includes(w) ? oldP1Workload : oldP2Workload;
            return w.hoursAssignedTonight - oldWorkload + projectedP1 + projectedP2 <= settings.maxZoneHoursPerWorker;
          });
          if (!teamFits) continue;
          const heavyFits = heavyGroup.every(w => w.hoursAssignedTonight - heavyAssignment.workloadHours + projectedHeavy <= settings.maxZoneHoursPerWorker);
          if (!heavyFits) continue;

          // All clear — consolidate p1+p2 into the shared 3-person team and
          // hand the donor to the heavy zone.
          const teamIds = remainingThree.map(w => w.id);
          a1.workerIds = [...teamIds];
          a2.workerIds = [...teamIds];
          a1.workloadHours = projectedP1;
          a2.workloadHours = projectedP2;
          addFlag(a1, "merged_light_pair_team");
          addFlag(a2, "merged_light_pair_team");

          for (const w of remainingThree) {
            const oldWorkload = fromP1.includes(w) ? oldP1Workload : oldP2Workload;
            const toZid = fromP1.includes(w) ? p2 : p1;
            w.hoursAssignedTonight = w.hoursAssignedTonight - oldWorkload + projectedP1 + projectedP2;
            if (!w.zonesAssignedTonight.includes(toZid)) w.zonesAssignedTonight.push(toZid);
          }

          donor.hoursAssignedTonight = donor.hoursAssignedTonight - donorOldWorkload + projectedHeavy;
          donor.zonesAssignedTonight = [heavyZid];
          heavyAssignment.workerIds.push(donor.id);
          heavyAssignment.workloadHours = projectedHeavy;
          for (const w of heavyGroup) w.hoursAssignedTonight = projectedHeavy;
          addFlag(a1, "lent_freed_hand_to_heavy_zone");
          addFlag(a2, "lent_freed_hand_to_heavy_zone");
          addFlag(heavyAssignment, "received_spare_hand");

          return true;
        }
      }
      return false;
    }

    // "Put 3 people in them" — each heavy zone gets AT MOST one freed hand
    // out of this specific mechanism per run, same as Dan described (2 -> 3,
    // not 2 -> 4). A zone that's still over target after that is a job for
    // the normal >2-donor rebalancing (rebalanceOverstaffedZones, which
    // already ran before this) or just genuinely needs more than one known
    // light pair can spare — not this pass grabbing a second known pair.
    const alreadyBoosted = new Set();
    for (let i = 0; i < groceryIds.length; i++) {
      const heavyCandidates = groceryIds.filter(
        zid =>
          !alreadyBoosted.has(zid) &&
          assignments[zid].workerIds.length &&
          assignments[zid].workerIds.length < settings.maxGroupSize &&
          assignments[zid].workloadHours > settings.groceryTargetHours
      );
      if (!heavyCandidates.length) break;
      let heavyZid = heavyCandidates[0];
      for (const zid of heavyCandidates.slice(1)) {
        if (assignments[zid].workloadHours > assignments[heavyZid].workloadHours) heavyZid = zid;
      }
      alreadyBoosted.add(heavyZid);
      tryPairFor(heavyZid);
    }
  }

  // ---------------------------------------------------------------------
  // Step 3 — short-staffed handling
  // ---------------------------------------------------------------------
  function stackLeftoverZones(zones, assignments, workersById, settings) {
    const zoneById = Object.fromEntries(zones.map(z => [z.id, z]));
    const leftover = zones.filter(z => !assignments[z.id].workerIds.length && z.department !== "dairy" && z.department !== "frozen");
    const donorZoneIds = new Set(zones.filter(z => z.department !== "dairy" && z.department !== "frozen").map(z => z.id));

    for (const zone of leftover) {
      let candidates = Object.entries(assignments).filter(([zid, a]) => a.workerIds.length && zid !== zone.id && donorZoneIds.has(zid));

      // Doubling someone up onto a second, leftover zone should never be
      // an unlimited blank check on their night — cap it everywhere, not
      // just for Juice. Juice gets the tighter cap specifically: it always
      // carries roughly an extra hour of restocking that never shows up in
      // a case count (water gallons in Infants and in the juice aisle
      // itself, off the daily truck), so a juice worker's real total is
      // already close to the ceiling before they touch anything else.
      candidates = candidates.filter(([zid, a]) => {
        const donorZone = zoneById[zid];
        const involvesJuice = zone.department === "juice" || donorZone.department === "juice";
        const cap = involvesJuice ? settings.juiceMaxTotalHours : settings.maxZoneHoursPerWorker;
        const group = a.workerIds.map(wid => workersById[wid]);
        if (group.some(w => isExcludedZone(w, zone.id))) return false;
        const newHours = workloadHoursFor(zone, group, settings);
        return group.every(w => w.hoursAssignedTonight + newHours <= cap);
      });
      if (!candidates.length) continue;

      function groupLoad(a) {
        const members = a.workerIds.map(wid => workersById[wid]);
        return members.reduce((s, w) => s + w.hoursAssignedTonight, 0) / members.length;
      }

      candidates.sort((p1, p2) =>
        compareArrays(
          [p1[1].flags.includes(STRUGGLE_FLAG), p1[1].flags.includes("stacked_sequential_donor"), groupLoad(p1[1])],
          [p2[1].flags.includes(STRUGGLE_FLAG), p2[1].flags.includes("stacked_sequential_donor"), groupLoad(p2[1])]
        )
      );
      const chosen = candidates[0][1];
      const group = chosen.workerIds.map(wid => workersById[wid]);

      const assignment = assignments[zone.id];
      assignment.workerIds = [...chosen.workerIds];
      addFlag(assignment, "stacked_sequential");
      assignment.workloadHours = workloadHoursFor(zone, group, settings);
      addFlag(chosen, "stacked_sequential_donor");
      addFlag(assignment, "stacked_sequential_donor");

      for (const w of group) {
        w.hoursAssignedTonight += assignment.workloadHours;
        w.zonesAssignedTonight.push(zone.id);
      }
    }
  }

  function reinforceWithIdleWorkers(zones, assignments, idlePool, workersById, settings) {
    const zoneById = Object.fromEntries(zones.map(z => [z.id, z]));

    function worstOverloaded() {
      let worstZid = null,
        worstExcess = 0.0;
      for (const [zid, a] of Object.entries(assignments)) {
        const zone = zoneById[zid];
        if (zone.estimationMethod === "fixed_duration" || !a.workerIds.length) continue;
        const excess = a.workloadHours - settings.maxZoneHoursPerWorker;
        if (excess > worstExcess) {
          worstExcess = excess;
          worstZid = zid;
        }
      }
      return [worstZid, worstExcess];
    }

    while (idlePool.length) {
      const [zid, excess] = worstOverloaded();
      if (zid === null || excess <= 0) break;
      const assignment = assignments[zid];
      const zone = zoneById[zid];
      const group = assignment.workerIds.map(wid => workersById[wid]);
      if (assignment.workerIds.length >= settings.maxGroupSize) break;
      const candidates = filterCompatible(idlePool, group, zid);
      if (!candidates.length) break;
      candidates.sort((a, b) => compareArrays([ratingMismatchPenalty(a, group), a.hoursAssignedTonight], [ratingMismatchPenalty(b, group), b.hoursAssignedTonight]));
      const pick = candidates[0];
      idlePool.splice(idlePool.indexOf(pick), 1);
      assignment.workerIds.push(pick.id);
      addFlag(assignment, "reinforced");
      group.push(pick);
      assignment.workloadHours = workloadHoursFor(zone, group, settings);
      pick.hoursAssignedTonight += assignment.workloadHours;
      pick.zonesAssignedTonight.push(zid);
    }
  }

  function needsExtraHelp(zid, assignments) {
    return assignments[zid].flags.includes(STRUGGLE_FLAG);
  }

  function helpPriorityKey(zid, assignments) {
    return [needsExtraHelp(zid, assignments) ? 0 : 1, -assignments[zid].workloadHours];
  }

  // A zone only gets a light zone's whole crew merged in when IT is
  // genuinely too heavy to finish (actual hours over target) — not just
  // because the people in it happen to be rated below On Pace. A pair of
  // Needs Improvement workers with a light, on-target case count should be
  // left alone to finish at their own pace; once they're done, the intent
  // is for them to move on to other parts of the store, not get folded
  // into another grocery zone as a "just in case" reinforcement.
  // needsExtraHelp still breaks ties below when multiple zones legitimately
  // qualify by hours — it's just no longer enough to qualify on its own.
  function rebalanceLightZones(zones, assignments, workersById, settings) {
    const zoneById = Object.fromEntries(zones.map(z => [z.id, z]));
    // Grocery-only, deliberately — see the same filter in
    // rebalanceOverstaffedZones above for why this can't just be "anything
    // not fixed_duration" anymore now that Juice is also case-rate.
    const groceryIds = zones.filter(z => z.department === "grocery").map(z => z.id);

    for (let i = 0; i < groceryIds.length; i++) {
      const heavyCandidates = groceryIds.filter(
        zid => assignments[zid].workerIds.length < settings.maxGroupSize && assignments[zid].workloadHours > settings.groceryTargetHours
      );
      if (!heavyCandidates.length) break;
      let heavyZid = heavyCandidates[0];
      let bestKey = helpPriorityKey(heavyZid, assignments);
      for (const zid of heavyCandidates.slice(1)) {
        const k = helpPriorityKey(zid, assignments);
        if (compareArrays(k, bestKey) < 0) {
          bestKey = k;
          heavyZid = zid;
        }
      }
      const heavyAssignment = assignments[heavyZid];
      const heavyZone = zoneById[heavyZid];
      const heavyGroup = heavyAssignment.workerIds.map(wid => workersById[wid]);

      const lightOptions = [];
      for (const zid of groceryIds) {
        if (zid === heavyZid) continue;
        const a = assignments[zid];
        // Same rule-3-outranks-rule-4 reasoning as rebalanceOverstaffedZones
        // above — a merged light-pair team's whole crew getting folded into
        // a different, heavier zone would leave its OTHER merged zone
        // still pointing at people who no longer show that zone in their
        // own bookkeeping.
        if (!a.workerIds.length || needsExtraHelp(zid, assignments) || a.flags.includes("merged_light_pair_team")) continue;
        if (a.workloadHours > settings.groceryTargetHours * settings.lightLoadThreshold) continue;
        const group = a.workerIds.map(wid => workersById[wid]);
        if (a.workerIds.some(wid => heavyAssignment.workerIds.includes(wid))) continue;
        if (heavyAssignment.workerIds.length + group.length > settings.maxGroupSize) continue;
        if (group.some(w => heavyGroup.some(hw => isIncompatible(w, hw)))) continue;
        if (group.some(w => isExcludedZone(w, heavyZid))) continue;
        const projected = workloadHoursFor(heavyZone, heavyGroup.concat(group), settings);
        if (group.some(w => w.hoursAssignedTonight + projected > settings.maxZoneHoursPerWorker)) continue;
        lightOptions.push([zid, a, group]);
      }
      if (!lightOptions.length) break;

      function mismatchCost(members) {
        return members.reduce((sum, w) => sum + ratingMismatchPenalty(w, heavyGroup), 0);
      }

      let best = lightOptions[0];
      let bestKey2 = [mismatchCost(best[2]), best[1].workloadHours];
      for (const t of lightOptions.slice(1)) {
        const k = [mismatchCost(t[2]), t[1].workloadHours];
        if (compareArrays(k, bestKey2) < 0) {
          bestKey2 = k;
          best = t;
        }
      }
      const [, lightAssignment, lightGroup] = best;

      heavyAssignment.workerIds.push(...lightAssignment.workerIds);
      addFlag(heavyAssignment, "balanced_second_zone");
      addFlag(lightAssignment, "lent_to_heavier_zone");

      const newGroup = heavyGroup.concat(lightGroup);
      const oldWorkload = heavyAssignment.workloadHours;
      const newWorkload = workloadHoursFor(heavyZone, newGroup, settings);
      const delta = newWorkload - oldWorkload;
      heavyAssignment.workloadHours = newWorkload;
      for (const w of heavyGroup) w.hoursAssignedTonight += delta;
      for (const w of lightGroup) {
        w.hoursAssignedTonight += newWorkload;
        w.zonesAssignedTonight.push(heavyZid);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Step 3.5 — a "new" rated worker left completely alone in a zone gets
  // one more, dedicated attempt at a partner, regardless of what the hour
  // math says. Everything above this point (baseline fill, rebalancing,
  // idle reinforcement) is tuned around hitting each zone's target hours —
  // a zone that's genuinely light on cases can legitimately end up with
  // one person by that logic alone, and a lone "new" hire on what should
  // have been a two-person zone is a real safety/support problem
  // independent of whether the hours pencil out. This runs last and can
  // override the normal placement rules for exactly that reason.
  // ---------------------------------------------------------------------
  function protectSoloNewHires(zones, assignments, idlePool, workersById, settings) {
    const zoneById = Object.fromEntries(zones.map(z => [z.id, z]));

    for (const zone of zones) {
      const assignment = assignments[zone.id];
      if (!assignment || assignment.workerIds.length !== 1) continue;
      const solo = workersById[assignment.workerIds[0]];
      if (!solo || solo.productionRating !== "new") continue;

      // First choice: someone who isn't working anywhere yet tonight —
      // costs nothing else, unstaffs nothing.
      let partner = idlePool.find(w => !isIncompatible(w, solo) && !isExcludedZone(w, zone.id)) || null;
      let donorZid = null;

      if (!partner) {
        // Nobody idle — borrow from whichever other zone can most safely
        // spare a hand: at least 3 people there already (so it drops to 2,
        // never down to a solo situation of its own), not Dairy/Frozen
        // (guaranteed headcount, not a general pool to raid), not already
        // flagged struggling or understaffed, and the lightest-loaded
        // candidate first — pulling someone off a zone with real slack
        // left is a lot safer than pulling off one that's already tight.
        const donorCandidates = [];
        for (const dz of zones) {
          if (dz.id === zone.id || dz.department === "dairy" || dz.department === "frozen") continue;
          const da = assignments[dz.id];
          if (!da || da.workerIds.length < 3) continue;
          if (da.flags.includes(STRUGGLE_FLAG) || da.flags.includes("understaffed_below_pair")) continue;
          const group = da.workerIds.map(id => workersById[id]);
          for (const cand of group) {
            if (isIncompatible(cand, solo)) continue;
            if (isExcludedZone(cand, zone.id)) continue;
            const remaining = group.filter(m => m.id !== cand.id);
            if (remaining.some(m => isLockedPair(cand, m))) continue;
            donorCandidates.push({ zid: dz.id, worker: cand, load: da.workloadHours });
          }
        }
        donorCandidates.sort((a, b) => a.load - b.load);
        if (donorCandidates.length) {
          partner = donorCandidates[0].worker;
          donorZid = donorCandidates[0].zid;
        }
      }

      if (!partner) {
        // Truly nobody available anywhere — leave the flag fillZones
        // already set, but call this out distinctly so it isn't lost in
        // the general "below a pair" noise: a new hire alone is a
        // different kind of problem than a case count running light.
        addFlag(assignment, "new_hire_left_solo");
        continue;
      }

      if (donorZid) {
        const donorAssignment = assignments[donorZid];
        const idx = donorAssignment.workerIds.indexOf(partner.id);
        if (idx >= 0) donorAssignment.workerIds.splice(idx, 1);
        const donorZone = zoneById[donorZid];
        const donorGroup = donorAssignment.workerIds.map(id => workersById[id]);
        donorAssignment.workloadHours = workloadHoursFor(donorZone, donorGroup, settings);
        addFlag(donorAssignment, "lent_new_hire_safety_partner");
        partner.zonesAssignedTonight = partner.zonesAssignedTonight.filter(z => z !== donorZid);
      } else {
        const poolIdx = idlePool.indexOf(partner);
        if (poolIdx >= 0) idlePool.splice(poolIdx, 1);
      }

      assignment.workerIds.push(partner.id);
      const group = assignment.workerIds.map(id => workersById[id]);
      assignment.workloadHours = workloadHoursFor(zone, group, settings);
      addFlag(assignment, "new_hire_safety_partner");
      const flagIdx = assignment.flags.indexOf("understaffed_below_pair");
      if (flagIdx >= 0) assignment.flags.splice(flagIdx, 1);
      partner.zonesAssignedTonight.push(zone.id);
      partner.hoursAssignedTonight += assignment.workloadHours;
    }
  }

  function computeShortfall(assignments, workersById, settings) {
    const overByWorker = {};
    const affectedZones = [];
    for (const [zid, a] of Object.entries(assignments)) {
      if (!a.workerIds.length) {
        affectedZones.push(zid);
        continue;
      }
      let zoneHasOverWorker = false;
      for (const wid of a.workerIds) {
        const w = workersById[wid];
        const over = w.hoursAssignedTonight - settings.maxZoneHoursPerWorker;
        if (over > 0.001) {
          overByWorker[wid] = over;
          zoneHasOverWorker = true;
        }
      }
      if (zoneHasOverWorker) {
        addFlag(a, "over_cap");
        affectedZones.push(zid);
      }
    }
    const totalExcess = Object.values(overByWorker).reduce((s, v) => s + v, 0);
    return [totalExcess, affectedZones, overByWorker];
  }

  // ---------------------------------------------------------------------
  // Step 0.5 — fixed departments (Dairy, Frozen)
  // ---------------------------------------------------------------------
  // Dairy and Frozen have real dedicated/rotation-pool specialists, so they
  // get a guaranteed-headcount pass before anyone else touches the pool.
  // Juice does NOT get special-cased here — it has no dedicated-specialist
  // concept, and singling it out here just relocates the starvation risk
  // instead of fixing it (a grocery zone at the back of the fill queue is
  // exposed to the exact same "heaviest zones eat the whole crew" problem).
  // Juice competes fairly for the pool in fillZones's baseline-first pass
  // instead — see the comment there.
  // ---------------------------------------------------------------------
  function todayRotationKey() {
    return Math.floor(Date.now() / 86400000);
  }

  function rotatePick(candidates, n, rotationKey) {
    if (n <= 0 || !candidates.length) return [];
    const ordered = [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const start = ((rotationKey % ordered.length) + ordered.length) % ordered.length;
    const result = [];
    for (let i = 0; i < Math.min(n, ordered.length); i++) result.push(ordered[(start + i) % ordered.length]);
    return result;
  }

  function assignFixedDepartments(zones, assignments, pool, settings, rotationKey) {
    if (rotationKey === undefined || rotationKey === null) rotationKey = todayRotationKey();
    const ratingOrder = { on_pace: 0, needs_improvement: 1, new: 2 };

    for (const zone of zones) {
      const isGuaranteed = zone.department === "dairy" || zone.department === "frozen";
      if (zone.estimationMethod !== "fixed_duration" || !isGuaranteed) continue;

      const dedicated = pool.filter(w => w.fixedDepartment === zone.department);
      const target = targetGroupSize(zone, settings);
      const slotsLeft = Math.max(0, target - dedicated.length);

      const rotationCandidates = pool.filter(w => w.departmentRotationPool === zone.department);
      const chosenRotation = rotatePick(rotationCandidates, slotsLeft, rotationKey);

      let group = dedicated.concat(chosenRotation);

      let backfilled = false;
      if (group.length < target) {
        const alreadyIn = new Set(group.map(w => w.id));
        const idToWorker = Object.fromEntries(pool.map(w => [w.id, w]));
        // Anyone who explicitly prefers this zone gets first claim on the
        // backfill seats. Otherwise, someone with NO stated zone
        // preference at all is preferred over someone who asked for a
        // DIFFERENT zone (e.g. Juice) — this runs before fillZones ever
        // gets to honor that other preference, so without this check a
        // worker who explicitly wants Juice could get swept into Dairy's
        // generic backfill purely on an alphabetical id tiebreak, and
        // never get the zone they actually asked for. Rating breaks ties
        // after that.
        //
        // Locked With is a hard requirement, not just a scheduling nicety,
        // so it gets weighed before rating too: anyone whose Locked With
        // partner is ALSO still sitting in the general pool would have
        // their pair split by picking them alone — that's an avoidable
        // break, since the pair could stay together instead. Those
        // candidates sort behind everyone else so the backfill reaches for
        // an unattached worker first. Compatibility (incompatibleWith) is
        // filtered out entirely, same hard rule fillZones uses everywhere —
        // and so is anyone who has this zone in Won't Work (excludedZones),
        // same as Dairy/Frozen's guaranteed headcount never overrides a
        // hard incompatibility.
        const rawBackfillPool = pool.filter(
          w => !alreadyIn.has(w.id) && !w.fixedDepartment && !w.departmentRotationPool && !isExcludedZone(w, zone.id)
        );
        const availableIds = new Set(rawBackfillPool.map(w => w.id));
        function wouldSplitLock(w) {
          return w.lockedWith.some(id => availableIds.has(id));
        }
        const backfillPool = rawBackfillPool
          .filter(w => !group.some(m => isIncompatible(w, m)))
          .sort((a, b) => compareArrays(
            [zonePrefRank(a, zone.id), a.preferredZones.length ? 1 : 0, wouldSplitLock(a) ? 1 : 0, ratingOrder[a.productionRating], a.id],
            [zonePrefRank(b, zone.id), b.preferredZones.length ? 1 : 0, wouldSplitLock(b) ? 1 : 0, ratingOrder[b.productionRating], b.id]
          ));

        const picked = [];
        const pickedIds = new Set();
        let slotsLeft = target - group.length;
        for (const candidate of backfillPool) {
          if (slotsLeft <= 0) break;
          if (pickedIds.has(candidate.id)) continue;
          if (!wouldSplitLock(candidate)) {
            picked.push(candidate);
            pickedIds.add(candidate.id);
            slotsLeft -= 1;
            continue;
          }
          // Every remaining candidate here would split a lock. Bring the
          // whole pair in together if this zone genuinely has 2 real open
          // seats for them — never as a lone half, and never by running
          // Dairy or Frozen over its guaranteed headcount to make room.
          // That headcount isn't a soft target: every body Dairy/Frozen
          // takes beyond what they actually need is a body grocery didn't
          // get, and grocery is the side that's chronically short. If
          // there isn't a clean 2-seat fit here, this candidate is
          // skipped entirely (not picked alone, not split) — the seat
          // stays open (flagged fixed_department_understaffed below) and
          // the pair falls through to fillZones together, where they'll
          // most likely land in grocery as a unit — exactly where the
          // help is actually needed.
          const partnerId = candidate.lockedWith.find(id => availableIds.has(id) && !pickedIds.has(id));
          const partner = partnerId ? idToWorker[partnerId] : null;
          const partnerOk = partner && !isIncompatible(candidate, partner) && !group.some(m => isIncompatible(partner, m));
          if (partnerOk && slotsLeft >= 2) {
            picked.push(candidate, partner);
            pickedIds.add(candidate.id);
            pickedIds.add(partner.id);
            slotsLeft -= 2;
          }
          // else: skip — leave this candidate (and their partner) for
          // fillZones rather than seating one alone or overstaffing.
        }

        if (picked.length) {
          backfilled = true;
          group = group.concat(picked);
        }
      }

      if (!group.length) continue;

      const assignment = assignments[zone.id];
      assignment.workerIds = group.map(w => w.id);
      addFlag(assignment, "fixed_department");
      if (backfilled) addFlag(assignment, "fixed_department_backfill");
      if (group.length < target) addFlag(assignment, "fixed_department_understaffed");
      assignment.workloadHours = workloadHoursFor(zone, group, settings);

      for (const w of group) {
        w.hoursAssignedTonight += assignment.workloadHours;
        w.zonesAssignedTonight.push(zone.id);
        const idx = pool.indexOf(w);
        if (idx >= 0) pool.splice(idx, 1);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Top-level orchestration
  // ---------------------------------------------------------------------
  function assignNight(workers, zones, settings, rotationKey) {
    const active = workers.filter(w => w.active);
    for (const w of active) {
      w.hoursAssignedTonight = 0;
      w.zonesAssignedTonight = [];
    }
    const workersById = Object.fromEntries(active.map(w => [w.id, w]));
    const assignments = {};
    zones.forEach(z => {
      assignments[z.id] = makeAssignment(z.id);
    });

    let pool = [...active];
    assignFixedDepartments(zones, assignments, pool, settings, rotationKey); // Step 0.5
    fillZones(zones, pool, settings, assignments, rotationKey); // Step 1 + Step 2 (+2.4)
    mergeLightSoloZones(zones, assignments, workersById, settings); // Step 2.55
    anchorStrugglingZones(zones, assignments, workersById, settings); // Step 2.65
    rebalanceOverstaffedZones(zones, assignments, workersById, settings); // Step 2.7
    freeDonorFromPreferredPair(zones, assignments, workersById, settings); // Step 2.72
    stackLeftoverZones(zones, assignments, workersById, settings); // Step 3.1-3.2

    const stillIdle = active.filter(w => !w.zonesAssignedTonight.length);
    reinforceWithIdleWorkers(zones, assignments, stillIdle, workersById, settings); // Step 3.3
    rebalanceLightZones(zones, assignments, workersById, settings); // Step 2.6
    protectSoloNewHires(zones, assignments, stillIdle, workersById, settings); // Step 3.5

    const [shortfallHours, , overByWorker] = computeShortfall(assignments, workersById, settings); // Step 3.4
    const zoneById = Object.fromEntries(zones.map(z => [z.id, z]));

    const notes = [];
    for (const [zid, a] of Object.entries(assignments)) {
      const zone = zoneById[zid];
      if (zone.department !== "dairy" && zone.department !== "frozen") continue;
      if (!a.workerIds.length) {
        notes.push(`${zoneLabel(zone)} has nobody assigned tonight — the active roster had nobody available at all to cover it, even after trying to backfill.`);
      } else if (a.flags.includes("fixed_department_understaffed")) {
        const names = a.workerIds.map(wid => workersById[wid].name).join(", ");
        notes.push(
          `${zoneLabel(zone)} is short its usual headcount tonight — only ${a.workerIds.length} of ${targetGroupSize(zone, settings)} assigned even after backfilling from the general pool: ${names}.`
        );
      } else if (a.flags.includes("fixed_department_backfill")) {
        const names = a.workerIds.map(wid => workersById[wid].name).join(", ");
        notes.push(`${zoneLabel(zone)} needed help from the general pool tonight to hit its usual headcount: ${names}.`);
      }
    }

    // Grocery/Juice zones don't get the same dedicated note above (their
    // headcount target moves with the case count, so "short of target" is
    // normal on some nights, not worth a note every time) — but a zone
    // left at literal zero is never normal, and on a badly short-staffed
    // night the baseline-first fill and the leftover-stacking hour cap can
    // both legitimately end with a zone uncovered. That should never be
    // silent just because it isn't Dairy or Frozen.
    for (const [zid, a] of Object.entries(assignments)) {
      const zone = zoneById[zid];
      if (zone.department === "dairy" || zone.department === "frozen") continue;
      if (!a.workerIds.length) {
        notes.push(`${zoneLabel(zone)} has nobody assigned tonight — not enough crew to cover it without pushing someone over the hour cap.`);
      }
    }

    // A light-aisle merge is worth a note too, purely for visibility — it's
    // a deliberate, correct outcome (rule 3), not a problem, but it's
    // exactly the kind of thing a supervisor glancing at the plan should
    // see spelled out rather than have to notice from two zone cards
    // sharing the same three names.
    const mergedZoneIds = Object.entries(assignments)
      .filter(([, a]) => a.flags.includes("merged_light_pair_team"))
      .map(([zid]) => zid);
    const seenMergedPairs = new Set();
    for (const zid of mergedZoneIds) {
      const teamIds = assignments[zid].workerIds;
      const partnerZid = mergedZoneIds.find(
        other => other !== zid && !seenMergedPairs.has(other) && assignments[other].workerIds.length === teamIds.length && assignments[other].workerIds.every(id => teamIds.includes(id))
      );
      if (!partnerZid || seenMergedPairs.has(zid)) continue;
      seenMergedPairs.add(zid);
      seenMergedPairs.add(partnerZid);
      const names = teamIds.map(wid => workersById[wid].name).join(", ");
      notes.push(
        `${zoneLabel(zoneById[zid])} and ${zoneLabel(zoneById[partnerZid])} are both light tonight, so the same team (${names}) is covering both instead of leaving one of them with a lone worker.`
      );
    }

    // A solo new hire is called out on its own, separate from the routine
    // understaffed note above — this is the one case protectSoloNewHires
    // tried and genuinely couldn't fix (nobody anywhere could be spared
    // without creating a second solo situation), so it needs a human to
    // look at it, not just a flag buried in the zone card.
    for (const [zid, a] of Object.entries(assignments)) {
      if (!a.flags.includes("new_hire_left_solo")) continue;
      const zone = zoneById[zid];
      const soloWorker = a.workerIds.length === 1 ? workersById[a.workerIds[0]] : null;
      notes.push(
        `${soloWorker ? soloWorker.name : "A new hire"} is working ${zoneLabel(zone)} alone tonight — nobody else was available to partner them without leaving another zone equally short-handed. Worth a supervisor check-in.`
      );
    }

    if (shortfallHours > 0.001) {
      const workerLines = Object.entries(overByWorker)
        .sort((a, b) => b[1] - a[1])
        .map(([wid, over]) => `${workersById[wid].name} (${workersById[wid].hoursAssignedTonight.toFixed(2)}h, +${over.toFixed(2)}h over)`);
      notes.push(
        `Short-staffed tonight: ${Object.keys(overByWorker).length} worker(s) over the ${settings.maxZoneHoursPerWorker}h cap once their whole night is totaled up: ${workerLines.join(", ")} — ${shortfallHours.toFixed(
          2
        )}h uncovered in total. No call-in option assumed — supervisor call on how to run over.`
      );
    }

    const unassigned = active.filter(w => !w.zonesAssignedTonight.length);
    if (unassigned.length) {
      const names = unassigned.map(w => w.name).join(", ");
      notes.push(
        `${unassigned.length} worker(s) had no zone assignment tonight, because every zone already had its target headcount without them: ${names}. Use the redistribution suggestions to see where they could help.`
      );
    }

    return { assignments, shortfallHours, notes };
  }

  // ---------------------------------------------------------------------
  // Step 2.5 — unassigned worker redistribution (proposed, not auto-applied)
  // ---------------------------------------------------------------------
  function suggestRedistribution(unassigned, zones, assignments, workersById, settings) {
    const zoneById = Object.fromEntries(zones.map(z => [z.id, z]));
    const workingGroups = {};
    for (const [zid, a] of Object.entries(assignments)) {
      workingGroups[zid] = a.workerIds.map(wid => workersById[wid]);
    }

    const suggestions = [];
    for (const worker of unassigned) {
      let eligible = Object.entries(workingGroups).filter(
        ([zid, group]) =>
          zoneById[zid].estimationMethod !== "fixed_duration" &&
          group.length < settings.maxGroupSize &&
          !group.some(w => isIncompatible(worker, w)) &&
          !isExcludedZone(worker, zid)
      );
      if (!eligible.length) continue;
      eligible.sort((p1, p2) =>
        compareArrays(
          [needsExtraHelp(p1[0], assignments) ? 0 : 1, ratingMismatchPenalty(worker, p1[1]), -workloadHoursFor(zoneById[p1[0]], p1[1], settings)],
          [needsExtraHelp(p2[0], assignments) ? 0 : 1, ratingMismatchPenalty(worker, p2[1]), -workloadHoursFor(zoneById[p2[0]], p2[1], settings)]
        )
      );
      const [zid, group] = eligible[0];
      group.push(worker);
      const projected = workloadHoursFor(zoneById[zid], group, settings);
      suggestions.push({ workerId: worker.id, workerName: worker.name, zoneId: zid, zoneLabel: zoneLabel(zoneById[zid]), projectedWorkloadHours: projected });
    }
    return suggestions;
  }

  function applyRedistribution(suggestions, zones, assignments, workersById, settings) {
    const zoneById = Object.fromEntries(zones.map(z => [z.id, z]));
    for (const s of suggestions) {
      const worker = workersById[s.workerId];
      const assignment = assignments[s.zoneId];
      assignment.workerIds.push(worker.id);
      addFlag(assignment, "redistributed");
      const group = assignment.workerIds.map(wid => workersById[wid]);
      const newWorkload = workloadHoursFor(zoneById[s.zoneId], group, settings);
      const delta = newWorkload - assignment.workloadHours;
      assignment.workloadHours = newWorkload;
      for (const w of group) {
        if (w.id === worker.id) w.hoursAssignedTonight += newWorkload;
        else w.hoursAssignedTonight += delta;
      }
      worker.zonesAssignedTonight.push(s.zoneId);
    }
  }

  return {
    STRUGGLE_FLAG,
    ZONE_DEFS,
    makeSettings,
    makeWorker,
    makeZones,
    zoneLabel,
    targetGroupSize,
    workloadHoursFor,
    effectiveCapacity,
    isIncompatible,
    isLockedPair,
    isExcludedZone,
    incompatibilityNote,
    assignNight,
    suggestRedistribution,
    applyRedistribution,
    assignFixedDepartments,
    fillZones,
    anchorStrugglingZones,
    rebalanceOverstaffedZones,
    freeDonorFromPreferredPair,
    stackLeftoverZones,
    reinforceWithIdleWorkers,
    rebalanceLightZones,
    mergeLightSoloZones,
    protectSoloNewHires,
    computeShortfall,
  };
});
