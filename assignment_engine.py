"""
Aisle Freight Scheduler — Assignment Algorithm
Implements design doc section 8 (Zone Group Sizing, Fully-Staffed Assignment,
Short-Staffed Assignment with reinforcement + shortfall reporting).

This module has no OCR/photo dependency — it operates purely on Worker and Zone
data, so it can be built and tested before any camera/parsing work exists.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from datetime import date
from enum import Enum
from typing import Optional


# ---------------------------------------------------------------------------
# Ratings & efficiency (design doc §6 Worker.production_rating)
# ---------------------------------------------------------------------------
class Rating(str, Enum):
    ON_PACE = "on_pace"
    NEEDS_IMPROVEMENT = "needs_improvement"
    NEW = "new"


MAX_ZONE_PREFERENCES = 3  # 1st / 2nd / 3rd choice — matches the Worker Roster UI
STRUGGLE_FLAG = "likely_to_struggle_multiple_underperformers"  # 2+ needs_improvement/new stacked together


# ---------------------------------------------------------------------------
# Settings (design doc §6 Settings) — all editable in real app; hardcoded
# defaults here match the design doc's agreed starting values.
# ---------------------------------------------------------------------------
@dataclass
class Settings:
    case_per_minute_rate: float = 1.0          # cases handled per minute, per 1.0x-efficiency worker
    max_zone_hours_per_worker: float = 5.5     # hard cap, after lunch/breaks/zone time
    grocery_target_hours: float = 4.0          # soft target for grocery zones
    max_group_size: int = 4                    # hard ceiling, diminishing returns past this
    needs_improvement_efficiency_factor: float = 0.75
    new_hire_efficiency_factor: float = 0.5
    juice_fixed_duration_hours: float = 3.0    # placeholder pending real completion data
    dairy_fixed_duration_hours: float = 4.0    # placeholder pending real completion data
    frozen_fixed_duration_hours: float = 4.0   # placeholder pending real completion data
    light_load_threshold: float = 0.5          # workload_hours at/below (grocery_target_hours * this) is "light enough to lend a hand elsewhere"

    def efficiency(self, rating: Rating) -> float:
        return {
            Rating.ON_PACE: 1.0,
            Rating.NEEDS_IMPROVEMENT: self.needs_improvement_efficiency_factor,
            Rating.NEW: self.new_hire_efficiency_factor,
        }[rating]


# ---------------------------------------------------------------------------
# Worker (design doc §6)
# ---------------------------------------------------------------------------
@dataclass
class Worker:
    id: str
    name: str
    active: bool = True
    preferred_zones: list[str] = field(default_factory=list)
    # Weighted 1st/2nd/3rd choice, in that order (index 0 = 1st choice). The
    # weighting isn't a numeric score — it's a strict priority order: every
    # active worker's 1st choice is attempted, across every zone, before
    # anyone's 2nd choice is even considered, and 2nd before 3rd. Capped at
    # MAX_ZONE_PREFERENCES (3) to match "pick your top 3" in the UI.
    # Unordered — "any of these people are fine to pair with," not ranked.
    # Can be one-directional (A lists B without B listing A back) or mutual;
    # mutual gets a stronger scoring bonus (see _partner_bonus).
    preferred_partners: list[str] = field(default_factory=list)
    incompatible_with: list[str] = field(default_factory=list)  # "oil and water" — hard exclusion, not a preference
    # Purely informational severity/reason label per incompatible_with
    # entry (other worker's id -> free-text note, e.g. "absolutely hate
    # each other, never mix"). Every incompatible_with entry is enforced
    # with exactly the same hard weight regardless of what's noted here —
    # this changes nothing about the assignment logic, it's just context
    # for the supervisor reading the Worker Roster or the output screen.
    incompatibility_notes: dict[str, str] = field(default_factory=dict)
    production_rating: Rating = Rating.ON_PACE
    unsuitable_for_new_hires: bool = False  # difficult personality — never paired with a `new` worker, same hard weight as incompatible_with
    # A hard "must always be together" requirement — stronger than
    # preferred_partners (which is just a scoring bonus that can still lose
    # to other pressures). Two people listed here are never split, full
    # stop, even when splitting one off would otherwise help balance a
    # struggling zone — the whole point is that their combined performance
    # together is worth more than what a rebalance would gain elsewhere.
    # Checked bidirectionally like incompatible_with, so it only needs to
    # be entered on one side.
    locked_with: list[str] = field(default_factory=list)
    # These two fields cover zones that aren't filled from the general
    # preference-matched pool at all — only specific trained people ever
    # cover them. `fixed_department` means this worker covers that
    # department (matched against Zone.department) every single night, no
    # rotation. `department_rotation_pool` means this worker is one of a
    # named group who take turns covering that department when the pool is
    # bigger than the nightly headcount (see assign_fixed_departments()).
    fixed_department: Optional[str] = None
    department_rotation_pool: Optional[str] = None

    # Populated during assignment — not part of the "stored" worker profile,
    # just bookkeeping for a single night's run.
    hours_assigned_tonight: float = field(default=0.0, repr=False)
    zones_assigned_tonight: list[str] = field(default_factory=list, repr=False)

    def __post_init__(self):
        # enforce the "top 3 choices" cap rather than silently accepting an
        # arbitrarily long ranked list
        if len(self.preferred_zones) > MAX_ZONE_PREFERENCES:
            self.preferred_zones = self.preferred_zones[:MAX_ZONE_PREFERENCES]

    def remaining_capacity(self, settings: Settings) -> float:
        return max(0.0, settings.max_zone_hours_per_worker - self.hours_assigned_tonight)


# ---------------------------------------------------------------------------
# Zone (design doc §5 / §6)
# ---------------------------------------------------------------------------
@dataclass
class Zone:
    id: str
    aisles: str
    department: str  # "grocery" or "juice"
    case_count: int = 0
    estimation_method: str = "case_rate"  # "case_rate" | "fixed_duration"
    # Only meaningful for fixed_duration zones. None means "use the old
    # juice default of 2" — juice never had a reason to be anything else.
    # Dairy/Frozen set this explicitly (3 and 2) since headcount there is a
    # fixed daily staffing decision, not something case volume drives.
    fixed_headcount: Optional[int] = None

    def total_hours(self, settings: Settings) -> float:
        """Raw labor-hours the freight requires, independent of headcount."""
        return self.case_count / settings.case_per_minute_rate / 60.0

    def label(self) -> str:
        '''User-facing display label. Grocery and juice zones show their
        actual aisle numbers ("Aisle 10 & 11") since that's how the floor
        thinks about them. Dairy and Frozen aren't numbered aisles in the
        same sense — they're just shown by name.'''
        if self.department in ("dairy", "frozen"):
            return self.aisles
        return f"Aisle {self.aisles}"


# Fixed zone mapping — design doc §5. Stored as data, not hardcoded control
# flow, so it's easy to edit if the store layout changes.
ZONE_DEFS: list[Zone] = [
    Zone("A", "2 & 3", "grocery"),
    Zone("B", "4 & 5", "grocery"),
    Zone("C", "6 & 7", "grocery"),
    Zone("D", "8 & 9", "grocery"),
    Zone("E", "10 & 11", "grocery"),
    Zone("F", "12 & 13", "grocery"),
    Zone("G", "14 & 15", "grocery"),
    Zone("H", "19", "grocery"),
    Zone("I", "20, 21 & 22", "juice", estimation_method="fixed_duration"),
    # Fixed daily headcount, not case-driven — see assign_fixed_departments().
    Zone("J", "Dairy", "dairy", estimation_method="fixed_duration", fixed_headcount=3),
    Zone("K", "Frozen", "frozen", estimation_method="fixed_duration", fixed_headcount=2),
]


def make_zones(case_counts: dict[str, int]) -> list[Zone]:
    """Fresh copies of the zone defs with tonight's case counts filled in."""
    import copy
    zones = copy.deepcopy(ZONE_DEFS)
    for z in zones:
        z.case_count = case_counts.get(z.id, 0)
    return zones


