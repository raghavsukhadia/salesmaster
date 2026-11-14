# Field Sales Management module

GPS duty sessions, live tracking, nearby-dealer search, reverse search (nearest salesman to a dealer) and the
dealer location master. Built into the existing Django + React app; it adds one backend app (`apps/field`) and
reuses the existing users, `Salesman`, `Dealer`, ownership/access rules and role permissions.

## Status

| Slice | State |
|---|---|
| 1. Duty sessions, GPS upload, offline queue, live status | **Built and tested** |
| 2. Admin live map, route history, audit log, retention | **Built and tested** |
| 3. Nearby dealers (1/3/5/10/20 km), reverse search | **Built and tested** |
| 4. Dealer location master (verify, territory, contact) | **Built and tested** |
| 5. Beat planning, geofenced check-in/out, visit outcomes, follow-up tasks | **Backend built and tested** (API below). The salesman check-in screen and the manager beat-planning screen are **not built yet**; "Beat Planning" in the sidebar still says "not available" |
| 6. Car photos on every visit (minimum 2, server-enforced) | **Built and tested**, in Record Visit's Order Details step and on both visit-detail pages |
| 7. Route optimisation, driving distance | Not built (needs a routing provider; see "Distance") |

## What was reused, and what was added

| Need | Reused | Added |
|---|---|---|
| Authentication / roles | `accounts.User.role`, SimpleJWT, `IsSalesman` / `IsManagement` / `IsAdmin` | nothing |
| Employee | `accounts.Salesman` (a duty session belongs to one) | nothing |
| Dealer master | `dealers.Dealer` (already had `latitude`/`longitude`), `DealerContact`, `SalesmanTerritory` | verification columns on `Dealer` |
| Who may see which dealer | `dealers.access.accessible_dealers` (the one authorization path) | nothing |
| Orders | `VisitOrderItem` on `Visit` (there is no orders table) | nothing |
| Territory | `Dealer.state/city` + `SalesmanTerritory` (planning only) | no new table; the master shows which salesmen cover a dealer's territory |

## Migration plan

Four migrations, all **additive** (new nullable columns, new tables, indexes). Nothing is dropped, renamed or
rewritten, so existing data and features are untouched.

1. `dealers.0007_field_location_master`: on `Dealer`: `location_source`, `location_accuracy_m`,
   `location_verified_at`, `location_verified_by`, `geofence_radius_m`; composite index `dealer_lat_lng_idx`
   on (`latitude`, `longitude`). Existing coordinates are kept and show as *unverified*.
2. `field.0001_field_location_master`: `FieldConfig` (single row), `WorkSession`, `LocationPing`, `FieldAuditLog`.
3. `field.0002_beats_and_checkins`: `BeatPlan`, `BeatStop`, `DealerCheckIn`.
4. `visits.0006_visitphoto`: `VisitPhoto` (depends on the existing `visits.0005_followup_due_time`).

How it was checked: each was tested on a copy of the real database first (row counts identical before and after),
then applied to the real one after taking a backup. Apply with `python manage.py migrate`. To roll back:
`python manage.py migrate visits 0005 && python manage.py migrate field zero && python manage.py migrate dealers 0006`,
or restore the backup file.

Schedule three commands (cron / Windows Task Scheduler):

```
python manage.py close_stale_sessions   # every 15 min: ends duty sessions left open > 16 h
python manage.py purge_location_data    # daily: retention (add --dry-run to preview)
python manage.py purge_orphan_photos    # daily: photos uploaded but never attached to a saved visit
```

Postgres: nothing here is SQLite-specific. The partial unique constraints and the btree index are native.

## Data model

* **WorkSession**: a declared duty period. At most one open session per salesman (partial unique constraint).
  Holds the latest accepted fix (`last_lat/lng/accuracy_m/last_fix_at`) so the live map is one query.
* **LocationPing**: one accepted fix. `captured_at` is the *server-validated* time; the raw device time is kept in
  `device_captured_at` and the correction in `clock_skew_s`. `client_point_id` (UUID) makes retries idempotent.
