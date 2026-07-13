# Aisle Freight Scheduler — Design Doc

## 1. Problem

Every night, a supervisor manually cross-references two paper/printed lists — who's working, and how much freight landed in each aisle — to build a work schedule by hand. This app automates that: capture two photos, extract the data, and generate a fair, preference-aware schedule automatically.

## 2. Goals

- Extract worker names and aisle case counts from two photos (printed lists).
- Apply fixed aisle-pairing rules to group freight into work zones.
- Calculate labor hours per zone from a case-per-minute stocking rate.
- Assign workers to zones in appropriately sized groups (2–4, sized to hit the grocery time target), favoring stored preferences (preferred aisle, preferred partner) without leaving any zone uncovered.
- Handle both fully-staffed nights (groups sized per zone) and short-staffed nights (groups double up across multiple zones, worked sequentially, with reinforcement when possible).
- Let the supervisor review and correct the parsed data and the generated schedule before it's final.
- Provide a checklist for recurring nightly compliance/inspection events (e.g. SPARK, PLE, TLE) so they don't get missed across a 13-hour overnight shift where the nights blend together.
- Let the supervisor check off each zone as it's completed, capturing actual completion time against the estimate — building real data to eventually replace the placeholder rate and efficiency numbers with calibrated ones.

## 3. Non-Goals (for v1)