# ---------------------------------------------------------------------------
# Assignment record — one per zone per night
# ---------------------------------------------------------------------------
@dataclass
class Assignment:
    zone_id: str
    worker_ids: list[str] = field(default_factory=list)
    workload_hours: float = 0.0
    flags: list[str] = field(default_factory=list)

    def add_flag(self, text: str):
        if text not in self.flags:
            self.flags.append(text)


@dataclass
class NightResult:
    assignments: dict[str, Assignment]  # zone_id -> Assignment
    shortfall_hours: float = 0.0
    notes: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Core hour math (design doc §6 Zone.workload_hours, §8 Step 1 / Step 2.4)
# ---------------------------------------------------------------------------
def effective_capacity(workers: list[Worker], settings: Settings) -> float:
    return sum(settings.efficiency(w.production_rating) for w in workers)


def workload_hours_for(zone: Zone, workers: list[Worker], settings: Settings) -> float:
    """Realistic per-person clock-time duration for `zone` given the actual
    `workers` assigned. Fixed-duration zones (juice, dairy, frozen) ignore
    headcount entirely — each has its own placeholder duration pending real
    completion-time data."""
    if zone.estimation_method == "fixed_duration":
        if zone.department == "dairy":
            return settings.dairy_fixed_duration_hours
        if zone.department == "frozen":
            return settings.frozen_fixed_duration_hours
        return settings.juice_fixed_duration_hours
    cap = effective_capacity(workers, settings) if workers else 1.0
    return zone.total_hours(settings) / cap


def target_hours_for(zone: Zone, settings: Settings) -> float:
    """The threshold this zone is trying to fit under."""
    return settings.grocery_target_hours if zone.department == "grocery" else settings.max_zone_hours_per_worker


# ---------------------------------------------------------------------------
# Step 1 — Zone group sizing (design doc §8)
# ---------------------------------------------------------------------------
def target_group_size(zone: Zone, settings: Settings) -> int:
    """Ballpark headcount for this zone, assuming standard (1.0x) pace,
    before specific workers are known. Fixed-duration zones don't scale
    with headcount at all — juice defaults to a standard pair, but Dairy
    and Frozen carry their own fixed daily headcount (3 and 2)."""
    if zone.estimation_method == "fixed_duration":
        return zone.fixed_headcount if zone.fixed_headcount is not None else 2
    n = 2
    while True:
        hours = zone.total_hours(settings) / n
        if hours > target_hours_for(zone, settings) and n < settings.max_group_size:
            n += 1
            continue
        break
    return n


# ---------------------------------------------------------------------------
# Preference / balance scoring — used to decide who fills a zone's slots
# ---------------------------------------------------------------------------
def _zone_pref_rank(worker: Worker, zone_id: str) -> int:
    """Lower is better. Not in the list at all = worst (large number)."""
    try:
        return worker.preferred_zones.index(zone_id)
    except ValueError:
        return 99


def _partner_bonus(candidate: Worker, group: list[Worker]) -> int:
    """Lower (more negative) is better. Mutual (both list each other) beats
    one-directional (only one side lists the other) beats no relationship."""
    best = 0
    for w in group:
        candidate_likes = w.id in candidate.preferred_partners
        w_likes = candidate.id in w.preferred_partners
        if candidate_likes and w_likes:
            best = min(best, -2)
        elif candidate_likes or w_likes:
            best = min(best, -1)
    return best


def _is_incompatible(a: Worker, b: Worker) -> bool:
    """Bidirectional — checked from either worker's record, regardless of
    which side it happened to be entered on.

    Also covers a second, directional case: a worker flagged
    `unsuitable_for_new_hires` (a known difficult personality) can never be
    paired with anyone rated `new` — this is folded directly into the same
    hard exclusion used for personal "oil and water" incompatibility, not a
    softer scoring penalty, so it carries exactly the same weight
    everywhere `_is_incompatible` gets checked: initial fill, growth,
    reinforcement, redistribution, the balance pass, and the anchor-swap
    pass. A new hire should be shielded from that person until they've got
    their feet under them, full stop — an available `on_pace` donor is
    never a good enough reason to override that."""
    if b.id in a.incompatible_with or a.id in b.incompatible_with:
        return True
    if a.production_rating == Rating.NEW and b.unsuitable_for_new_hires:
        return True
    if b.production_rating == Rating.NEW and a.unsuitable_for_new_hires:
        return True
    return False


def _is_locked_pair(a: Worker, b: Worker) -> bool:
    """Bidirectional, same pattern as _is_incompatible — only needs to be
    entered on one side. A locked pair is the opposite hard constraint from
    incompatibility: they must always land together, never split apart."""
    return b.id in a.locked_with or a.id in b.locked_with


def incompatibility_note(a: Worker, b: Worker) -> Optional[str]:
    """Looks up the informational severity/reason note for an incompatible
    pair, checked from either side since the note only needs to be entered
    once, wherever the incompatible_with entry itself lives. Returns None
    if there's no note on file (or the pair isn't incompatible at all) —
    purely for display, never consulted by the assignment logic itself."""
    if b.id in a.incompatibility_notes:
        return a.incompatibility_notes[b.id]
    if a.id in b.incompatibility_notes:
        return b.incompatibility_notes[a.id]
    return None


def _filter_compatible(candidates: list[Worker], group: list[Worker]) -> list[Worker]:
    """Hard exclusion, not a score. A candidate incompatible with anyone
    already in the group is simply not a candidate — no amount of
    preference or coverage pressure overrides this (design doc §8 Step 2.0)."""
    return [c for c in candidates if not any(_is_incompatible(c, w) for w in group)]


def _rating_mismatch_penalty(candidate: Worker, group: list[Worker]) -> int:
    """A real night's data: a needs_improvement worker paired with a new
    hire on 2.5h of modeled work took until 5:25am — roughly 3x the
    estimate, not the ~1.25x the additive efficiency model would predict.
    Two slow people together seems to compound rather than just add
    (nobody sets pace, nobody to learn technique from). This is a much
    steeper, specific penalty for that exact mismatch — still a soft
    preference, not a hard block, so it can still happen on a genuinely
    short-staffed night, but the algorithm will actively route around it
    whenever any other candidate exists."""
    existing_ratings = {w.production_rating for w in group}
    if candidate.production_rating == Rating.NEEDS_IMPROVEMENT and Rating.NEW in existing_ratings:
        return 10
    if candidate.production_rating == Rating.NEW and Rating.NEEDS_IMPROVEMENT in existing_ratings:
        return 10
    return 0


def _candidate_score(candidate: Worker, zone: Zone, current_group: list[Worker]) -> tuple:
    """Sort key — Python tuples compare lexicographically, so earlier
    elements dominate. Lower is better (used with sorted())."""
    # A locked pair outranks everything else, including a stated mutual
    # partner preference — it's a hard "must be together," not a bonus.
    locked_bonus = -1 if any(_is_locked_pair(candidate, m) for m in current_group) else 0

    partner_bonus = _partner_bonus(candidate, current_group)

    # Rating-mismatch avoidance sits right after partner bonus — a stated
    # partner relationship still wins, but among candidates with no such
    # tie, dodging a needs_improvement+new pairing matters more than zone
    # preference does.
    rating_mismatch = _rating_mismatch_penalty(candidate, current_group) if zone.department == "grocery" else 0

    # Production-rating balance (Step 2.3): avoid stacking 2+ non-on_pace
    # workers into the same grocery zone group when we have a choice.
    non_on_pace_in_group = sum(1 for w in current_group if w.production_rating != Rating.ON_PACE)
    rating_penalty = 0
    if zone.department == "grocery" and candidate.production_rating != Rating.ON_PACE and non_on_pace_in_group >= 1:
        rating_penalty = 1

    return (locked_bonus, partner_bonus, rating_mismatch, _zone_pref_rank(candidate, zone.id), rating_penalty)


