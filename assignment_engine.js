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

  function incompatibilityNote(a, b) {
    if (a.incompatibilityNotes && a.incompatibilityNotes[b.id]) return a.incompatibilityNotes[b.id];
    if (b.incompatibilityNotes && b.incompatibilityNotes[a.id]) return b.incompatibilityNotes[a.id];
    return null;
  }

  function filterCompatible(candidates, group) {
    return candidates.filter(c => !group.some(w => isIncompatible(c, w)));
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
  function fillZones(zones, pool, settings, assignments) {
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
          ([a, b]) => !isIncompatible(a, b) && !group.some(m => isIncompatible(a, m) || isIncompatible(b, m))
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
        candidates = filterCompatible(candidates, group);
        candidates.sort((a, b) => compareArrays(candidateScore(a, zone, group), candidateScore(b, zone, group)));
        while (remaining[zid] > 0 && candidates.length) {
          const pick = candidates.shift();
          if (assignedIds.has(pick.id)) continue;
          assignment.workerIds.push(pick.id);
          assignedIds.add(pick.id);
          group.push(pick);
          remaining[zid] -= 1;
          candidates = filterCompatible(candidates, group);
          candidates.sort((a, b) => compareArrays(candidateScore(a, zone, group), candidateScore(b, zone, group)));
        }
      }
    }

    const competing = zones.filter(z => z.department !== "dairy" && z.department !== "frozen");

    // ---------------------------------------------------------------------
    // Baseline pass — every competing zone (grocery + Juice) gets its first
    // 2 people before any zone is allowed to grow past 2. One seat at a
    // time, round-robin across zones, rather than fully draining the pool
    // into the heaviest zone before the next one gets a look — that
    // ordering is exactly what let a zone at the back of the queue (Juice,
    // on a heavy night) end up with nobody at all. Round-robin means a
    // pool shortfall lands as "a few zones one short of their pair"
    // instead of "whoever's last in line gets zero."
    // ---------------------------------------------------------------------
    const BASELINE_HEADCOUNT = 2;
    let stillNeedsBaseline = true;
    while (stillNeedsBaseline) {
      stillNeedsBaseline = false;
      for (const zone of competing) {
        const group = groupFor(zone.id);
        if (group.length >= BASELINE_HEADCOUNT || remaining[zone.id] <= 0) continue;
        const rawLeftover = pool.filter(w => !assignedIds.has(w.id));
        const leftover = filterCompatible(rawLeftover, group);
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
    // heaviest need first. This is the same priority order as before; it
    // just no longer runs BEFORE zones have their minimum coverage.
    // ---------------------------------------------------------------------
    const ordered = [...competing].sort((a, b) =>
      compareArrays([a.department === "grocery" ? 0 : 1, -targets[a.id]], [b.department === "grocery" ? 0 : 1, -targets[b.id]])
    );

    for (const zone of ordered) {
      const assignment = assignments[zone.id];
      const group = groupFor(zone.id);
      let blockedByIncompatibility = false;
      while (remaining[zone.id] > 0) {
        const rawLeftover = pool.filter(w => !assignedIds.has(w.id));
        let leftover = filterCompatible(rawLeftover, group);
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
      const candidates = filterCompatible(pool, group);
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
          const remainingDonor = donorGroup.filter(m => m.id !== donorPick.id);
          if (remainingDonor.some(m => isLockedPair(donorPick, m))) continue;
          for (const strugglerPick of targetGroup) {
            if (strugglerPick.productionRating === "on_pace") continue;
            if (remainingDonor.some(m => isIncompatible(strugglerPick, m))) continue;
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
      const candidates = filterCompatible(idlePool, group);
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
        if (!a.workerIds.length || needsExtraHelp(zid, assignments)) continue;
        if (a.workloadHours > settings.groceryTargetHours * settings.lightLoadThreshold) continue;
        const group = a.workerIds.map(wid => workersById[wid]);
        if (a.workerIds.some(wid => heavyAssignment.workerIds.includes(wid))) continue;
        if (heavyAssignment.workerIds.length + group.length > settings.maxGroupSize) continue;
        if (group.some(w => heavyGroup.some(hw => isIncompatible(w, hw)))) continue;
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
        // Anyone who explicitly prefers this zone gets first claim on the
        // backfill seats. Otherwise, someone with NO stated zone
        // preference at all is preferred over someone who asked for a
        // DIFFERENT zone (e.g. Juice) — this runs before fillZones ever
        // gets to honor that other preference, so without this check a
        // worker who explicitly wants Juice could get swept into Dairy's
        // generic backfill purely on an alphabetical id tiebreak, and
        // never get the zone they actually asked for. Rating breaks ties
        // after that.
        const backfillPool = pool
          .filter(w => !alreadyIn.has(w.id) && !w.fixedDepartment && !w.departmentRotationPool)
          .sort((a, b) => compareArrays(
            [zonePrefRank(a, zone.id), a.preferredZones.length ? 1 : 0, ratingOrder[a.productionRating], a.id],
            [zonePrefRank(b, zone.id), b.preferredZones.length ? 1 : 0, ratingOrder[b.productionRating], b.id]
          ));
        const picked = backfillPool.slice(0, target - group.length);
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
    fillZones(zones, pool, settings, assignments); // Step 1 + Step 2 (+2.4)
    anchorStrugglingZones(zones, assignments, workersById, settings); // Step 2.65
    rebalanceOverstaffedZones(zones, assignments, workersById, settings); // Step 2.7
    stackLeftoverZones(zones, assignments, workersById, settings); // Step 3.1-3.2

    const stillIdle = active.filter(w => !w.zonesAssignedTonight.length);
    reinforceWithIdleWorkers(zones, assignments, stillIdle, workersById, settings); // Step 3.3
    rebalanceLightZones(zones, assignments, workersById, settings); // Step 2.6

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
        ([zid, group]) => zoneById[zid].estimationMethod !== "fixed_duration" && group.length < settings.maxGroupSize && !group.some(w => isIncompatible(worker, w))
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
    incompatibilityNote,
    assignNight,
    suggestRedistribution,
    applyRedistribution,
    assignFixedDepartments,
    fillZones,
    anchorStrugglingZones,
    rebalanceOverstaffedZones,
    stackLeftoverZones,
    reinforceWithIdleWorkers,
    rebalanceLightZones,
    computeShortfall,
  };
});