* **FieldConfig**: admin-editable: default geofence metres, enforce/flag mode, ping interval, retention days.
* **FieldAuditLog**: who started/ended/forced a session, viewed a route, ran a reverse search, changed a dealer
  location or the settings, or purged data. Kept 365 days (GPS points: 90 days by default).

## Trust model: how "live" is decided

* **Server clock decides.** A batch carries the device's clock at send time (`sent_at`). If it differs from the
  server's by more than 30 s, every capture time in the batch is shifted by that difference (a phone 10 minutes slow
  still lands at the right time; a phone ahead cannot post from the future). Below 30 s it is treated as network latency.
* **Strict duty window.** A fix is accepted only if its corrected capture time lies inside a declared session
  (from Start to End, inclusive). Offline fixes may arrive up to 48 h after the session ended; nothing is accepted
  for time outside a session. A device whose clock is off by under 30 s can lose a few seconds at either end: the
  safe direction for a "no tracking outside duty" rule.
* **Rejections per point**, never silent: `invalid_coordinates` (incl. 0,0), `accuracy_too_poor` (> 1000 m),
  `future_timestamp`, `outside_session`, `no_session`. Duplicates are counted, not stored twice.
* **Status comes from the capture time of the newest fix, not when it arrived:**

  | status | meaning |
  |---|---|
  | `live` | newest fix is ≤ 2 min old (only this sets `is_live: true`) |
  | `stale` | ≤ 15 min old: last known position, may have moved |
  | `lost` | older than 15 min |
  | `no_fix` | on duty, no fix yet |
  | `off_duty` | no session: **no coordinates are returned at all** |

  The screen also ages positions itself between polls, so if updates stop arriving a green marker turns amber, then
  grey, without waiting for the server. A synced offline backlog can never make an old position look fresh: the
  stored "latest" only moves forward in capture time.
* **Accuracy is stored and labelled** (`good` ≤ 50 m, `fair` ≤ 150 m, `poor`). Reverse search ignores non-live
  salesmen unless `include_stale=true`, and then every row still states its age.
* **Limits no web app can remove:** a browser can only record while the page is open and the screen on; location
  can be spoofed on a rooted/modified device; geolocation needs HTTPS (or localhost) in production.

## Distance: straight-line vs driving

Every distance in an API response is straight-line (great-circle). Rows carry `straight_line_m` and
`driving_m: null`; payloads carry `distance_basis: "straight_line"` and a note. The UI labels them "straight-line"
and offers a *Directions* link into a maps app for real road distance and time. Driving distance needs a routing
provider (OSRM, Google, ...); when one is added it fills `driving_m` and nothing else changes.

## Nearby search and indexing

`dealers_within()` converts the radius to a bounding box (antimeridian and poles handled), range-scans the
`dealer_lat_lng_idx` index, then keeps rows within the exact haversine radius. A test asserts the query plan uses the
index and cross-checks 300 random dealers against brute force at 1/3/5/10/20 km. Dealers with no coordinates, or
the (0, 0) placeholder, never match. Salesmen only ever get dealers from `accessible_dealers`. If the dealer table
grows past a few hundred thousand rows, swap this one function for PostGIS (`geography` + GiST); callers are unaffected.

## API

All JSON, JWT bearer auth. Errors: `400` validation, `401` unauthenticated, `403` wrong role, `404` unknown.

### Salesman (`IsSalesman`)