# ---------------------------------------------------------------------------
# Step 2 — Fully-staffed assignment (also the base fill routine used by
# Step 3 when the crew is short; it just runs out of workers sooner)
#
# Filling is preference-rank-driven *across all zones at once* rather than
# zone-by-zone in a fixed order. A strictly sequential zone-by-zone fill has
# a real bug: an early zone with no natural fans will happily absorb workers
# whose actual preference is a zone processed later, stranding people who
# should have ended up together. Processing by preference rank tier avoids
# that — everyone's rank-0 preference is honored (where slots allow) before
# anyone's rank-1 preference is even considered.
# ---------------------------------------------------------------------------
def fill_zones(zones: list[Zone], pool: list[Worker], settings: Settings,
                assignments: dict[str, Assignment]):
    zone_by_id = {z.id: z for z in zones}
    targets = {z.id: target_group_size(z, settings) for z in zones}
    # Dairy and Frozen are handled entirely by assign_fixed_departments()
    # before this function ever runs — only specific trained/rotating
    # people cover them, so the general preference-matched fill must never
    # touch them, whether or not they ended up fully staffed. Forcing
    # remaining to 0 here (rather than back-filling from the general pool)
    # is what keeps a random grocery worker from ever landing in Dairy just
    # because nobody was scheduled for it tonight.
    remaining = {
        zid: 0 if zone_by_id[zid].department in ("dairy", "frozen") else target_group_size(zone_by_id[zid], settings)
        for zid in targets
    }
    assigned_ids: set[str] = {wid for a in assignments.values() for wid in a.worker_ids}

    def group_for(zid: str) -> list[Worker]:
        return [w for w in pool if w.id in assignments[zid].worker_ids]

    # ---- Phase 0: seed mutual partner pairs together, heaviest zones first ----
    # Without this, a zone's *first* pick has no group to score partner_bonus
    # against (an empty group can't favor anyone), so with no zone
    # preferences to break the tie either, the fill just grabs whoever's
    # first in list order — silently splitting up workers who explicitly
    # both listed each other. Seeding known mutual pairs before anything
    # else runs guarantees they land together.
    id_to_worker = {w.id: w for w in pool}
    seed_order = sorted(zones, key=lambda z: (0 if z.department == "grocery" else 1, -targets[z.id]))

    # ---- Phase -1: seed hard-locked pairs first, ahead of even mutual
    # partner preference — a locked pair isn't a bonus, it's a requirement,
    # so it has to win every capacity race, including one where the two
    # members happen to have stated *different* individual zone
    # preferences. Try each pair's own stated preference first (checking
    # both members' lists, since either one naming a zone is enough to
    # anchor them there together); anything left over gets seeded
    # heaviest-zone-first, same as the mutual-pair fallback below. ----
    def _locked_pairs_available():
        pairs, seen = [], set()
        for w in pool:
            if w.id in assigned_ids:
                continue
            for other_id in w.locked_with:
                if other_id in assigned_ids or other_id == w.id:
                    continue
                other = id_to_worker.get(other_id)
                if other:
                    key = tuple(sorted([w.id, other_id]))
                    if key not in seen:
                        seen.add(key)
                        pairs.append((w, other))
        return pairs

    def _seed_locked_pair_into(a: Worker, b: Worker, zid: str) -> bool:
        if zid not in remaining or remaining[zid] < 2:
            return False
        group = group_for(zid)
        if _is_incompatible(a, b):
            return False  # contradictory data on file — don't force it silently
        if any(_is_incompatible(a, m) or _is_incompatible(b, m) for m in group):
            return False
        assignment = assignments[zid]
        assignment.worker_ids.extend([a.id, b.id])
        assigned_ids.update([a.id, b.id])
        group.extend([a, b])
        remaining[zid] -= 2
        return True

    changed = True
    while changed:
        changed = False
        for a, b in _locked_pairs_available():
            for zid in (a.preferred_zones + b.preferred_zones):
                if _seed_locked_pair_into(a, b, zid):
                    changed = True
                    break
            if changed:
                break  # restart — assigned_ids just changed

    for zone in seed_order:
        while True:
            pairs = _locked_pairs_available()
            if not pairs:
                break
            a, b = pairs[0]
            if not _seed_locked_pair_into(a, b, zone.id):
                break

    def _mutual_pairs_available():
        # Only seed pairs where *neither* member has a stated zone
        # preference. If either does, Phase 1's rank-tier fill already
        # reunites mutual partners correctly on its own — the partner_bonus
        # kicks in on the second pick once the first member is placed. Pre-
        # seeding those pairs here would hijack them into "heaviest zone"
        # order and override a zone preference they actually stated.
        pairs, seen = [], set()
        for w in pool:
            if w.id in assigned_ids or w.preferred_zones:
                continue
            for other_id in w.preferred_partners:
                if other_id in assigned_ids or other_id == w.id:
                    continue
                other = id_to_worker.get(other_id)
                if other and not other.preferred_zones and w.id in other.preferred_partners:
                    key = tuple(sorted([w.id, other_id]))
                    if key not in seen:
                        seen.add(key)
                        pairs.append((w, other))
        return pairs

    for zone in seed_order:
        group = group_for(zone.id)
        while remaining[zone.id] >= 2:
            candidates = [
                (a, b) for a, b in _mutual_pairs_available()
                if not _is_incompatible(a, b)
                and not any(_is_incompatible(a, m) or _is_incompatible(b, m) for m in group)
            ]
            if not candidates:
                break
            a, b = candidates[0]
            assignment = assignments[zone.id]
            assignment.worker_ids.extend([a.id, b.id])
            assigned_ids.update([a.id, b.id])
            group.extend([a, b])
            remaining[zone.id] -= 2

    # ---- Phase 1: honor stated preferences, rank tier by rank tier ----
    max_rank = max((len(w.preferred_zones) for w in pool), default=0)
    for rank in range(max_rank):
        by_zone: dict[str, list[Worker]] = {}
        for w in pool:
            if w.id in assigned_ids or rank >= len(w.preferred_zones):
                continue
            zid = w.preferred_zones[rank]
            if zid in remaining and remaining[zid] > 0:
                by_zone.setdefault(zid, []).append(w)

        for zid, candidates in by_zone.items():
            zone = zone_by_id[zid]
            assignment = assignments[zid]
            group = group_for(zid)
            candidates = [c for c in candidates if c.id not in assigned_ids]
            candidates = _filter_compatible(candidates, group)
            candidates.sort(key=lambda w: _candidate_score(w, zone, group))

            while remaining[zid] > 0 and candidates:
                pick = candidates.pop(0)
                if pick.id in assigned_ids:
                    continue
                assignment.worker_ids.append(pick.id)
                assigned_ids.add(pick.id)
                group.append(pick)
                remaining[zid] -= 1
                candidates = _filter_compatible(candidates, group)
                candidates.sort(key=lambda w: _candidate_score(w, zone, group))

    # ---- Phase 2: fill whatever's left with leftover workers ----
    # Grocery-heaviest-first, matching §2's "out of grocery by lunch" goal —
    # time-sensitive zones get first pick of whoever's left over. Dairy and
    # Frozen are excluded entirely — they're not part of the general pool
    # competition at all (see the `remaining` note above), and their real
    # members already got pulled out of `pool` by assign_fixed_departments,
    # so group_for() can't even see them here.
    ordered = sorted(
        [z for z in zones if z.department not in ("dairy", "frozen")],
        key=lambda z: (0 if z.department == "grocery" else 1, -targets[z.id]),
    )
    for zone in ordered:
        assignment = assignments[zone.id]
        group = group_for(zone.id)

        blocked_by_incompatibility = False
        while remaining[zone.id] > 0:
            raw_leftover = [w for w in pool if w.id not in assigned_ids]
            leftover = _filter_compatible(raw_leftover, group)
            if not leftover:
                if raw_leftover:
                    blocked_by_incompatibility = True
                break
            leftover.sort(key=lambda w: _candidate_score(w, zone, group))
            pick = leftover[0]
            if pick.preferred_zones and zone.id not in pick.preferred_zones:
                assignment.add_flag("preference_override")
            assignment.worker_ids.append(pick.id)
            assigned_ids.add(pick.id)
            group.append(pick)
            remaining[zone.id] -= 1

        if len(group) < 2 and zone.department != "juice":
            assignment.add_flag("understaffed_below_pair")
        if blocked_by_incompatibility:
            assignment.add_flag("incompatibility_conflict")

        # Step 2.4 — realistic re-estimate now that real people are assigned;
        # grow the group (from whoever's still unassigned) if the realistic
        # number blows past target and there's room under max_group_size.
        idle_leftover = [w for w in pool if w.id not in assigned_ids]
        before_ids = {w.id for w in idle_leftover}
        _recompute_and_maybe_grow(zone, group, assignment, idle_leftover, settings)
        after_ids = {w.id for w in idle_leftover}
        assigned_ids.update(before_ids - after_ids)  # workers growth just picked

        non_on_pace = [w for w in group if w.production_rating != Rating.ON_PACE]
        if len(non_on_pace) >= 2:
            assignment.add_flag(STRUGGLE_FLAG)

        for w in group:
            w.hours_assigned_tonight += assignment.workload_hours
            w.zones_assigned_tonight.append(zone.id)

    # anyone left in `pool` untouched by either phase just wasn't needed —
    # handled by the "unassigned worker" note in assign_night()


