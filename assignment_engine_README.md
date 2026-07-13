# Assignment Algorithm — Prototype

Python implementation of design doc §8 (zone group sizing, fully-staffed
assignment, short-staffed stacking/reinforcement/shortfall). No OCR or photo
dependency — it runs entirely on synthetic worker + case-count data, so it's
testable now, before there's anything to photograph.

## Files

- **`assignment_engine.py`** — the actual algorithm. `Worker`, `Zone`,
  `Settings` data classes matching the design doc's data model, plus
  `assign_night(workers, zones, settings)`, the main entry point.
- **`demo.py`** — five runnable scenarios, all using the actual 24-person
  roster (real names, real partner/incompatibility relationships — no
  placeholder names anywhere) with a printed schedule table per scenario:
  1. Fully-staffed night (20 workers) — shows preference/partner matching
     using the real mutual pairs (Avicel/Clare, Danarys/Drogo, Lydia/Lisette,
     Vayne/Skyler) and one-directional preferences (Pella→Cosette,
     Nedylene→Teu'ris, Dal'nath→Sheara, Raven→Mira).
  2. Short-staffed night (10 workers, 9 zones) — shows sequential stacking
     onto the lightest-loaded group, using real pairs so you can see
     relationships survive being stacked across multiple zones.
  3. Severe shortage (6 workers, 9 heavy zones) — shows the honest shortfall
     report firing when reinforcement genuinely can't help, with a couple of
     new hires included to show their slower pace compounding the shortage.
  4. Incompatibility + redistribution (22 workers) — shows Teu'ris and Vayne
     (the one real "oil and water" pair) correctly kept apart even when
     Vayne's preferred zone grows to fit Skyler and Nedylene too, plus
     unassigned workers getting redistribution suggestions that are only
     applied after a simulated supervisor "yes."
  5. Real roster, random case generator (24 workers) — instead of a fixed
     case count, each run randomly generates a fresh grocery volume (1,300–
     4,500 cases, split randomly across zones A–H) so you can see how the
     algorithm holds up across different night-to-night loads rather than
     just one canned example — real nights swing hard from one to the next,
     which is exactly what makes staffing them a challenge. Pass
     `scenario_real_roster(seed=42)` for a reproducible run, or call it with
     no seed (the default) for a new random night every time. Also shows
     Danarys/Drogo pulled straight to Frozen and 3 of {Teu'ris, Nedylene,
     Charlotte, Iga} rotated into Dairy before the general fill ever runs.