- Handwriting recognition (lists are printed/typed — on-device OCR is sufficient).
- Payroll integration or time-clock syncing.
- Multi-store support (single location's aisle layout, hardcoded but editable).

## 4. Inputs

| Photo | Contents |
|---|---|
| Worker list | Names of staff scheduled for the night |
| Freight breakdown | Case counts per aisle number |

## 5. Aisle Zone Mapping

Freight is combined into fixed work zones. This table drives both the hours calculation and the assignment logic:

| Zone | Aisles |
|---|---|
| A | 2 & 3 |
| B | 4 & 5 |
| C | 6 & 7 |
| D | 8 & 9 |
| E | 10 & 11 |
| F | 12 & 13 |
| G | 14 & 15 |
| H | 19 (solo) |
| I | Juice zone — 20, 21 & 22 |
| J | Dairy (fixed daily headcount: 3) |
| K | Frozen (fixed daily headcount: 2) |

**Note:** stored as an editable config table, not hardcoded logic — store layouts and remodels will change this over time.

**Dairy and Frozen are staffed differently from every other zone.** They're not case-driven and they're not filled from the general preference-matched pool at all — only specific trained people ever cover them, and they're pulled out of the pool before the general assignment logic even runs (§8 Step 0.5). Some are there every single night (`Worker.fixed_department`); others take turns on a deterministic day-based rotation when more people are trained for a department than the nightly headcount needs (`Worker.department_rotation_pool`).

**Aisle 1 exclusion:** aisle 1 is produce, which this store doesn't handle as part of the nightly freight process — but it still shows up as a line on the freight breakdown sheet. The parser must recognize and discard aisle 1's data entirely during zone aggregation (§7), not fold it into any zone or flag it as unmapped/orphaned. It's expected to be there and expected to be ignored.

**Juice zone exception:** case counts here are heavily skewed by water pallets, which are dropped in whole and don't reflect real case-handling time. This zone does **not** use the case-rate formula — it uses a fixed duration estimate instead. **The ~3 hr starting value is a rough placeholder, not a measured number** — it should be replaced with the actual average `actual_hours` observed via the Complete checks (§6, §12) as soon as there's enough nightly data to trust, rather than left as a guess.

## 6. Data Model

**Worker**
- `id`, `name`, `active` (worked tonight, y/n)
- `preferred_zones`: ranked list of zone IDs
- `preferred_partners`: list of worker IDs this person is happy to be grouped with — not ranked, not exclusive. Real rosters don't reduce to "one favorite partner": someone might be equally fine working with either of two people, or the interest might only run one direction (A lists B without B listing A back). Both are handled: a **mutual** match (both list each other) scores higher than a **one-directional** one, but either beats no relationship at all.
- `incompatible_with`: list of worker IDs this person should **never** be grouped with — "oil and water" personality conflicts, not a preference. Checked bidirectionally (if either worker's record lists the other, they're treated as incompatible) so it doesn't matter which side it's recorded on. Unlike partner/zone preference, this is a **hard exclusion**, not a soft heuristic — the assignment algorithm will not place two incompatible workers in the same group even if it means a zone stays under target headcount. See §8 for what happens if that leaves a zone genuinely unfillable.
- `incompatibility_notes`: an optional free-text reason/severity note per `incompatible_with` entry (e.g. "absolutely hate each other, never mix" vs. "won't work with him at all") — purely informational, shown on the Worker Roster and Schedule Output for context. Every `incompatible_with` entry is enforced with exactly the same hard weight regardless of what's noted here; this changes nothing about the assignment logic.
- `unsuitable_for_new_hires`: a per-worker flag for a known difficult personality that `new` hires specifically should be shielded from until they've got their feet under them — folded into the exact same hard exclusion as `incompatible_with` (checked bidirectionally, enforced everywhere a candidate gets picked), not a softer preference. An available `on_pace` donor is never a good enough reason to override it.
- `locked_with`: a hard "must always be together" requirement, stronger than `preferred_partners` — that's a scoring bonus that can still lose to other pressure, this can't lose at all. For pairs whose combined performance together is worth more than anything a rebalance might gain by splitting them. Checked bidirectionally like `incompatible_with`; enforced by seeding them together before even mutual-partner pairs (winning any capacity race, including one where the two members stated *different* individual zone preferences) and by excluding either half from ever being pulled out alone during the split-up-the-cluster pass (§8 Step 2.65) — if the only possible donor for a struggling zone is half of a locked pair, the struggling zone just stays struggling; the lock wins.
- `fixed_department` / `department_rotation_pool`: cover Dairy and Frozen (§5), which aren't filled from the general pool at all. `fixed_department` means this worker covers that department every single night, no rotation. `department_rotation_pool` means they're one of a named group taking turns when the pool is bigger than the nightly headcount — see §8 Step 0.5 for how the rotation itself works.
- `production_rating`: `on_pace`, `needs_improvement`, or `new` — set/updated by the supervisor in the Worker Roster screen, with one automatic exception below. **`new` is the default for any worker with no rating history**, which matters right now given the wave of ~10 new hires expected over the next two weeks. `new` is treated as meaningfully slower than `needs_improvement`, not just a milder version of it — learning shelf locations for thousands of items is a genuine grind, and pace typically doesn't pick up for a few weeks.
- **Auto-promotion rule (`new` → `needs_improvement`):** once a worker's `actual_vs_estimate_ratio` reaches or exceeds `needs_improvement_efficiency_factor` (0.75) on `new_hire_auto_promote_threshold_hits` (5, editable) separate assignments, the app automatically updates their `production_rating` from `new` to `needs_improvement` — they've demonstrably caught up to that pace, so there's no reason to keep flagging them as an unknown quantity. This is the one rating change that happens without supervisor action; the supervisor can still manually override it (including reverting it) at any time. Promotion from `needs_improvement` to `on_pace` remains a fully manual call (see Open Questions).
- `hire_date`: drives a recurring "time to reassess [Worker]'s pace?" reminder on the Worker Roster, once per week for as long as they're rated `new` (interval set by `new_hire_review_interval_weeks`, see Settings). This reminder stops firing once the worker is promoted out of `new` — whether that happens automatically (see the auto-promotion rule above) or by manual supervisor action.
- `seniority`/`notes`: optional tiebreaker field

**Zone**
- `id`, `aisle_range`, `case_count` (filled nightly from OCR; always 0 for Dairy/Frozen — they're not case-driven)
- `department`: `grocery` (zones A–H), `juice` (zone I), `dairy` (zone J), or `frozen` (zone K) — grocery zones are the ones held to the 4-hour target
- `estimation_method`: `case_rate` (grocery A–H and juice I) or `fixed_duration` (dairy, frozen only)
- `fixed_headcount`: only meaningful for `fixed_duration` zones. Dairy and Frozen set this explicitly (3 and 2) since their headcount is a fixed daily staffing decision, not something case volume drives.
- `total_hours`: raw labor-hours the zone's freight requires at the standard rate, independent of headcount — `case_count / case_per_minute_rate / 60`. This is a fixed measure of "how much work," not "how long it'll take."
- `workload_hours`: the realistic per-person clock-time duration — `total_hours / effective_capacity`. Two passes: **ballpark** (Step 1, before individuals are known) uses raw `workers_assigned` as capacity; **realistic** (after Step 2/3 assigns actual people) swaps in `effective_capacity` — the sum of each assigned worker's efficiency (1.0 for `on_pace`, `needs_improvement_efficiency_factor` for `needs_improvement`, `new_hire_efficiency_factor` for `new` — the two are deliberately separate and `new` is meaningfully lower, see §6 Settings) — so a group with new hires shows a longer, more honest number. This is what's compared against `grocery_target_hours` and `max_zone_hours_per_worker`.
- Juice is real `case_rate` now, not a `~3hr` flat placeholder — once the water-pallet correction (below) made `case_count` trustworthy, there was no reason left to wait on duration-based calibration data. Juice's `workload_hours` = `total_hours / effective_capacity` (same formula as grocery) **plus a flat `juice_hidden_task_hours` (~1 hr)** for the water-gallon restocking (Infants + juice aisle itself) that never shows up in any case count — that hour is added after the capacity division, not shared across headcount, since it's roughly the same physical task regardless of crew size. Juice's growth target is `juice_max_total_hours` (5 hrs, hidden hour included), not `grocery_target_hours` — the algorithm adds people to juice until it fits under that number, same mechanism as grocery growing toward its own target.
- `water_pallet_cases` (juice zone only): **computed, not guessed** — `Σ (pallet_count_by_type × cases_per_pallet)`, using the `PalletType` reference table below. The only nightly manual input is the **pallet count per type** (one tap per pallet as it comes off the truck), which is an exact, countable number, not an estimate of cases. `adjusted_case_count = case_count − water_pallet_cases`, applied directly to the Juice case-count field. Since juice's `workload_hours` is now case-driven, this correction matters for real: an inflated case count (water folded in by mistake) would otherwise overstate Juice's real workload and oversize its crew.

**PalletType** (reference data, researched once, not guessed nightly)
- `id`, `name`, `cases_per_pallet` (exact figure, from your research), `zone_id` (which zone it applies to — juice for now, but the table isn't hardcoded to water specifically, in case other pallet-dropped items in other zones turn out to have the same problem later)
- Seeded with your 5 known water types — `cases_per_pallet` TBD pending your research: Dasani, Great Value 20pk, Great Value 40pk, Ice Mountain, Pure Life.
- Nightly entry UI is a simple itemized list — one row per type with a pallet-quantity field next to it — rather than a single generic "water pallets" number, since each type has its own case count.
- `workers_assigned`: headcount on the zone — not fixed at 2. Heavy zones routinely get 3 or 4 people from the start; this is a normal sizing decision, not just an overflow reaction (see §8)

**NightlySchedule**
- `date`, list of `Assignment` records, list of nightly `EventCheck` records (see `NightlyEvent` below)
- `Assignment`: `zone_id(s)`, `worker_ids` (group, size varies), `workload_hours` (per-zone estimate), `was_preference_override` (bool, for flagging)
- `Assignment.started_at`, `Assignment.completed_at`: timestamps, set when the group starts a zone and when the supervisor checks it off complete
- `Assignment.actual_hours`: `completed_at − started_at`, once both are set
- `Assignment.actual_vs_estimate_ratio`: `actual_hours / workload_hours` — the real-world data point that lets `case_per_minute_rate`, `needs_improvement_efficiency_factor`, and `new_hire_efficiency_factor` eventually move from placeholder guesses to calibrated numbers (see §11). This is inherently a **team-level** number, not a clean individual one — it's shaped by whoever the worker happened to be paired/grouped with that night. Any per-worker read on this (e.g. shown on the Worker Roster) should be an average across many nights and varied partner combinations, not any single night's ratio, so the partner effect washes out over time instead of unfairly tagging one person.

**NightlyEvent**
- `id`, `name` (e.g. SPARK, PLE, TLE), `active` — a configurable list of recurring nightly compliance/inspection tasks, editable in Settings, not hardcoded (names and requirements will likely change over time)
- Per-night `EventCheck`: `event_id`, `completed` (bool), `completed_at`, `completed_by` (optional, supervisor or assigned worker)

**Settings**
- `case_per_minute_rate` (editable, since stocking rate may shift)
- `max_zone_hours_per_worker` = 5.5 hrs (editable, hard cap) — the ceiling on assigned freight-work time per person, after lunch, breaks, and the required 1-hour zone time are already accounted for elsewhere in the shift
- `grocery_target_hours` = 4 hrs (editable, soft target) — grocery zones should finish within this window so the crew is out of grocery by lunch; tighter than the hard cap, and drives group sizing (below), not just an overflow trigger
- `max_group_size` = 4 workers (editable, hard ceiling) — beyond 4 people on a single zone, returns diminish (aisle space, coordination overhead), so the app won't size or reinforce a group past this even if the zone would otherwise still miss its target
- `needs_improvement_efficiency_factor` = 0.75 (editable) — good starting value; applied per `needs_improvement` worker in the realistic-pass `workload_hours`. Not a one-time guess to live with forever — the app tracks `actual_vs_estimate_ratio` over time (see `Zone` above, and §12) and this gets updated as real-world data comes in.
- `new_hire_efficiency_factor` = 0.5 (editable) — good starting value; applied per `new` worker, set meaningfully lower than the `needs_improvement` factor since new hires are typically significantly slower than even existing underperformers while they're still learning shelf locations. Same as above — tracked and updated from real data over time, not left as a guess.
- `new_hire_review_interval_weeks` = 1 (editable) — how often the Worker Roster reminds the supervisor to reassess each `new` worker's pace; keeps firing weekly until the rating is manually changed, purely informational and never auto-changes anyone's rating
- `nightly_events`: editable list of recurring inspection/compliance tasks (starts with SPARK, PLE, TLE) — add, rename, or retire items here as requirements change
- `new_hire_auto_promote_threshold_hits` = 5 (editable) — number of assignments where a `new` worker's `actual_vs_estimate_ratio` must hit `needs_improvement_efficiency_factor` (0.75) before they're auto-promoted to `needs_improvement`
- `light_load_threshold` = 0.5 (editable) — a zone's `workload_hours` at or below (`grocery_target_hours` × this) counts as light enough to lend its pair out to a heavier zone (see §8 Step 2.6)
- `dairy_fixed_duration_hours` = 4 hrs, `frozen_fixed_duration_hours` = 4 hrs (both editable placeholders pending real completion-time data — juice no longer needs one of these, see below)
- `juice_hidden_task_hours` = 1 hr (editable) — flat addition to juice's real case-driven `workload_hours`, for the water-gallon restocking (Infants + juice aisle) that never shows up in a case count. Not divided across headcount.
- `juice_max_total_hours` = 5 hrs (editable, hard ceiling, hidden hour included) — juice's equivalent of `grocery_target_hours`: the algorithm grows juice's headcount toward this number instead of the generic `max_zone_hours_per_worker`.

## 7. Pipeline

1. **Capture** — user takes/selects two photos in-app.
2. **OCR** — Android ML Kit Text Recognition extracts raw text from each image.
3. **Parse** — regex/heuristic parser maps raw text into worker names and aisle→case-count pairs. Flags anything it can't confidently parse, including known bad patterns like a name field rendered as "." or left blank (common with new hires who aren't yet properly entered on the source list).
4. **Review screen** — supervisor eyeballs the extracted data side-by-side with the photo, corrects any OCR misses (typos, merged numbers, skipped lines, "." placeholders) via editable fields. Every name field is either a free-text edit or a dropdown/type-ahead against the existing Worker Roster, to cut down on duplicate or misspelled entries. There's also an explicit **"+ Add worker"** action for anyone scheduled who doesn't appear on the photo at all — for whatever reason (missed on the list, added last-minute, etc.). Picking an existing roster name links straight to that worker's record; typing a new name creates a fresh Worker record with `production_rating` defaulted to `new`. The juice zone row also gets a `water_pallet_cases` field here — auto-filled if the freight report has a separate water line the parser can pick up, otherwise a manual entry. This step is mandatory before scheduling runs — OCR will not be 100% and the app shouldn't pretend otherwise.
5. **Zone aggregation** — case counts are summed per the zone mapping in §5. Aisle 1 (produce) is dropped here, not summed into anything and not flagged as an error — it's known, expected, and irrelevant to this process.
6. **Hours calculation** — `total_hours = case_count / case_per_minute_rate / 60`, then `workload_hours = total_hours / effective_capacity` for case-rate zones; juice zone uses its flat estimate for `workload_hours` instead (see §5).
7. **Assignment** — see §8.
8. **Output** — editable schedule screen; supervisor can manually drag-reassign before finalizing.

## 8. Assignment Algorithm

Coverage is a hard constraint — every zone must be assigned. Preferences are optimized on a best-effort basis on top of that.

**Step 0.5 — Fixed departments (Dairy, Frozen).** Before any of the general assignment logic below runs, Dairy and Frozen are staffed directly from the pool: `fixed_department` workers are pulled out first (covering their department every night, no rotation), then any remaining headcount is filled from that department's `department_rotation_pool` via a deterministic day-based rotation (today's day-of-year decides who's picked, so it needs no persisted state between nights and naturally takes turns over real calendar days — an explicit day can be passed in to preview a specific rotation). Whoever's left in the rotation pool that night returns to the general grocery pool. Dairy's headcount (3) and Frozen's (2) are a hard guarantee, not best-effort: if dedicated + rotation people don't add up to target, the remaining slots are backfilled straight from the general grocery pool, preferring `on_pace` workers over anyone still learning the ropes, and never poaching a worker who's dedicated/rotation-assigned to the *other* fixed department even if it happens to be processed first. Every backfilled slot is flagged (`fixed_department_backfill`) with a note naming who filled in; on the rare night the whole active roster still isn't enough to reach target, that's flagged too (`fixed_department_understaffed`) rather than pretending the gap didn't happen. These two zones are then walled off from every later step (fill, anchor-swap, stacking, rebalancing, redistribution) in both directions — they can't receive workers from those passes, and their own dedicated crew can't get pulled out to help elsewhere either, so a full night in Dairy or Frozen stays exactly that.

**Step 1 — Zone group sizing.** Group size is not fixed at 2. For each zone, compute `workload_hours` starting at `workers_assigned = 2`. If that exceeds `grocery_target_hours` (4 hrs, grocery zones only), add a 3rd or 4th worker and recompute — `workload_hours` scales down roughly linearly with headcount — until the zone fits the 4-hour target **or hits `max_group_size` (4)**, whichever comes first. Non-grocery zones (juice) size against the 5.5-hour hard cap instead, since there's no 4-hour target for them. This produces a target headcount per zone *before* specific workers are matched to it. If a zone still can't hit its target at 4 workers, that's flagged on the output rather than pushing a 5th person into it.

**Step 2 — Fully-staffed nights** (enough active workers to fill every zone's target headcount):
0. **Incompatibility filter (hard):** at every selection point below, a candidate is simply removed from consideration if they're `incompatible_with` anyone already placed in that group — this isn't scored or weighed against preference, it's a flat exclusion, checked before anything else. If excluding incompatible candidates leaves a zone short of its target (or even below 2), that's reported the same way other understaffing is (`incompatibility_conflict` flag) rather than forcing the pairing. The algorithm does not pick "coverage" over "never force an incompatible pairing" — see Open Questions for the edge case where that leaves a zone truly unfillable.
1. Before anything else, seed hard-`locked_with` pairs first (a requirement, not a preference — wins even over a stated individual zone preference on either side), then known mutual partner pairs together into zones (heaviest zones first) — this has to happen *before* individual slot-filling, otherwise a zone with an empty group has nothing to score a partner match against and can end up splitting a pair by sheer list-order luck. Then fill remaining slots by preferred-zone ranking, with one-directional partner interest (only one side listed the other) still giving a weaker preference bonus during that fill.
2. Any worker without a satisfiable preference gets assigned to a remaining open slot; mark `was_preference_override = true`.
3. **Production-rating balance:** where preferences don't force the outcome, avoid stacking two or more `needs_improvement`/`new` workers into the same grocery zone — spread them across groups and mix in `on_pace` workers where the roster allows it. A `needs_improvement` + `new` pairing specifically gets a much steeper penalty than any other combination: a real night's data showed that exact mix running roughly 3x the modeled estimate (2.5 hours of modeled work took until 5:25am), far worse than the additive efficiency math predicts — two slow workers together seems to compound, not just add. This is still a soft heuristic, not a hard rule, so it never overrides preference-matching or coverage — with 10 new hires inbound, it won't always be possible to avoid doubling up, and that's fine, it just gets flagged (Step 5 below).
3.5. **Split-up-the-cluster pass (Step 2.65):** the balance heuristic in Step 3 above can only pick the least-bad candidate from whoever's still in the pool *at that moment* — it can't retroactively un-claim `on_pace` workers who already landed in other zones during earlier fill. Left alone, this can dump every leftover new hire into whichever zone gets filled last, with nobody experienced anywhere near them. Right after the initial fill (before any short-staffed stacking), the app repeatedly looks for a zone with 2+ non-`on_pace` workers and a fully-`on_pace` donor zone (2+ members, so donating doesn't create a new cluster there) and swaps one worker each way — one non-`on_pace` worker out to a zone that can actually pair with them, one `on_pace` worker in to anchor the zone left behind. It keeps going until every zone has at most one non-`on_pace` worker or no more valid donor exists; each fully-`on_pace` zone can only donate once, so this can never create a new cluster, only resolve one. It prefers moving whoever has no stated partner bond, so it won't break up an explicit pairing if there's any other option. Flagged on both ends of every swap, never silent.
4. **Realistic re-estimate:** once actual workers are assigned, recompute `workload_hours` using the group's real `effective_capacity` (see §6) instead of the Step 1 ballpark. If the realistic number now blows past the zone's target/cap, try adding one more worker (up to `max_group_size`) before falling through to the shortfall check.
5. **Unassigned worker prompt:** if any active workers are left over once every zone has hit its target headcount (more crew than the zones currently need), the app does **not** silently leave them idle. It surfaces them explicitly — "N workers unassigned tonight" — and offers to distribute them into the zone that needs it most: zones already flagged as likely to struggle (2+ `needs_improvement`/`new` stacked together) get priority regardless of their raw hours, then the heaviest remaining zone by current `workload_hours` after that (excluding the juice zone since extra headcount doesn't help a fixed-duration zone), one at a time, re-ranking after each addition, capped at `max_group_size` (4) and still subject to the incompatibility filter above. This is a proposal the supervisor approves or declines, never an automatic change.
6. **Proactive balance pass (Step 2.6), every night — not just short-staffed ones:** an uneven case split can leave one pair finishing with a very light load while another zone stays well over the 4-hour target, even on a fully-staffed night, with nobody left in the idle pool to reinforce it (everyone already has a primary zone). Rather than let a light pair sit idle for the rest of the shift, the app stacks them onto the zone that needs help most as a second, sequential assignment — same mechanic as Step 3's short-staffed stacking, applied for balance instead of bare coverage. "Needs help most" uses the same struggle-first priority as Step 5 above: a zone already flagged as likely to struggle is eligible for this help even if its raw hours are under the 4-hour target, and always ranks ahead of a merely-heavier zone. A zone already struggling is never treated as a light donor itself — it can receive help, never give it away. A pair only gets lent out if their current zone's `workload_hours` is at or below `light_load_threshold` (0.5) × `grocery_target_hours`, and only if doing so doesn't exceed `max_group_size` or push anyone past the 5.5-hour cap. Both the lending zone and the receiving zone are flagged on the output (`lent_to_heavier_zone` / `balanced_second_zone`) so it's never a silent change.
7. **Overstaffed-zone rebalance (Step 2.7):** Step 2.4's group-growth pass (item 4 above) makes its call zone-by-zone, without knowing how heavy every other zone will end up once the rest of fill finishes — a zone can land at 4 people running half the 4-hour target while a sibling zone is still well over target with nobody left to send it. Step 2.6 only ever lends a *whole* light group; it never notices a zone that's overstaffed rather than genuinely light. This pass runs right after the split-up-the-cluster pass (item 3.5), while every worker still has exactly one zone, and pulls exactly one spare hand out of an overstaffed zone (3+ people, so a pair is always left behind) over to the heaviest zone, as long as the move actually narrows the gap on both ends (not just relocates the same imbalance), doesn't cross the 5.5-hour cap on either end, doesn't create an incompatible pairing, and doesn't break up a stated partner bond or strand a locked partner. Never strips a hand from a zone already flagged struggling — taking a person away from a fragile group is the opposite of helping. Flagged both ends (`lent_spare_hand` / `received_spare_hand`).

**Step 3 — Short-staffed nights** (not enough active workers to fill every zone at its target headcount):

There is no "call in extra people" option — the crew works with who showed up, and some nights that isn't enough. The app's job is to make the best use of available hands and be honest when it's still short, not to pretend a fix exists.

1. Run Step 2 first for as many zones as the crew can fill at target headcount.
2. For leftover, unassigned zones, stack them onto the *lightest-loaded* existing group (lowest current assigned hours tonight) that still has room under `max_zone_hours_per_worker` (5.5 hrs), with two preferences ahead of raw cost: never pick a donor already flagged as likely to struggle (piling more sequential work onto the most vulnerable group — say, two new hires with nobody senior to anchor them — is exactly backwards), and prefer a donor that hasn't already been tapped for a *different* leftover zone tonight, so donor duty spreads across different people instead of the same cheap pair getting stacked onto every empty zone in a row. Both are soft preferences — a genuine shortage night still falls through to *some* coverage rather than an empty zone. Doubled zones are worked **sequentially**: a worker's `hours_assigned_tonight = zone_1_workload_hours + zone_2_workload_hours` (this per-worker running total is distinct from any single zone's `total_hours`, see §6).
3. **Reinforcement pass:** if a group's cumulative assigned hours would still exceed the 5.5-hour cap, first try pulling in additional available workers into that zone (raising `workers_assigned`, capped at `max_group_size` = 4) rather than just stacking more time onto the same people — more hands on a `case_rate` zone reduces its `workload_hours` proportionally. Pull reinforcements from whoever has the most remaining slack under their own cap. If a zone is already at 4 workers and still over cap, it goes straight to the shortfall check below.
4. **Shortfall check:** if total required zone-hours still exceed total available crew capacity (`sum of each active worker's remaining hours under the 5.5 cap`) even after reinforcement, the night is structurally short-staffed — full stop. The app surfaces this plainly (e.g. "3.5 hrs of freight uncovered tonight") rather than forcing an assignment that quietly breaks the cap. The supervisor decides how to run over from there.
5. Every override, double-up, reinforcement, shortfall, or zone with 2+ `needs_improvement`/`new` workers stacked together ("this zone will likely struggle") is flagged on the output screen.

## 9. Screens

1. **Capture** — camera/gallery picker for the two photos.
2. **Review & Correct** — parsed data next to source photo, inline editing per field, roster dropdown/type-ahead for name fields, "+ Add worker" for anyone missing from the photo entirely.
3. **Schedule Output** — one row per zone, showing: **cases** (`case_count`), **total hours** (raw labor-hours the freight requires, headcount-independent), **workload hours** (total hours ÷ people assigned — the realistic per-person duration), and **people assigned** (names, each shown with their current efficiency rating number — `1.0` on pace, `0.75` needs improvement, `0.5` new — right next to the name, so a glance at the roster on any zone shows who's likely to be the pace-setter, with roles like solo/pair/reinforced shown too). Each zone has a one-tap **Complete** check that stamps `completed_at` and immediately shows actual time vs. estimate. Plus flags for overrides, doubled/reinforced zones, shortfalls, incompatibility conflicts, or zones likely to struggle from stacked `needs_improvement`/`new` workers. Very light zones proactively lend their pair to a significantly heavier or struggling zone as a second assignment (§8 Step 2.6), flagged on both ends. If workers are left unassigned, a prompt offers to distribute them into the zone that needs it most — struggling zones get priority, heaviest workload after that (§8 Step 2.5) — accept, decline, or manually place them yourself. Manual drag-to-reassign updates all figures live and still respects the incompatibility filter (the UI simply won't let two incompatible workers land in the same zone). The efficiency numbers themselves are the same ones from Settings (§6) — starting placeholders that get replaced with real calibrated values as `actual_vs_estimate_ratio` data accumulates, not fixed forever.
4. **Nightly Checklist** — a standing, always-visible list of the configured `nightly_events` (SPARK, PLE, TLE, etc.) with a simple checkbox and timestamp per item, separate from the zone list so it doesn't get buried in the freight schedule — the whole point is making sure it isn't overlooked mid-shift.
5. **Worker Roster** — manage worker list, preferred zones, preferred partners, incompatible-with list, hire date, and production rating (on pace / needs improvement / new), with `new` as the default for anyone just added. Surfaces a weekly "reassess pace?" reminder next to anyone still rated `new`, recurring until the supervisor updates the rating. Once enough nights of `actual_vs_estimate_ratio` data exist for a worker, their **average** ratio across nights/partners can display alongside the manual rating as a reference point — never an automatic override, and not meaningful off a single night's number given how much a partner can skew it.
6. **Settings** — case/minute rate, zone mapping editor, nightly events list, all the caps/targets/factors from §6.

## 10. Tech Stack

- **Platform**: Native Android (Kotlin)
- **OCR**: ML Kit Text Recognition (on-device, free, offline)
- **Storage**: Room (SQLite) for workers, zone config, schedule history
- **Architecture**: MVVM, single-activity + Compose UI

## 11. Open Questions

- Should preference rankings decay/reset if a worker is repeatedly overridden (to avoid the same person always losing out)?
- Are there other zones besides juice with the same case-count-doesn't-reflect-real-time problem (e.g. other pallet-dropped goods), or is juice the only exception?
- `new` → `needs_improvement` now auto-promotes after 5 assignments at ≥0.75 (resolved). Should `needs_improvement` → `on_pace` get a similar automatic rule (e.g. 5 hits at ≥1.0), or does that step always need a human judgment call since "on pace" carries more weight than just a number?
- Is 5 assignments the right bar, or could a couple of easy, well-partnered nights false-promote someone who isn't really there yet?
- Incompatibility is currently a hard "never pair them" rule that can leave a zone understaffed rather than force it. Is that the right call, or should there be a last-resort override for nights where the only alternative is a zone with zero coverage — and if so, does the app force it automatically or just escalate loudly to the supervisor to decide?
- Do the nightly events (SPARK, PLE, TLE) need their own due-time or reminder alerts, or is an always-visible checklist enough given they just need to happen sometime during the shift?
- Once several weeks of `actual_vs_estimate_ratio` data piles up, should the app auto-suggest updated rate/efficiency-factor values in Settings, or should recalibration always stay a manual review?
- Does the freight breakdown photo ever list water as its own line item, or is `water_pallet_cases` always going to be a manual guess/estimate each night? Worth checking against a real photo — this decides whether it's parseable or purely manual entry.

## 12. Next Steps

1. Get 1–2 real sample photos to validate OCR + parsing accuracy against actual formatting.
2. Prototype parsing + zone aggregation + hours calc in isolation (Python or Kotlin unit test) before building UI.
3. Build Worker Roster + Settings screens (no dependencies on OCR).
4. Build Capture → OCR → Review pipeline.
5. Build Assignment algorithm + Schedule Output screen.
6. End-to-end test with real photos across both a fully-staffed and short-staffed scenario.
7. Run the app for a few weeks to accumulate real `actual_vs_estimate_ratio` data, then replace every remaining placeholder figure with a measured one: `case_per_minute_rate`, `needs_improvement_efficiency_factor`, `new_hire_efficiency_factor`, `juice_hidden_task_hours` — none of these should stay guesses longer than necessary. (Juice's own `~3hr fixed_duration` placeholder is retired — done, see `Zone.workload_hours` above.)
8. Research and populate the `PalletType` reference table (cases-per-pallet for each water pallet type) so `water_pallet_cases` is computed, not estimated. (UI built — done. Real cases-per-pallet numbers are entered directly in the app now, not tracked here.)