def _recompute_and_maybe_grow(zone: Zone, group: list[Worker], assignment: Assignment,
                               pool: list[Worker], settings: Settings):
    assignment.workload_hours = workload_hours_for(zone, group, settings)
    if zone.estimation_method == "fixed_duration":
        return  # reinforcement never helps a fixed-duration zone

    target = target_hours_for(zone, settings)
    while assignment.workload_hours > target and len(group) < settings.max_group_size:
        candidates = _filter_compatible(pool, group)
        if not candidates:
            break
        pool_sorted = sorted(candidates, key=lambda w: _candidate_score(w, zone, group))
        pick = pool_sorted[0]
        group.append(pick)
        pool.remove(pick)
        assignment.worker_ids.append(pick.id)
        assignment.add_flag("reinforced")
        assignment.workload_hours = workload_hours_for(zone, group, settings)


# ---------------------------------------------------------------------------
# Step 2.65 — Split up clustered underperformers instead of leaving them
# stacked together with at most one anchor. Fill can end up dumping every
# leftover new hire into whichever zone gets processed last, once every
# on_pace worker has already been claimed elsewhere — the rating_penalty in
# _candidate_score only picks the *least-bad* option from whoever's left in
# the pool at that moment, it can't retroactively un-claim on_pace workers
# who already landed in other zones. Real-world data backs up why this
# matters: two underperformers paired together ran 2-3x the modeled
# estimate; a zone with three or four new hires and nobody experienced is
# worse still — nobody to answer a question or set the pace.
# ---------------------------------------------------------------------------
def anchor_struggling_zones(zones: list[Zone], assignments: dict[str, Assignment],
                             workers_by_id: dict[str, Worker], settings: Settings):
    """Runs right after the initial fill, before any short-staffed stacking
    (so every worker still has exactly one zone — no multi-zone bookkeeping
    to untangle). Repeatedly finds a zone with 2+ non-on_pace workers and a
    *capable* donor zone (currently 100% on_pace, 2+ members, so donating
    doesn't create a new cluster there) and swaps one worker each way —
    one non-on_pace worker out to a zone that can actually pair with them,
    one on_pace worker in to anchor the zone left behind. Keeps going until
    every zone has at most one non-on_pace worker, or no more valid donor
    exists (each fully-on_pace zone can only donate once, since after
    donating it's no longer fully on_pace and won't qualify as a donor
    again — this guarantees a swap can never create a new cluster, only
    resolve one). Never touches group size or the incompatibility filter."""
    zone_by_id = {z.id: z for z in zones}
    # Dairy/Frozen are walled off from this pass entirely — they're staffed
    # exclusively by assign_fixed_departments() with specific trained
    # people, never by whoever happens to be a convenient donor/anchor for
    # a grocery zone.
    all_zone_ids = [z.id for z in zones if z.department not in ("dairy", "frozen")]

    def group_for(zid: str) -> list[Worker]:
        return [workers_by_id[wid] for wid in assignments[zid].worker_ids]

    def find_swap_for(target_zid: str):
        """Searches *every* eligible donor zone and every possible
        (donor_pick, struggler_pick) pair within each, rather than
        committing to the first donor zone found — a single fixed-order
        pick can dead-end entirely (e.g. the first donor zone contains a
        worker who's incompatible with every remaining candidate in the
        struggling zone) even when a perfectly good swap exists two zones
        over. Returns the lowest-bond-cost valid swap found, preferring one
        that doesn't break an explicit preferred-partner pairing on either
        side, or None if no valid swap exists anywhere."""
        target_group = group_for(target_zid)
        best = None  # (bond_cost, donor_zid, donor_pick, struggler_pick)
        for donor_zid in all_zone_ids:
            if donor_zid == target_zid:
                continue
            donor_group = group_for(donor_zid)
            if len(donor_group) < 2 or not all(w.production_rating == Rating.ON_PACE for w in donor_group):
                continue
            for donor_pick in donor_group:
                if any(_is_incompatible(donor_pick, m) for m in target_group):
                    continue
                remaining_donor = [m for m in donor_group if m.id != donor_pick.id]
                # never pull donor_pick out alone if that strands a locked
                # partner behind in the donor zone — a locked pair is a hard
                # requirement, not something an anchor swap gets to weigh
                # against convenience
                if any(_is_locked_pair(donor_pick, m) for m in remaining_donor):
                    continue
                for struggler_pick in target_group:
                    if struggler_pick.production_rating == Rating.ON_PACE:
                        continue
                    # struggler_pick must be compatible with whoever *stays*
                    # in the donor zone, not the donor zone as it was before
                    # donor_pick left
                    if any(_is_incompatible(struggler_pick, m) for m in remaining_donor):
                        continue
                    remaining_target = [m for m in target_group if m.id != struggler_pick.id]
                    # same locked-pair protection, other direction — don't
                    # strand struggler_pick's locked partner behind either
                    if any(_is_locked_pair(struggler_pick, m) for m in remaining_target):
                        continue
                    bond_cost = (
                        abs(_partner_bonus(donor_pick, remaining_donor))
                        + abs(_partner_bonus(struggler_pick, [m for m in target_group if m.id != struggler_pick.id]))
                    )
                    if best is None or bond_cost < best[0]:
                        best = (bond_cost, donor_zid, donor_pick, struggler_pick)
        return best

    for _ in range(len(all_zone_ids) * settings.max_group_size):  # generous, bounded safety cap
        target_zid = None
        for zid in all_zone_ids:
            non_on_pace = [w for w in group_for(zid) if w.production_rating != Rating.ON_PACE]
            if len(non_on_pace) >= 2:
                target_zid = zid
                break
        if target_zid is None:
            break  # nobody clustered anymore

        swap = find_swap_for(target_zid)
        if swap is None:
            break  # no valid swap exists anywhere for this zone

        _, donor_zid, donor_pick, struggler_pick = swap
        donor_zone = zone_by_id[donor_zid]
        target_zone = zone_by_id[target_zid]

        assignments[target_zid].worker_ids.remove(struggler_pick.id)
        assignments[target_zid].worker_ids.append(donor_pick.id)
        assignments[donor_zid].worker_ids.remove(donor_pick.id)
        assignments[donor_zid].worker_ids.append(struggler_pick.id)

        donor_pick.zones_assigned_tonight = [z for z in donor_pick.zones_assigned_tonight if z != donor_zid] + [target_zid]
        struggler_pick.zones_assigned_tonight = [z for z in struggler_pick.zones_assigned_tonight if z != target_zid] + [donor_zid]

        new_target_group = group_for(target_zid)
        new_donor_group = group_for(donor_zid)
        new_target_workload = workload_hours_for(target_zone, new_target_group, settings)
        new_donor_workload = workload_hours_for(donor_zone, new_donor_group, settings)
        assignments[target_zid].workload_hours = new_target_workload
        assignments[donor_zid].workload_hours = new_donor_workload

        # nobody's been stacked onto a second zone yet at this point in the
        # pipeline, so it's safe to just set hours_assigned_tonight directly
        # rather than delta-patch it
        for w in new_target_group:
            w.hours_assigned_tonight = new_target_workload
        for w in new_donor_group:
            w.hours_assigned_tonight = new_donor_workload

        assignments[target_zid].add_flag("anchored_with_on_pace_worker")
        assignments[donor_zid].add_flag("lent_on_pace_anchor")

        still_clustered = sum(1 for w in new_target_group if w.production_rating != Rating.ON_PACE) >= 2
        if not still_clustered and STRUGGLE_FLAG in assignments[target_zid].flags:
            assignments[target_zid].flags.remove(STRUGGLE_FLAG)
        if sum(1 for w in new_donor_group if w.production_rating != Rating.ON_PACE) >= 2:
            assignments[donor_zid].add_flag(STRUGGLE_FLAG)  # shouldn't happen given the donor filter, but stay honest if it does