- **`test_assignment_engine.py`** — 55 assertion-based checks (mutual
  partners end up together, juice ignores case count, group size never
  exceeds 4, shortfall reports correctly in both directions, incompatible
  workers never share a group even short-staffed, 1st choice beats 2nd
  choice, redistribution targets the heaviest eligible zone, mutual pairs
  survive even with zero zone preferences set, a mutual pair WITH a stated
  zone preference gets that zone rather than just the heaviest one, a
  stacked worker's cap overage is counted once instead of once per zone, a
  very light pair gets lent to a much heavier zone, a struggling zone gets
  redistribution priority over a merely-heavier one, a needs_improvement +
  new mismatch is avoided whenever another candidate exists, clustered
  underperformers get split up across capable zones instead of dumped
  together, the anchor-swap pass tries every donor zone instead of giving
  up on the first blocked one, fixed-department workers always land in
  their department, a rotation pool picks exactly the right headcount and
  rotates by day, Dairy/Frozen always hit their target headcount via
  general-pool backfill when dedicated/rotation people fall short (and are
  honestly flagged understaffed on the rare night the whole crew still
  isn't enough), a hard-locked pair stays together even under conflicting
  zone preferences or as the only possible anchor-swap donor, sequential
  stacking prefers a non-struggling donor over a cheaper struggling one and
  spreads donor duty across different groups instead of reusing the same
  pair, an overstaffed zone lends exactly one spare hand to the heaviest
  zone without ever stripping a hand from an already-struggling one, etc).

## Running it

```
python3 demo.py                    # see the three scenarios play out
python3 test_assignment_engine.py  # run the checks (exits 1 if anything fails)
```

No dependencies beyond the Python standard library.

## What's implemented

- Zone group sizing (2–4 workers, sized to hit the 4hr grocery target)
- Partner preference as a list, not a single ID — a worker can be fine with
  several people (`preferred_partners`), matches can be one-directional or
  mutual (mutual scores higher), and mutual pairs get seeded together
  *before* anything else runs so they can't get split by fill-order luck
- Zone-preference matching, done preference-rank-tier by tier across *all*
  zones at once (not zone-by-zone — see note below)
- Production-rating balance (avoids stacking 2+ underperformers when
  avoidable) and the "likely to struggle" flag when it can't be avoided
- A steep, specific penalty (`_rating_mismatch_penalty`) against pairing a
  `needs_improvement` worker with a `new` hire — a real night's data showed
  that exact combo running ~3x the modeled estimate (2.5h of work took until
  5:25am), far worse than the ~1.25x the additive efficiency model predicts.
  Applied everywhere a candidate gets picked (initial fill, growth,
  reinforcement, redistribution) — still a soft preference, so it can happen
  if truly nobody else is available, but it's actively avoided otherwise.
- Split-up-the-cluster pass (`anchor_struggling_zones()`, Step 2.65): fill
  can end up dumping every leftover new hire into whichever zone gets
  processed last, once every on_pace worker's already been claimed
  elsewhere — the production-rating balance heuristic can only pick the
  least-bad option from whoever's left *at that moment*, it can't retroactively
  un-claim on_pace workers who already landed in other zones. This pass runs
  right after the initial fill and repeatedly swaps one worker each way
  between a clustered zone (2+ non-on_pace) and a fully-capable donor zone
  (100% on_pace, 2+ members) until every zone has at most one non-on_pace
  worker or no more valid donor exists. Each fully-on_pace zone can only
  donate once, so a swap can never create a new cluster, only resolve one.
  Prefers moving whoever has no stated partner bond, so it won't break up an
  explicit pairing if there's any other option. Flagged on both ends
  (`anchored_with_on_pace_worker` / `lent_on_pace_anchor`).
- Realistic re-estimate using `on_pace`/`needs_improvement`/`new` efficiency
  factors once real people are assigned
- Overstaffed-zone rebalance (`rebalance_overstaffed_zones()`, Step 2.7): the
  group-growth pass above (Step 2.4) decides zone-by-zone, without knowing
  how heavy every other zone will end up — a zone can land at 4 people
  running half the 4-hour target while a sibling zone is still well over
  target with nobody left to send it. This pass pulls exactly one spare hand
  out of an overstaffed zone (3+ people, so a pair is always left behind) and
  gives it to the heaviest zone, as long as the move actually narrows the gap
  on both ends, doesn't cross the 5.5h cap, doesn't break an incompatible
  pairing or a locked partnership, and doesn't strip a hand from a zone
  already flagged struggling. Flagged both ends (`lent_spare_hand` /
  `received_spare_hand`).
- Short-staffed sequential stacking onto the lightest-loaded group — but
  never onto a zone already flagged struggling (piling more work onto the
  most vulnerable pair, e.g. two new hires with nobody senior to anchor
  them, is exactly backwards), and donor duty spreads across different
  groups rather than the same cheap pair getting tapped for every empty zone
  in a row (`stacked_sequential_donor` flag tracks who's already been used).
- Reinforcement using genuinely idle workers
- Honest shortfall reporting when the crew is over-cap even after
  reinforcement — never silently overloads anyone
- Juice zone's fixed-duration handling (ignores case count and headcount
  entirely, per the design doc)
- Weighted 1st/2nd/3rd zone choices — a strict priority order (everyone's
  1st choice attempted before anyone's 2nd, capped at 3 preferences)
- "Oil and water" incompatibility (`Worker.incompatible_with`) — a hard
  exclusion enforced at every selection point (initial fill, growth,
  reinforcement, redistribution, balance pass, anchor swap), never just a
  scoring penalty. If it leaves a zone understaffed, that's flagged
  (`incompatibility_conflict`) rather than forced. Each entry can carry an
  optional `incompatibility_notes` reason/severity note for context — purely
  informational, doesn't change enforcement (`incompatibility_note()` looks
  it up bidirectionally).
- `unsuitable_for_new_hires` — a known difficult personality that `new`
  hires specifically should never be paired with, folded directly into the
  exact same hard `_is_incompatible` check as personal incompatibility, so
  it carries identical weight everywhere that's checked, including the
  anchor-swap pass — an available `on_pace` donor is never a good enough
  reason to override it.
- Unassigned-worker redistribution: `suggest_redistribution()` proposes
  where leftover workers could help most — a zone flagged as likely to
  struggle gets priority regardless of its raw hours, heaviest eligible
  zone after that, capped at `max_group_size`, respecting incompatibility
  — `apply_redistribution()` only acts on it once accepted. Never
  auto-applied.
- Proactive load balancing (`rebalance_light_zones()`, Step 2.6): runs on
  *every* night, not just short-staffed ones. A pair that finishes with a
  very light load (`workload_hours` at/below `light_load_threshold` ×
  `grocery_target_hours`) gets stacked onto the zone that needs help most as
  a second, sequential assignment — same mechanic as short-staffed stacking,
  just applied proactively for balance. Struggling zones get this help even
  if their raw hours are under target; a struggling zone is never treated as
  a donor. Both ends get flagged (`lent_to_heavier_zone` /
  `balanced_second_zone`), never silent, and it never exceeds `max_group_size`
  or the 5.5h cap.
- Zones display by their actual aisle numbers (`Zone.label()`, e.g. "Aisle
  10 & 11"), not the internal letter code — nobody on the floor thinks in
  "Zone E."
- Aisle 1 (produce) is excluded entirely — this store doesn't run produce as
  part of nightly grocery freight, so it's dropped even though it appears on
  the freight sheet (see design doc §5/§7).
- Each worker's name in `demo.py`'s printed output is shown with their
  current efficiency rating number in parentheses — `1.00` on pace, `0.75`
  needs improvement, `0.50` new — the same numbers already driving the
  `workload_hours` math (`Settings.efficiency()`), just surfaced next to the
  name instead of buried in the calculation. These start as placeholders and
  are meant to be replaced with real calibrated values as
  `actual_vs_estimate_ratio` data accumulates over the coming weeks (design
  doc §6, §11).
- Fixed departments (`assign_fixed_departments()`, Step 0.5): Dairy and
  Frozen aren't case-driven and aren't filled from the general
  preference-matched pool at all — only specific trained people ever cover
  them, pulled straight out of the pool before `fill_zones()` even starts.
  `Worker.fixed_department` means that person covers that department every
  single night (Danarys and Drogo on Frozen). `Worker.department_rotation_pool`
  means they're one of a named group who take turns when the pool is bigger
  than the nightly headcount (Teu'ris, Nedylene, Charlotte, and Iga taking
  turns 3-of-4 on Dairy) — the rotation itself is deterministic by day of
  year (`_rotate_pick()`), so who's picked shifts every real calendar day
  with zero persisted state needed between runs; pass `rotation_key` to
  `assign_night()` to preview a specific day. Both zones use `Zone.fixed_headcount`
  (3 and 2) rather than case-rate sizing, and are walled off from every other
  pass in the pipeline (anchor-swap, stacking, rebalancing, redistribution) —
  they're never used as a *donor* source for another zone either, so their
  dedicated crew's night stays entirely inside their own department. Dairy
  and Frozen headcount is a hard guarantee, not best-effort: if the
  dedicated + rotation people don't add up to target (someone's out, the
  rotation pool itself is short), the remaining slots are backfilled
  straight from the general grocery pool, preferring `on_pace` workers over
  anyone still learning the ropes. Every backfilled slot is flagged
  (`fixed_department_backfill`) with a note naming who filled in, and on the
  rare night the whole active roster still isn't enough to reach target,
  that's flagged too (`fixed_department_understaffed`) rather than
  pretending the gap didn't happen.
- Hard-locked partner pairs (`Worker.locked_with`): a step up from
  `preferred_partners` — that's a scoring bonus that can still lose to other
  pressure, this is a hard "must always be together," for pairs whose
  combined performance is worth more than anything a rebalance pass might
  gain by splitting them. Seeded together before even mutual-partner pairs
  (Phase -1), winning any capacity race including one where the two members
  stated *different* individual zone preferences, and explicitly protected
  inside the anchor-swap pass — neither half of a locked pair can ever be
  pulled out alone, even when they're the only possible donor for a
  genuinely struggling zone (in that case the struggling zone just stays
  struggling; the lock wins).

- Worker ids in `demo.py` (`wid()`) `.strip()` before lowercasing, so real
  intake sheets — where names come in as a "First Last" column value — won't
  produce a different id for the same person over stray whitespace. The
  space in the name itself is kept as-is; it's just part of the id string.

## What's NOT in here yet

- OCR / photo parsing (no sample photos to test against)
- The Review & Correct, Schedule Output, Worker Roster, Nightly Checklist
  screens — this is backend logic only
- Water pallet subtraction (`PalletType` table) — separate concern, tracked
  in `water_pallet_tracker.xlsx`
- `hire_date` reminders and the auto-promotion rule (`new` → `needs_improvement`
  after 5 hits at 0.75) — these depend on tracking data across *multiple
  nights*, and this prototype only models a single night at a time

## Bugs worth knowing about (found and fixed during this build)

**Zone-order stranding.** The first version filled zones strictly in a fixed
order (A, B, C...). That's broken: an early zone with no natural fans would
happily absorb workers whose real preference was a zone processed later,
stranding the people who should've ended up together. Fixed by processing
preference rank tiers across all zones simultaneously — everyone's top
preference gets a shot before anyone's second preference is considered.
`test_assignment_engine.py` Test 1 locks this in.

**Mutual pairs split by fill-order luck.** Found by testing against a real
24-person roster with actual partner data instead of synthetic examples that
happened to also have zone preferences set. When workers have *only* partner
preferences and no zone preferences (a completely realistic case — most
people don't have a favorite aisle, they have a favorite coworker), a zone's
first pick has nothing to score a partner match against, since the group is
still empty. With no zone preference to break the tie either, the fill just
grabbed whoever was first in list order — silently splitting up workers who
had explicitly listed each other. Three real mutual pairs (Avicel/Clare,
Danarys/Drogo, Lydia/Lisette) got scattered into different zones on the
first real-data test run. Fixed by seeding known mutual pairs together,
heaviest zones first, *before* any other fill logic runs. Test 11 is a
synthetic regression test for this; the real-roster run in `demo.py`
(scenario 5) double-checks it against the actual data.

**Phase-0 seeding hijacking stated zone preferences.** A direct regression
from the fix above. Once mutual pairs got seeded together heaviest-zone-
first, that seeding started running for *every* mutual pair — including
ones who'd both explicitly picked a zone. Alex and Brianna, mutual partners
who both listed zone C ("Aisle 6 & 7") as their #1 choice, were getting
dropped into zone A (the heaviest zone) instead, since Phase 0 ran before
their stated preference was ever consulted. Fixed by scoping Phase 0 to
only pairs where *neither* member has any `preferred_zones` set — pairs
that do have a stated preference are already reunited correctly by Phase
1's existing rank-tier + partner-bonus logic, so Phase 0 doesn't need to
(and shouldn't) touch them. Test 12 locks this in.

**Shortfall total multiplied by how many zones a stacked worker touched.**
Found by inspection of the severe-shortage scenario's printed output — a
zone showing a comfortable 2.50h `workload_hours` was tagged `[over_cap]`,
which looked wrong at a glance. That flag is actually correct: it means "a
worker in this group is over the 5.5h cap once their *whole night* is
totaled up across every zone they're stacked into" — not that this zone
alone is the problem. But `compute_shortfall` had a real bug sitting next
to that: it summed each over-cap worker's overage once per zone they
appeared in, rather than once total. A worker stacked across 3 zones had
their 2.33h overage counted 3 times; scenario 3's reported shortfall came
out to "33.02h uncovered" when the real number (each worker's overage,
counted once) was 20.06h. Fixed by deduping the overage per worker inside
`compute_shortfall`, and rewrote the shortfall note to list each over-cap
worker by name with their actual nightly total, instead of a single
opaque aggregate number. Test 13 locks in the non-inflation; the corrected
`compute_shortfall` signature now returns the per-worker breakdown too
(`over_by_worker`) for anything that wants to display it directly.