| Method + path | Purpose |
|---|---|
| `GET /api/field/session/` | `{on_duty, server_time, session, tracking{status,is_live,age_s}, policy{consent_version, ping_interval_s, retention_days, notice[]}}` |
| `POST /api/field/session/start/` | `{consent: true, consent_version}`: `201` new, `200` already on duty. 400 if consent is false or the notice version is stale |
| `POST /api/field/session/end/` | ends duty (idempotent) |
| `POST /api/field/locations/` | `{sent_at?, points:[{client_point_id, latitude, longitude, accuracy_m, captured_at}]}` (1-200). Returns `{accepted, duplicates, rejected:[{client_point_id, reason}], on_duty, tracking}`. A 200 means every point was judged, so the client may drop the whole batch. Rate limit 60/min/user |
| `GET /api/field/nearby-dealers/?latitude&longitude&radius_km=1\|3\|5\|10\|20&verified_only=` | own + granted dealers, nearest first, max 100 (`total`, `truncated`) |

Beats and check-in (salesman):

| Method + path | Purpose |
|---|---|
| `GET /api/field/today/` | today's beat, any open check-in, and the geofence rules in force |
| `POST /api/field/checkins/` | `{dealer_id, position:{latitude, longitude, accuracy_m, captured_at}, sent_at?, reason?, client_request_id?}`. Needs an open duty session and an accessible dealer. The reading must be fresh (clock-corrected, <= 2 min old). Result `inside / outside / low_accuracy / no_dealer_location` against the dealer's radius (`Dealer.geofence_radius_m` or the default). **Enforce** mode refuses `outside` and `low_accuracy` (422 with distance and radius); **flag** mode allows them but needs a `reason`, which is stored, audited and flagged. A dealer with no location can still be visited and is flagged. One open check-in per salesman; retries with the same `client_request_id` return the same row |
| `POST /api/field/checkins/{id}/check-out/` | outcome (`order_taken, interested, call_again, send_quotation, no_answer, not_interested`), notes, order items, follow-up, `photo_ids`. Creates the `Visit` through the existing `record_visit` service, so orders and follow-ups are the existing records. Atomic: if anything is refused the check-in stays open. Away from the dealer it always needs a reason (it is flagged), because blocking would trap someone who has already left |
| `POST /api/field/stops/{id}/skip/` | skip a stop on today's beat, with a reason |

### Management (`IsManagement` = manager + admin unless noted)

| Method + path | Purpose |
|---|---|
| `GET /api/management/field/live/` | all active salesmen with status, last fix + age; off-duty ones have `last_fix: null`. Audited (once per 15 min per user) |
| `GET /api/management/field/dealer-markers/` | every non-archived dealer with valid saved coordinates, with name/contact/location details; independent of salesman selection, radius and ordinary list pagination. Also returns total, located and missing-location counts |
| `GET /api/management/field/salesmen/{id}/track/?date=YYYY-MM-DD` | that day's route (thinned above 3000 points) + sessions. **Always audited** |
| `POST /api/management/field/salesmen/{id}/end-session/` | **admin only**: force-end a session |
| `GET /api/management/field/nearby-dealers/?latitude&longitude&radius_km=` or `?salesman_id=&radius_km=` | dealers near a point or near a salesman's live/stale position (refused if none recent) |
| `GET /api/management/field/dealers/{id}/nearest-salesmen/?limit&max_km&include_stale=` | reverse search, live on-duty salesmen by distance. Audited. 400 if the dealer has no location |
| `GET /api/management/field/dealer-locations/?status=all\|missing\|unverified\|verified&q&state&city&page` | the location master: coordinates, verification, territory (+ salesmen covering it), contact, summary counts |
| `GET /api/management/field/beats/?salesman_id&date` | a salesman's beat plan for a day (stops in order, each `planned / in_progress / visited / skipped`) |
| `PUT /api/management/field/beats/` | `{salesman_id, date, note, stops:[{dealer_id, note}]}`: replaces the ordered stop list. Only dealers the salesman can access; not for a past date; a stop that already has a visit cannot be removed. Audited |
| `DELETE /api/management/field/beats/?salesman_id&date` | delete an unstarted plan |
| `GET /api/management/field/beats/dealer-options/?salesman_id&q` | dealers that salesman can actually visit (owned or granted), for the planner's picker |
| `GET /api/management/field/checkins/?date&salesman_id&flagged=1` | verified visits with the evidence: distance, geofence result, overrides, outcome, duration |
| `GET/PUT /api/management/dealers/{id}/location/` | set coordinates (`latitude, longitude, source, accuracy_m?, verified, geofence_radius_m?`). Moving a pin clears an earlier verification |
| `POST /api/management/dealers/{id}/location/verify/` | verify the coordinates already on file |
| `GET /api/management/field/config/` | settings (read: management; **`PUT`: admin only**) |
| `GET /api/management/field/audit/?action&salesman_id&page` | **admin only** audit log |