# ---------------------------------------------------------------------------
# Step 2.7 — Overstaffed-zone rebalance. Step 2.4's group-growth pass adds a
# worker to a zone whenever its *ballpark* re-estimate blows past target —
# but it makes that call zone-by-zone, without knowing how heavy every other
# zone will end up once the rest of fill finishes. The result: a zone can
# land at 4 people running at half the 4-hour target while a sibling zone
# two rows over is still well over target with nobody left to send it. Step
# 2.6 (rebalance_light_zones) only ever lends a *whole* light group onto a
# heavy zone — it never notices a zone that's overstaffed rather than
# genuinely light. This pass fills that gap: pull exactly one spare hand out
# of an overstaffed zone (still 3+ people left behind, so nobody drops below
# a pair) and give it to whichever zone is heaviest, as long as the move
# actually narrows the gap on both ends, doesn't push anyone over the 5.5h
# cap, doesn't create an incompatible pairing, and doesn't strand a locked
# partner. Runs right after anchor_struggling_zones, while every worker
# still has exactly one zone tonight — same simplifying assumption that
# pass relies on — so hours_assigned_tonight can be set directly rather than
# delta-patched. Never pulls from (or effectively worsens) a zone already
# flagged as struggling; taking a hand away from a fragile group is the
# opposite of what a supervisor would do.
# ---------------------------------------------------------------------------
def rebalance_overstaffed_zones(zones: list[Zone], assignments: dict[str, Assignment],
                                 workers_by_id: dict[str, Worker], settings: Settings):
    zone_by_id = {z.id: z for z in zones}
    grocery_ids = [z.id for z in zones if z.estimation_method != "fixed_duration"]

    for _ in range(len(grocery_ids)):  # bounded — each successful move consumes one zone's excess, can't loop forever
        heavy_candidates = [
            zid for zid in grocery_ids
            if assignments[zid].worker_ids
            and len(assignments[zid].worker_ids) < settings.max_group_size
            and assignments[zid].workload_hours > settings.grocery_target_hours
        ]
        if not heavy_candidates:
            break
        heavy_zid = max(heavy_candidates, key=lambda zid: assignments[zid].workload_hours)
        heavy_assignment = assignments[heavy_zid]
        heavy_zone = zone_by_id[heavy_zid]
        heavy_group = [workers_by_id[wid] for wid in heavy_assignment.worker_ids]

        # A donor must have a spare hand to give (3+ people, so 2 remain),
        # not already be struggling, and actually be running under target —
        # "overstaffed" specifically, not just "lighter than the heaviest
        # zone."
        donor_ids = [
            zid for zid in grocery_ids
            if zid != heavy_zid
            and len(assignments[zid].worker_ids) > 2
            and not _needs_extra_help(zid, assignments)
            and assignments[zid].workload_hours < settings.grocery_target_hours
        ]
        donor_ids.sort(key=lambda zid: assignments[zid].workload_hours)  # most-overstaffed (lightest) first

        moved = False
        for donor_zid in donor_ids:
            donor_assignment = assignments[donor_zid]
            donor_zone = zone_by_id[donor_zid]
            donor_group = [workers_by_id[wid] for wid in donor_assignment.worker_ids]
            # least-bonded first — nobody with a stated partner tie to
            # someone else still in the donor group gets moved, so this
            # pass can't break up a pairing to chase a slightly better hour
            # balance
            movable = sorted(
                donor_group,
                key=lambda w: abs(_partner_bonus(w, [m for m in donor_group if m.id != w.id])),
            )
            for candidate in movable:
                if any(_is_incompatible(candidate, m) for m in heavy_group):
                    continue
                remaining_donor = [m for m in donor_group if m.id != candidate.id]
                if any(_is_locked_pair(candidate, m) for m in remaining_donor):
                    continue  # would strand their locked partner behind
                projected_heavy = workload_hours_for(heavy_zone, heavy_group + [candidate], settings)
                projected_donor = workload_hours_for(donor_zone, remaining_donor, settings)
                if projected_heavy >= heavy_assignment.workload_hours:
                    continue  # wouldn't actually narrow the gap
                if projected_heavy > settings.max_zone_hours_per_worker:
                    continue  # would push the heavy zone's crew over the hard cap
                if projected_donor > settings.max_zone_hours_per_worker:
                    continue

                donor_assignment.worker_ids.remove(candidate.id)
                heavy_assignment.worker_ids.append(candidate.id)
                candidate.zones_assigned_tonight = [heavy_zid]
                candidate.hours_assigned_tonight = projected_heavy
                donor_assignment.workload_hours = projected_donor
                heavy_assignment.workload_hours = projected_heavy
                for w in remaining_donor:
                    w.hours_assigned_tonight = projected_donor
                for w in heavy_group:
                    w.hours_assigned_tonight = projected_heavy
                donor_assignment.add_flag("lent_spare_hand")
                heavy_assignment.add_flag("received_spare_hand")
                heavy_group.append(candidate)
                moved = True
                break
            if moved:
                break
        if not moved:
            break


# ---------------------------------------------------------------------------
# Step 3 — Short-staffed handling: stack any zone nobody was left to staff
# onto the lightest-loaded existing group (sequential work), then reinforce
# and report an honest shortfall if the crew genuinely can't cover it.
# ---------------------------------------------------------------------------
def stack_leftover_zones(zones: list[Zone], assignments: dict[str, Assignment],
                          workers_by_id: dict[str, Worker], settings: Settings):
    # Dairy/Frozen are excluded even when they end up empty tonight (nobody
    # in the fixed_department/department_rotation_pool was on the roster) —
    # an empty Dairy is an honest "nobody trained for it showed up" signal,
    # not something to paper over by stacking untrained grocery workers
    # onto it.
    leftover = [z for z in zones if not assignments[z.id].worker_ids and z.department not in ("dairy", "frozen")]

    # Dairy/Frozen are also excluded as a *donor* source, not just as a
    # leftover target. Their crew is dedicated to a fixed-duration
    # department assignment (assign_fixed_departments already gave them a
    # full night's workload) — with the new hard-headcount guarantee, J/K
    # always have worker_ids and can carry a light workload_hours (their
    # fixed duration), which made them look like an attractively "light"
    # group to copy wholesale onto an empty grocery zone. That would
    # silently double-book Dairy/Frozen's own people into grocery too,
    # defeating the whole point of a dedicated department.
    donor_zone_ids = {z.id for z in zones if z.department not in ("dairy", "frozen")}

    for zone in leftover:
        candidates = [
            (zid, a) for zid, a in assignments.items()
            if a.worker_ids and zid != zone.id and zid in donor_zone_ids
        ]
        if not candidates:
            continue  # nobody at all to stack onto — pure shortfall, handled below

        def group_load(a: Assignment) -> float:
            members = [workers_by_id[wid] for wid in a.worker_ids]
            return sum(w.hours_assigned_tonight for w in members) / len(members)

        # Prefer a donor that (a) isn't already flagged as struggling —
        # piling more sequential work onto the most vulnerable group (e.g.
        # two new hires with nobody senior to anchor them) is exactly
        # backwards from what a supervisor would do — and (b) hasn't
        # already been tapped as a donor for a *different* leftover zone
        # tonight, so sequential-stacking duty spreads across different
        # people instead of concentrating three aisles' worth of extra
        # hours onto whichever pair happened to be cheapest first. Both are
        # soft preferences, not hard rules: on a genuine shortage night
        # where every candidate is struggling or already tapped, this still
        # falls through to *some* coverage rather than leaving the zone
        # empty — average hours breaks the remaining ties.
        candidates.sort(key=lambda pair: (
            STRUGGLE_FLAG in pair[1].flags,
            "stacked_sequential_donor" in pair[1].flags,
            group_load(pair[1]),
        ))
        _, chosen = candidates[0]
        group = [workers_by_id[wid] for wid in chosen.worker_ids]

        assignment = assignments[zone.id]
        assignment.worker_ids = list(chosen.worker_ids)
        assignment.add_flag("stacked_sequential")
        assignment.workload_hours = workload_hours_for(zone, group, settings)
        chosen.add_flag("stacked_sequential_donor")
        # The leftover zone now carries the exact same crew as the donor it
        # just copied from — without this, it would look like a brand-new,
        # never-used-yet, often-cheaper donor to the *next* leftover zone in
        # this same pass, letting the same pair get picked a third time
        # through the back door instead of actually spreading the load.
        assignment.add_flag("stacked_sequential_donor")

        for w in group:
            w.hours_assigned_tonight += assignment.workload_hours
            w.zones_assigned_tonight.append(zone.id)


def reinforce_with_idle_workers(zones: list[Zone], assignments: dict[str, Assignment],
                                 idle_pool: list[Worker], workers_by_id: dict[str, Worker],
                                 settings: Settings):
    """Best-effort reinforcement using genuinely still-idle workers (never
    assigned to anything tonight). Pulling someone off a zone they're
    already committed to, mid-shift, to help another zone is a real-time
    coordination call — that stays a manual supervisor decision (drag-to-
    reassign in the UI), not something this algorithm auto-decides."""
    zone_by_id = {z.id: z for z in zones}

    def worst_overloaded():
        worst_zid, worst_excess = None, 0.0
        for zid, a in assignments.items():
            zone = zone_by_id[zid]
            if zone.estimation_method == "fixed_duration" or not a.worker_ids:
                continue
            excess = a.workload_hours - settings.max_zone_hours_per_worker
            if excess > worst_excess:
                worst_excess, worst_zid = excess, zid
        return worst_zid, worst_excess

    while idle_pool:
        zid, excess = worst_overloaded()
        if zid is None or excess <= 0:
            break
        assignment = assignments[zid]
        zone = zone_by_id[zid]
        group = [workers_by_id[wid] for wid in assignment.worker_ids]
        if len(assignment.worker_ids) >= settings.max_group_size:
            break  # this zone is maxed out; move on — loop will pick next-worst next pass
        candidates = _filter_compatible(idle_pool, group)
        if not candidates:
            break  # nobody idle is compatible with this group — try nothing further here
        # avoid a needs_improvement+new mismatch when there's any other idle
        # option, then most-slack idle worker first
        candidates.sort(key=lambda w: (_rating_mismatch_penalty(w, group), w.hours_assigned_tonight))
        pick = candidates[0]
        idle_pool.remove(pick)
        assignment.worker_ids.append(pick.id)
        assignment.add_flag("reinforced")
        group.append(pick)
        assignment.workload_hours = workload_hours_for(zone, group, settings)
        pick.hours_assigned_tonight += assignment.workload_hours
        pick.zones_assigned_tonight.append(zid)


def _needs_extra_help(zid: str, assignments: dict[str, Assignment]) -> bool:
    """True if this zone is already flagged as likely to struggle (2+
    needs_improvement/new workers stacked together). These zones get
    priority for any spare hands, ahead of zones that are merely
    numerically heavy — two underperformers together tends to run behind
    in practice even once the efficiency math is already factored into
    workload_hours."""
    return STRUGGLE_FLAG in assignments[zid].flags


def _help_priority_key(zid: str, assignments: dict[str, Assignment]):
    """Sort key for 'which zone most deserves the next spare pair of
    hands' — struggling zones first (regardless of their raw hours),
    heaviest workload_hours as the tiebreaker after that. Lower sorts
    first, so pair with min()."""
    return (0 if _needs_extra_help(zid, assignments) else 1, -assignments[zid].workload_hours)


def rebalance_light_zones(zones: list[Zone], assignments: dict[str, Assignment],
                           workers_by_id: dict[str, Worker], settings: Settings):
    """Step 2.6 — proactive balance pass. Runs on *every* night, not just
    short-staffed ones: even with a full crew, an uneven case split can
    leave one pair finishing with a very light load while another zone
    stays well over the 4-hour target with nobody left in the pool to
    reinforce it (that pool is already empty — everyone has a primary
    zone). Rather than let the light pair sit idle for the rest of the
    shift, stack them onto the zone that needs help most as a second,
    sequential assignment — the same mechanic short-staffed nights already
    use, just applied for balance instead of bare coverage.

    Struggling zones (STRUGGLE_FLAG) get priority for this help regardless
    of their raw hours, and are never treated as a "light" donor zone
    themselves — a zone that's already struggling shouldn't be stripped of
    people to go help somewhere else.

    Only touches grocery (case_rate) zones — juice's fixed duration doesn't
    benefit from extra hands. Never exceeds max_group_size, never pushes
    anyone over the 5.5h cap, and never creates an incompatible pairing."""
    zone_by_id = {z.id: z for z in zones}
    grocery_ids = [z.id for z in zones if z.estimation_method != "fixed_duration"]

    for _ in range(len(grocery_ids)):  # each pass consumes one light group — bounded, can't loop forever
        heavy_candidates = [
            zid for zid in grocery_ids
            if len(assignments[zid].worker_ids) < settings.max_group_size
            and (assignments[zid].workload_hours > settings.grocery_target_hours
                 or _needs_extra_help(zid, assignments))
        ]
        if not heavy_candidates:
            break
        heavy_zid = min(heavy_candidates, key=lambda zid: _help_priority_key(zid, assignments))
        heavy_assignment = assignments[heavy_zid]
        heavy_zone = zone_by_id[heavy_zid]
        heavy_group = [workers_by_id[wid] for wid in heavy_assignment.worker_ids]

        light_options = []
        for zid in grocery_ids:
            if zid == heavy_zid:
                continue
            a = assignments[zid]
            if not a.worker_ids or _needs_extra_help(zid, assignments):
                continue  # nothing to lend, or already struggling themselves
            if a.workload_hours > settings.grocery_target_hours * settings.light_load_threshold:
                continue  # not light enough to spare
            group = [workers_by_id[wid] for wid in a.worker_ids]
            if set(a.worker_ids) & set(heavy_assignment.worker_ids):
                continue  # already stacked together
            if len(heavy_assignment.worker_ids) + len(group) > settings.max_group_size:
                continue
            if any(_is_incompatible(w, hw) for w in group for hw in heavy_group):
                continue
            projected = workload_hours_for(heavy_zone, heavy_group + group, settings)
            if any(w.hours_assigned_tonight + projected > settings.max_zone_hours_per_worker for w in group):
                continue  # would push someone over the hard cap
            light_options.append((zid, a, group))

        if not light_options:
            break

        # avoid lending a group that would create a needs_improvement+new
        # mismatch with the heavy zone's existing crew, when another light
        # group is available; lightest workload_hours breaks ties after that
        def _mismatch_cost(light_group_members):
            return sum(_rating_mismatch_penalty(w, heavy_group) for w in light_group_members)

        _, light_assignment, light_group = min(
            light_options, key=lambda t: (_mismatch_cost(t[2]), t[1].workload_hours)
        )

        heavy_assignment.worker_ids.extend(light_assignment.worker_ids)
        heavy_assignment.add_flag("balanced_second_zone")
        light_assignment.add_flag("lent_to_heavier_zone")

        new_group = heavy_group + light_group
        old_workload = heavy_assignment.workload_hours
        new_workload = workload_hours_for(heavy_zone, new_group, settings)
        delta = new_workload - old_workload
        heavy_assignment.workload_hours = new_workload
        for w in heavy_group:
            w.hours_assigned_tonight += delta  # the zone got faster/slower for the original crew too
        for w in light_group:
            w.hours_assigned_tonight += new_workload  # they work their light zone, then this one, sequentially
            w.zones_assigned_tonight.append(heavy_zid)