## Permission design

| Capability | Salesman | Manager | Admin |
|---|---|---|---|
| Start/end own duty, upload own GPS | yes | no | no |
| Nearby dealers (own + granted only) | yes | n/a | n/a |
| See live map, nearby (all dealers), reverse search | no | yes | yes |
| Open a salesman's route history | no | yes (audited) | yes (audited) |
| Set / verify dealer locations | no | yes (audited) | yes (audited) |
| Force-end a session, change settings, read audit log | no | no | yes |

Managers see every salesman, as they already do everywhere else in the app: there is no manager-to-team link in the
schema. Raw GPS tables are deliberately **not** registered in Django admin, since browsing them there would bypass
the audit log. Salesmen are told what is recorded before they start (consent dialog, versioned), see the status on
every page, and recording stops the instant they press End duty, even offline.

## Tests

* Backend: `cd backend && python -m pytest apps/field apps/visits/test_photos.py` (201 tests): geometry, index use,
  strict duty window, clock correction, idempotent retries, staleness, role matrix on every endpoint, audit,
  retention, location master, beats, geofenced check-in/out, and the photo rules (validation, metadata stripping,
  privacy, server-enforced minimum).
* Frontend logic: `cd frontend && npm test` (offline queue, sampling, tracker behaviour with fake GPS/network, photo rules).
* Browser end-to-end: scripted Chrome with emulated GPS and network, run on an isolated database copy.

## Beat planning and check-in: how it fits together

* `BeatPlan(salesman, date)` (one per salesman per day) and `BeatStop(plan, dealer, sequence)`; a stop's status is
  *derived* from its check-ins and skip, never stored twice, so it cannot drift.
* `DealerCheckIn` is the evidence (where the phone was, how far from the dealer, which rule applied, any override
  reason); the business record is the existing `Visit` with its order lines and follow-up. Distance is the same
  haversine; a reading less precise than `CHECKIN_MAX_ACCURACY_M` (100 m) cannot be verified, but a reading whose
  whole error circle is farther than the radius is simply "outside".
* Migration `field.0002_beats_and_checkins` (additive: three new tables).

## Visit photos

Salesmen must attach at least **2 car photos** to every visit. The rule lives in the server (`record_visit`), so
the check-out flow and any other client are held to it; `VISIT_MIN_PHOTOS` (env var, default 2) changes or switches
it off (0).

* Photos are staged first (`POST /api/visits/photos/`, multipart `image`), then their ids are sent with the visit
  (`photo_ids`). The visit, its order lines and its photos are written in one transaction; a visit short of photos
  is refused before anything is created. `GET /api/visits/photo-rules/` tells the form the minimum.
* Every upload is verified as a real image (JPEG/PNG/WebP, <= 15 MB) and **re-encoded** to a clean JPEG, longest
  side 2000 px: this drops the GPS and other EXIF metadata phones embed, bakes in the orientation, and removes
  anything hostile hidden in the file. The app also shrinks to 1600 px before sending, to spare mobile data.
* Photos are private. They are served only through `GET /api/visits/photos/{id}/image/` to the salesman who took
  them and to managers/admins (everyone else gets 404, so existence is not revealed); there is no public media URL.
  They show on the manager's and the salesman's visit-detail pages.
* Staged photos that never reach a saved visit are removed by `manage.py purge_orphan_photos` (daily).
* Migration `visits.0006_visitphoto`. Files live under `backend/media/` (git-ignored; back it up with the database).