def compute_shortfall(assignments: dict[str, Assignment], workers_by_id: dict[str, Worker],
                       settings: Settings) -> tuple[float, list[str], dict[str, float]]:
    """Total hours by which the crew is over-cap tonight, which zones are
    affected, and a per-worker breakdown of who's over and by how much.

    A stacked worker's overage is a property of their *whole night*
    (hours_assigned_tonight, summed across every zone they touched), not any
    single zone — so it must be counted once per worker here, not once per
    zone they happen to appear in. Counting it per zone-membership would
    silently multiply the same overage by however many zones that worker
    was stacked across. The `over_cap` flag is still applied to every zone
    an over-cap worker appears in (useful for the supervisor to see where
    that person shows up), but the *hours* total is deduped per worker."""
    over_by_worker: dict[str, float] = {}
    affected_zones = []
    for zid, a in assignments.items():
        if not a.worker_ids:
            affected_zones.append(zid)
            continue
        zone_has_over_worker = False
        for wid in a.worker_ids:
            w = workers_by_id[wid]
            over = w.hours_assigned_tonight - settings.max_zone_hours_per_worker
            if over > 0.001:
                over_by_worker[wid] = over  # same value regardless of which zone we're looking at
                zone_has_over_worker = True
        if zone_has_over_worker:
            a.add_flag("over_cap")
            affected_zones.append(zid)
    total_excess = sum(over_by_worker.values())
    return total_excess, affected_zones, over_by_worker


# ---------------------------------------------------------------------------
# Step 0.5 — Fixed departments (Dairy, Frozen). These never compete in the
# general preference-matched fill at all — only specific trained people
# cover them, so they're pulled out of the pool before fill_zones even
# starts. Some are there every single night (Worker.fixed_department, e.g.
# Drogo & Danarys on Frozen); others take turns on a rotation
# (Worker.department_rotation_pool) when more people are trained for a
# department than the nightly headcount needs.
# ---------------------------------------------------------------------------
def _rotate_pick(candidates: list[Worker], n: int, rotation_key: int) -> list[Worker]:
    """Deterministically picks `n` of `candidates` for tonight. Sorts by id
    first so the rotation is reproducible, then walks a window starting at
    `rotation_key % len(candidates)` — so as `rotation_key` advances by 1
    each real day (see assign_fixed_departments), the window slides and
    everyone in the pool gets roughly equal turns instead of the same
    subset winning every night. No persisted state needed between runs;
    today's date alone is enough to know whose turn it is."""
    if n <= 0 or not candidates:
        return []
    ordered = sorted(candidates, key=lambda w: w.id)
    start = rotation_key % len(ordered)
    return [ordered[(start + i) % len(ordered)] for i in range(min(n, len(ordered)))]


def assign_fixed_departments(zones: list[Zone], assignments: dict[str, Assignment],
                              pool: list[Worker], settings: Settings,
                              rotation_key: Optional[int] = None):
    """Runs before fill_zones. Pulls dedicated + rotation-eligible workers
    for Dairy/Frozen straight out of the pool and assigns them directly —
    these zones are never part of the general preference-matched
    competition. `rotation_key` defaults to today's day-of-year, so calling
    this on consecutive real days naturally rotates who's picked; pass an
    explicit int to preview a specific day's rotation instead.

    Dairy and Frozen headcount is a hard requirement, not a best-effort
    target — every night needs 3 in Dairy and 2 in Frozen, full stop. If the
    dedicated + rotation people don't add up to that (someone's out, the
    rotation pool itself is short-staffed, whatever), the remaining slots
    get backfilled straight from the general pool rather than left short.
    On-pace workers are pulled first for the backfill — dropping someone
    still learning the ropes into an unfamiliar department with no backup
    is worse than borrowing an experienced grocery regular for the night —
    and only from genuinely general-pool workers; anyone reserved for a
    *different* fixed department (their own `fixed_department` or
    `department_rotation_pool`) is never poached, even if this department
    happens to get processed first. Every backfilled slot is flagged
    (`fixed_department_backfill`), and if
    the whole active roster still isn't enough to reach the target, that's
    flagged too (`fixed_department_understaffed`) rather than pretending
    the gap didn't happen — never a silent change either way."""
    if rotation_key is None:
        rotation_key = date.today().toordinal()

    rating_order = {Rating.ON_PACE: 0, Rating.NEEDS_IMPROVEMENT: 1, Rating.NEW: 2}

    for zone in zones:
        if zone.estimation_method != "fixed_duration" or zone.department not in ("dairy", "frozen"):
            continue  # only these two are pre-filled fixed departments right now

        dedicated = [w for w in pool if w.fixed_department == zone.department]
        target = target_group_size(zone, settings)
        slots_left = max(0, target - len(dedicated))

        rotation_candidates = [w for w in pool if w.department_rotation_pool == zone.department]
        chosen_rotation = _rotate_pick(rotation_candidates, slots_left, rotation_key)

        group = dedicated + chosen_rotation

        backfilled = False
        if len(group) < target:
            already_in = {w.id for w in group}
            # Backfill only pulls from truly general-pool workers — anyone
            # with their own fixed_department or department_rotation_pool
            # set (even for a *different* department) is reserved for that
            # department and must never get poached as generic filler here.
            # Without this, Dairy (processed first) could scoop up Frozen's
            # own dedicated people just because they happened to sort early
            # by id, leaving Frozen short of the very people who are
            # supposed to be there every night.
            backfill_pool = sorted(
                (w for w in pool
                 if w.id not in already_in
                 and not w.fixed_department
                 and not w.department_rotation_pool),
                key=lambda w: (rating_order[w.production_rating], w.id),
            )
            picked = backfill_pool[: target - len(group)]
            if picked:
                backfilled = True
                group = group + picked

        if not group:
            continue

        assignment = assignments[zone.id]
        assignment.worker_ids = [w.id for w in group]
        assignment.add_flag("fixed_department")
        if backfilled:
            assignment.add_flag("fixed_department_backfill")
        if len(group) < target:
            assignment.add_flag("fixed_department_understaffed")
        assignment.workload_hours = workload_hours_for(zone, group, settings)

        for w in group:
            w.hours_assigned_tonight += assignment.workload_hours
            w.zones_assigned_tonight.append(zone.id)
            pool.remove(w)


# ---------------------------------------------------------------------------
# Top-level orchestration (design doc §8, Steps 1-3 combined)
# ---------------------------------------------------------------------------
def assign_night(workers: list[Worker], zones: list[Zone], settings: Settings,
                  rotation_key: Optional[int] = None) -> NightResult:
    active = [w for w in workers if w.active]
    for w in active:
        w.hours_assigned_tonight = 0.0
        w.zones_assigned_tonight = []

    workers_by_id = {w.id: w for w in active}
    assignments: dict[str, Assignment] = {z.id: Assignment(zone_id=z.id) for z in zones}

    pool = list(active)
    assign_fixed_departments(zones, assignments, pool, settings, rotation_key)  # Step 0.5 — Dairy/Frozen, pulled out before general fill

    fill_zones(zones, pool, settings, assignments)   # Step 1 + Step 2 (+2.4 realistic re-estimate)

    anchor_struggling_zones(zones, assignments, workers_by_id, settings)  # Step 2.65 — split up clustered underperformers

    rebalance_overstaffed_zones(zones, assignments, workers_by_id, settings)  # Step 2.7 — lend a spare hand out of an overstaffed zone

    stack_leftover_zones(zones, assignments, workers_by_id, settings)  # Step 3.1-3.2

    still_idle = [w for w in active if not w.zones_assigned_tonight]
    reinforce_with_idle_workers(zones, assignments, still_idle, workers_by_id, settings)  # Step 3.3

    rebalance_light_zones(zones, assignments, workers_by_id, settings)  # Step 2.6 — every night, not just short-staffed

    shortfall_hours, affected, over_by_worker = compute_shortfall(assignments, workers_by_id, settings)  # Step 3.4
    zone_by_id = {z.id: z for z in zones}

    notes = []
    for zid, a in assignments.items():
        zone = zone_by_id[zid]
        if zone.department not in ("dairy", "frozen"):
            continue
        if not a.worker_ids:
            notes.append(
                f"{zone.label()} has nobody assigned tonight — the active roster had nobody "
                f"available at all to cover it, even after trying to backfill."
            )
        elif "fixed_department_understaffed" in a.flags:
            names = ", ".join(workers_by_id[wid].name for wid in a.worker_ids)
            notes.append(
                f"{zone.label()} is short its usual headcount tonight — only {len(a.worker_ids)} "
                f"of {target_group_size(zone, settings)} assigned even after backfilling from the "
                f"general pool: {names}."
            )
        elif "fixed_department_backfill" in a.flags:
            names = ", ".join(workers_by_id[wid].name for wid in a.worker_ids)
            notes.append(
                f"{zone.label()} needed help from the general pool tonight to hit its usual "
                f"headcount: {names}."
            )

    if shortfall_hours > 0.001:
        worker_lines = [
            f"{workers_by_id[wid].name} ({workers_by_id[wid].hours_assigned_tonight:.2f}h, +{over:.2f}h over)"
            for wid, over in sorted(over_by_worker.items(), key=lambda kv: -kv[1])
        ]
        notes.append(
            f"Short-staffed tonight: {len(over_by_worker)} worker(s) over the "
            f"{settings.max_zone_hours_per_worker}h cap once their whole night is totaled up: "
            f"{', '.join(worker_lines)} — {shortfall_hours:.2f}h uncovered in total. "
            f"No call-in option assumed — supervisor call on how to run over."
        )

    unassigned = [w for w in active if not w.zones_assigned_tonight]
    if unassigned:
        names = ", ".join(w.name for w in unassigned)
        notes.append(
            f"{len(unassigned)} worker(s) had no zone assignment tonight, because every zone "
            f"already had its target headcount without them: {names}. "
            f"Call suggest_redistribution() to see where they could help."
        )

    return NightResult(assignments=assignments, shortfall_hours=shortfall_hours, notes=notes)


# ---------------------------------------------------------------------------
# Design doc §8 Step 2.5 — unassigned worker redistribution, proposed not
# auto-applied. The supervisor is asked; the algorithm never just does it.
# ---------------------------------------------------------------------------
@dataclass
class RedistributionSuggestion:
    worker_id: str
    worker_name: str
    zone_id: str
    zone_label: str  # display label, e.g. "Aisle 10 & 11" — for direct printing
    projected_workload_hours: float  # what that zone's workload_hours becomes if accepted


def suggest_redistribution(unassigned: list[Worker], zones: list[Zone],
                            assignments: dict[str, Assignment], workers_by_id: dict[str, Worker],
                            settings: Settings) -> list[RedistributionSuggestion]:
    """Proposes, for each unassigned worker, the zone that most needs them —
    zones already flagged as likely to struggle (STRUGGLE_FLAG) get priority
    regardless of their raw hours, then the heaviest current workload_hours
    among the rest — excluding fixed_duration zones (extra headcount doesn't
    speed up juice), capped at max_group_size, and never violating the
    incompatibility filter. Returns suggestions only; call
    apply_redistribution() to actually act on them."""
    zone_by_id = {z.id: z for z in zones}
    # working copy of group membership so repeated suggestions account for
    # each other (adding worker #1 to a zone changes that zone's ranking
    # for worker #2)
    working_groups = {
        zid: [workers_by_id[wid] for wid in a.worker_ids]
        for zid, a in assignments.items()
    }

    suggestions = []
    for worker in unassigned:
        eligible = [
            (zid, group) for zid, group in working_groups.items()
            if zone_by_id[zid].estimation_method != "fixed_duration"
            and len(group) < settings.max_group_size
            and not any(_is_incompatible(worker, w) for w in group)
        ]
        if not eligible:
            continue
        # struggling zones first (regardless of hours), then avoid creating/
        # worsening a needs_improvement+new mismatch, heaviest workload_hours
        # as the final tiebreaker
        eligible.sort(key=lambda pair: (
            0 if _needs_extra_help(pair[0], assignments) else 1,
            _rating_mismatch_penalty(worker, pair[1]),
            -workload_hours_for(zone_by_id[pair[0]], pair[1], settings),
        ))
        zid, group = eligible[0]
        group.append(worker)  # reflect in the working copy for the next worker's ranking
        projected = workload_hours_for(zone_by_id[zid], group, settings)
        suggestions.append(RedistributionSuggestion(worker.id, worker.name, zid, zone_by_id[zid].label(), projected))

    return suggestions


def apply_redistribution(suggestions: list[RedistributionSuggestion],
                          zones: list[Zone], assignments: dict[str, Assignment],
                          workers_by_id: dict[str, Worker], settings: Settings):
    """Actually applies accepted suggestions — only call this after the
    supervisor says yes."""
    zone_by_id = {z.id: z for z in zones}
    for s in suggestions:
        worker = workers_by_id[s.worker_id]
        assignment = assignments[s.zone_id]
        assignment.worker_ids.append(worker.id)
        assignment.add_flag("redistributed")
        group = [workers_by_id[wid] for wid in assignment.worker_ids]
        new_workload = workload_hours_for(zone_by_id[s.zone_id], group, settings)
        # the other group members' hours_assigned_tonight need adjusting too,
        # since the zone got faster for everyone in it
        delta = new_workload - assignment.workload_hours
        assignment.workload_hours = new_workload
        for w in group:
            if w.id == worker.id:
                w.hours_assigned_tonight += new_workload
            else:
                w.hours_assigned_tonight += delta
        worker.zones_assigned_tonight.append(s.zone_id)
