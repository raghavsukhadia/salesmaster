# Sales Master

Field sales intelligence and dealer management. Stack: React + TypeScript + Tailwind (`frontend/`), Django + DRF (`backend/`).

Deployment: [Vercel frontend + Google Cloud backend](docs/DEPLOYMENT_VERCEL_GCP.md). Includes Cloud Run, PostgreSQL, private photos, secrets and importing only the retained `admin` and `demo@sunkool.in` accounts.

## Run

```
cd backend
python -m venv .venv; .venv\Scripts\pip install -r requirements.txt
copy .env.example .env      # set DJANGO_SECRET_KEY, or keep DJANGO_DEBUG=true
.venv\Scripts\python manage.py migrate
.venv\Scripts\python manage.py createsuperuser
.venv\Scripts\python manage.py runserver

cd frontend; npm install; npm run dev
```

Tests: `cd backend; .venv\Scripts\python -m pytest`  (frontend logic: `cd frontend; npm test`)

## Field Sales (GPS duty tracking, live map, nearby dealers)

Opening the signed-in salesman app automatically starts or resumes a duty session. The app records GPS only inside these sessions, with browser location permission; managers get a live map, nearby-dealer
search (1/3/5/10/20 km), reverse search (nearest salesman to a dealer) and a verified dealer location master.
Design, API, permissions, migration plan and trust model: [docs/FIELD_MODULE.md](docs/FIELD_MODULE.md).
The tracking map shows every located dealer as a red pin and the selected salesman with a distinct person icon. Data requirements and Google Cloud import notes: [docs/DEALER_MAP.md](docs/DEALER_MAP.md).
After `migrate`, schedule `manage.py close_stale_sessions` (every 15 min), `manage.py purge_location_data` and
`manage.py purge_orphan_photos` (both daily).

There is no separate Field Duty screen or manual Start/End duty step. The salesman app shell starts duty on any page and shows location-sharing status and the notice throughout the app. Sign-out immediately stops GPS, uploads queued points when possible and closes the duty session; offline closure is retried at the next connection/login. The browser still controls location permission. Closing the browser stops client recording, but immediate server-side closure on browser exit is not guaranteed; existing session expiry and stale/lost statuses still apply.

On the Order Details step a salesman can add car photos and tap **Capture location**; both are optional and are shown to
management on the Visit page (photos, plus the visit location with an "Open map" link). If the salesman pressed "Detect current
location" on a new dealer, that position is also saved as the visit's location. A visit never needs photos: the server enforces a
minimum only if `VISIT_MIN_PHOTOS` is set above 0 (default 0). Photos are re-encoded without GPS/EXIF, stored privately under
`backend/media/` and shown on the visit pages. Back that folder up together with the database.

## Architecture decisions

- **Auth:** DRF + SimpleJWT. `accounts.User.role` is `salesman | manager | admin`. Role gating uses DRF permissions in `apps/accounts/permissions.py`; the frontend guard is UX only.
- **Dealer access:** `dealers.access.accessible_dealers` is the single authorization path. Visibility comes from current ownership (`DealerOwnershipHistory`, `ended_at IS NULL`) and un-revoked `DealerAccessGrant` rows. `SalesmanTerritory` is planning only and never grants visibility. `Dealer.primary_salesman` is a legacy reporting column.
- **Orders:** no orders table; an order is the `VisitOrderItem` rows on a visit. `VisitProduct` is interest only.
- **Supabase equivalents:** RLS becomes queryset-level filtering through `accessible_dealers`. The `record_visit_atomic` RPC will become a service function in a `transaction.atomic()` block.

## Record Visit API (salesman only)

- `GET /api/salesman/dealers/?q=` searches only dealers the salesman owns or holds a grant for.
- `POST /api/dealers/check-duplicate/` takes `name, phone, whatsapp, gst_number, city`. It returns `{duplicate: false}` or the accessible match. An inaccessible match returns 409 "This dealer is not available to you" with no names or owners.
- `POST /api/visits/record/` takes exactly one of `dealer_id` or `new_dealer`. It also accepts `client_request_id` (UUID), `visited_at`, `latitude`/`longitude`, `notes`, `has_order`, `order_items` (`product_id` or free-text `product_name`, plus `quantity`) and `followup` (`due_date`, `priority`, `notes`).
  - **Transaction:** the dealer, its ownership, the contact, the visit, the order lines and the follow-up are written in one transaction. Any failure rolls back everything.
  - **Duplicate submits:** a repeat of the same `client_request_id` returns 200 with the original visit and creates nothing.
  - **Duplicate dealers:** matching runs mobile/WhatsApp, then GST across all dealers and returns 409 for a match. Names, including name + city, may repeat when the mobile numbers differ.
  - **Existing dealers:** a nonexistent dealer and an inaccessible one both return 404.
  - **Orders:** custom order items stay on the visit and never enter the catalogue. Inactive or unknown products are rejected.

Dealer phone uniqueness: `Dealer.phone` is normalised on every save (`apps/dealers/phone.py`: digits only, last 10, so `+91 98765-43210` and `09876543210` are the same number) and a partial DB unique constraint `dealer_phone_unique_when_set` (blank phones may repeat) rejects duplicates, including simultaneous requests. The app-level check (`find_duplicate`, which also matches WhatsApp and GST, but never name+city) still runs first and returns the existing 409 `duplicate_dealer` (or "This dealer is not available to you" when the dealer isn't accessible, so no names or owners leak). If two requests race past that check, the loser hits the constraint, its whole transaction rolls back (no dealer, ownership, visit, order lines or follow-up), and it gets the same 409; an identical resubmit (same `client_request_id`) returns the original visit. Dealer edits return 400 `{"phone": "Another dealer already uses this phone number"}`. Constraint scope: `phone` only; phone-vs-WhatsApp collisions are still checked in application code. `bulk_create`/`QuerySet.update` skip `save()`, so they must pass normalised values (the constraint still blocks exact duplicates).

Migrations `dealers.0004_dedupe_dealer_phones` (data) and `0005_dealer_phone_unique` (constraint): existing phones are normalised; when several dealers share a number the oldest keeps it, and each other dealer gets its number copied into a contact named "Duplicate phone (migrated)" before its own phone is cleared. Nothing is deleted or merged and ownership/visits are untouched; review those contacts afterwards. The reverse is a no-op. Dev/tests use a file-backed SQLite (`test_db.sqlite3`, IMMEDIATE transactions) so concurrency tests are meaningful; on Postgres the constraint is enforced natively.

## Management API (admin/manager only, read-only)

`GET /api/management/{dashboard,dealers,salesmen,visits,followups}/` back the top-nav screens. List endpoints are server-side filtered, sorted and paginated (25 per page). Dealers filter by assignment, archive state, state, city, status, owner and search. Visits filter by range and search. Follow-ups filter by tab and search. "Overdue" and "Due Today" are derived from `due_date`, not stored. `Dealer.is_archived` backs the Active/Archived/All filter.

Salesmen actions, Assign Owners, Export, and the visit/follow-up View pages are rendered but disabled; they are the next slice. The dealer "View" link opens the Dealer Detail screen below.

## Dealer Detail (`/dealers/:id`)

| Endpoint | Who | Purpose |
|---|---|---|
| `GET /api/dealers/:id/` | any authenticated user who can access the dealer | profile, contacts, stats, `permissions` flags |
| `PATCH /api/dealers/:id/` | admin, manager; the owning salesman for `name`, `address`, `city`, `state`, `pincode` only | edit profile, status, archive. Rejects bad GSTIN/pincode and a phone/GST used by another dealer. A salesman sending any other field gets 403 and nothing is saved; one who only holds an access grant also gets 403 |
| `GET /api/dealers/:id/{visits,orders,followups,activity}/?page=` | same as GET | paginated history (25 per page). Orders are visits that have `visit_order_items` |
| `POST /api/dealers/:id/transfer/` | admin | `{salesman_id, reason}`. Ends the current ownership row, opens a new one, updates legacy `primary_salesman`, retires a now-redundant grant |
| `POST /api/dealers/:id/grants/`, `POST .../grants/:gid/revoke/` | admin | add and revoke access grants. One active grant per salesman and dealer (DB constraint) |

Role matrix: **admin** does everything. **Manager** views and edits the profile, and sees owner, ownership history and grants read-only. **Salesman** gets read-only access to dealers they own or hold a grant for through **My Dealers** (`/my-dealers`, `/my-dealers/:id`). The one exception is the **Edit** buttons for dealer name and address on Visit Details (`/visit-history/:id`), shown only for dealers the salesman currently owns (`dealer.can_edit` in the visit payload). Their response has no owner, ownership history or grants and the activity feed omits ownership and access events. An inaccessible or missing dealer returns the same 404.

### Area transfers and historical orders

Admin **Dealers → Transfer Area** (`/dealers/transfer`) transfers the selected salesman's active dealers in a state, city, or an individual dealer. State choices come from the selected salesman's current holdings. The preview shows affected dealers, past orders, assigned territory labels and optional open follow-up reassignment before confirmation. The new salesman sees transferred areas and cities in **My Dealers**, can search dealers by name/mobile/city and open their complete, paginated order history, including previous salesmen's orders. Visit History continues to show only the signed-in salesman's own visits.

Transfers update ownership and planning territories, plus pending follow-ups if selected. They never rewrite visits or order lines. Each visit saves an immutable `salesman_name` alongside its original `salesman_id`; dealer history, visit screens and order reports use this snapshot, so changing a salesman's profile name cannot rename their old orders. Orders display product and creator, e.g. **HD 70 – Rakesh**. Salesmen have no update/delete endpoints for historical visits or orders.

Run `python manage.py migrate` when deploying. Migration `visits.0007_visit_salesman_name` backfills existing visits from their original creator's currently stored full name (username if absent), preserving every existing visit field and order line. Earlier profile names that were never stored cannot be reconstructed. Regression coverage: `backend/apps/dealers/test_area_transfer.py` and `backend/apps/visits/test_attribution_migration.py`.

Ownership history is authoritative. Every transfer, grant and revoke records who did it (`changed_by`, `created_by`, `revoked_by`) and appears in the Activity tab.

## Salesman Visit History and Follow-ups (`/visit-history`, `/visit-history/:id`, `/followups`)

Salesman-only (`IsSalesman`); admin and manager get 403 from the API and are redirected by the route guard. All data is scoped to the signed-in salesman's own records **and** to dealers they can still access (`accessible_dealers`). If a dealer is transferred away, that dealer's past visits and follow-ups disappear from the old owner's lists and return 404. A grant on another salesman's dealer does not reveal that salesman's visits or follow-ups.

| Endpoint | Purpose |
|---|---|
| `GET /api/salesman/visits/?q=&from=YYYY-MM-DD&to=YYYY-MM-DD&status=&order=yes\|no&source=&page=` | own visits, newest first, 25 per page, with a summary (total, with orders, last 7 days). `from`/`to` are inclusive local days and either may be omitted; a bad date or `from` after `to` returns 400. The older `range=today\|7\|30` still works |
| `GET /api/salesman/visits/:id/` | dealer, notes, order lines, product interests, location, follow-ups |
| `GET /api/salesman/followups/?tab=pending\|due_today\|overdue\|completed&q=&priority=&page=` | tab list plus counts for every tab |
| `POST /api/salesman/followups/:id/complete/` | `{outcome?, notes?}`; outcome is one of interested, call_again, send_quotation, no_answer, not_interested |
| `POST /api/salesman/followups/:id/reschedule/` | `{due_date, priority?, notes?}`; today up to one year ahead |
| `POST /api/salesman/followups/:id/cancel/` | `{notes?}` |

**Next step on Record Visit.** The Order details step ends with a required "What should you do next?": Nothing, Call dealer, Send quotation, Send sample, Revisit dealer, Collect payment or Other, then "When?" (Tomorrow, In 2 Days, Next Week or a custom date), a "What to do" text for Other, and an optional note. The form will not save until one is chosen; "Nothing" saves the visit with no follow-up. The choice is stored on the follow-up as `action` (and `action_text` for Other) and returned as `task`, the words shown in the follow-up lists. The API keeps `followup`, `action` and `action_text` optional because field check-ins and follow-ups made before this change have none, so the "required" rule is enforced in the form.

Only pending follow-ups can be changed. A second action on a closed follow-up returns 400, so a double tap cannot apply twice (the row is locked inside a transaction). Cancelled follow-ups are kept but not listed. Pending covers Due Today and Overdue; those states stay derived from `due_date`. Salesman pages now share a three-link nav in the `Guard` header.

## Salesman Management (`/salesmen`, `/salesmen/:id`)

Logic lives in `apps/management/salesman_service.py`; views and serializers in `salesman_views.py`. Dealer reassignment reuses `transfer_ownership`, so history, grants and the legacy `primary_salesman` column stay consistent.

| Endpoint | Who | Purpose |
|---|---|---|
| `GET /api/management/salesmen/` | admin, manager | list (old keys kept; adds `username`, `targets`) |
| `POST /api/management/salesmen/create/` | admin | creates the login (role salesman) and profile together |
| `GET /api/management/salesmen/:id/` | admin, manager | profile, targets, territories, performance |
| `PATCH /api/management/salesmen/:id/` | admin, manager | names, email, phone, `is_active`, targets. Deactivating also disables the login |
| `DELETE /api/management/salesmen/:id/` | admin | only when there are no visits, follow-ups or ownership rows |
| `POST .../:id/reset-password/` | admin | validated with Django password rules |
| `PUT .../:id/territories/` | admin | replaces the planning list (duplicates ignored) |
| `POST .../:id/assign-dealers/` | admin | `{dealer_ids, reason?}`, up to 200, all-or-nothing; dealers already owned are skipped and counted |
| `POST .../:id/offboard/` | admin | `{transfer_to?}`: deactivates the login, revokes grants, hands dealers and pending follow-ups to another active salesman or releases them |
| `GET .../:id/visits/`, `GET .../:id/dealers/?q=` | admin, manager | paginated (25) |

Targets (`daily_visit_target`, `monthly_visit_target`, `monthly_order_target`) are counts, not money; 0 means no target. An order is a visit with at least one order line. Performance is today and month-to-date vs target, new dealers, dealers owned, pending/overdue follow-ups and days since last visit. Territories are for planning and never grant dealer visibility. Phone numbers are normalised to 10 digits and must be unique.

## Management Visit and Follow-up Detail (`/visits/:id`, `/followups-management/:id`)

Read-only pages reached from the "View" link on Visit Activity and Follow-up Management. Admin and manager only (`IsManagement`); salesmen get 403 even for their own records, and the route guard redirects them. Management sees every dealer, including archived ones, so these endpoints do not apply `accessible_dealers`. The salesman-scoped endpoints remain the only salesman path.

| Endpoint | Returns |
|---|---|
| `GET /api/management/visits/:id/` | dealer (with current owner), salesman, date/time, source, notes, three distinct locations (visit, salesman, dealer) plus source, capture time and distance from the dealer in metres, order lines (catalogue vs custom, total quantity), product interests, follow-ups from the visit |
| `GET /api/management/followups/:id/` | due date, state, days overdue, priority, outcome, what to do (`task`), notes, dealer, salesman, source visit, earlier and next follow-ups, activity history |

Follow-ups have no event log, so "activity history" is derived from the linked visit, the follow-up's creation time, its parent and its next follow-ups. Status changes (complete, reschedule, cancel) are not timestamped. A real audit trail would need an event table or `audit_logs`; that was left out deliberately.

## Reports & Analytics (`/reports/...`, `apps/reports`)

Read-only reports with no new tables and no migrations. `GET /api/reports/<slug>/` returns one payload (`cards`, `charts`, `tables`, `rankings`, `options`, `notes`, `warnings`) that the screen renders generically and the exports reuse, so a file always matches the filters on screen.

| Slug | What it shows |
|---|---|
| `overview` | totals, daily / monthly / yearly charts, top salesmen, products and dealers |
| `date-wise`, `periods` | per day; month by month and year by year with growth |
| `salesman-wise` (+ `/<id>/`) | per-salesman figures, three leaderboards, complete sales history |
| `dealer-wise` (+ `/<id>/`) | top 10 by orders and by quantity, new vs repeat, product preferences, dealers with no recent order (`idle_days` 30/60/90) |
| `product-wise`, `salesman-product` | most / least selling, best category, unsold catalogue items; who sells which product |
| `order-wise` | every order with its items, searchable (`q`), 25 per page |
| `visit-performance`, `followup-reports` | conversion, visits without orders; pending / completed / overdue and follow-ups that led to an order |
| `sales-targets` | the existing monthly order and visit targets against the chosen `month`, ranked |
| `compare` | `type=salesman\|product\|dealer\|month\|range`, `a=`, `b=`: side by side with growth or decline from A to B |

Filters (all optional, combinable): `preset` (today, yesterday, last7, last30, this_month, last_month, this_year, custom with `from`/`to`, all), `salesman`, `dealer`, `product` (`p<id>` or `n:<free-text name>`), `category`, `unit`, `order`. Exports: `GET /api/reports/<slug>/export/?file=xlsx|pdf` with the same query string (`?format=` is reserved by DRF). Print uses the browser's print layout.

Rules that every figure follows:

- An **order** is a visit with at least one order line; there is no orders table, no order status and no price in the reports. Every recorded order counts as a sale, and nothing is called revenue.
- Quantities are summed from order lines only. Visits and follow-ups are counted in separate queries and never joined to lines, so nothing is counted twice.
- **Units:** Record Visit lets a salesman pick a unit per line, and quantities in different units must not be added up. When the matching lines use more than one unit, the payload carries a `warnings` entry, the screen offers one-click "Show only" buttons for each unit, and Overview / Product-wise add a "Quantity by unit" table. The `unit` filter compares like with like.
- **Access:** management sees everything. A salesman is forced onto their own visits and onto dealers they can still access (the same rule as Visit History); the `salesman` parameter is ignored for them, other salesmen's pages return 404, and they cannot compare salesmen.
- A given **Order ID** ignores the date range, so an order is always found. Follow-ups are selected by due date. Product, category and unit filters narrow order lines only; visits are not product-specific.
- **Follow-up "converted into an order":** the same salesman later recorded an order with the same dealer (the visit that created the follow-up does not count; cancelled follow-ups are left out).
- **New vs repeat dealer:** new when their first-ever order falls inside the period. For "All time", dealers with 2 or more orders count as repeat.

Which reports the app offers is one list: `ENABLED_SLUGS` in `frontend/src/pages/reports/reportNav.ts` (currently only `overview`, admin and manager). The other reports and their API stay built and tested; add a slug to bring one back. Salesman access also needs the route guard in `App.tsx` and the salesman nav item in `nav.ts` changed. Tests: `backend/apps/reports/tests.py` and `frontend/src/pages/reports/reports.test.ts`. PDF export needs `reportlab` (in `requirements.txt`) and uses the built-in fonts, so non-Latin text shows as `?` in PDFs (Excel keeps it).

Done: scaffold, schema (users, salesmen, territories, distributors, dealers, contacts, ownership, grants, products, visits, order items, interests, follow-ups), role-gated API, JWT login, route guards, access tests.

Not yet: WhatsApp and AI tables and pipeline, record-visit service, dealer duplicate check, all feature screens, attachments, audit logs.

## App shell and design system (frontend)

White surfaces, navy `#0b2347` primary, orange `#ff6b1a` accent (tokens in `src/index.css`; orange is for fills and indicators, use `accent-ink` for orange text). Inter, 8px spacing, 12-16px card radius, Lucide icons.

- **Shell:** `components/AppShell.tsx` = fixed `Sidebar` (collapsible on desktop, off-canvas drawer below 1024px, collapse state kept in localStorage) + sticky `TopBar` (breadcrumbs, global search, date range, alerts, account menu). `ShellGuard` in `App.tsx` signs the user in once and picks the role's nav; salesmen get the same shell with their own items.
- **Adding a module:** add the route in `App.tsx`, then one entry in `components/nav.ts` (`to:` for a page, `children:` for a group) and, for a new URL, a label in `components/crumbs.ts`. An entry with `soon:` instead of `to:` is shown as unavailable with that reason, and does nothing else. `components/logic.test.ts` fails if an item is none of: a route, a group, or an explained "not available".
- **Shared kit:** `components/ui.tsx` (Button, Card, Table with sortable headers and skeleton/empty/error states, Pager, Modal, Field with inline errors, EmptyState). `useConfirm()` replaces `window.confirm` (promise-based, destructive style, focus starts on Cancel) and `useToast()` reports success, error and info. Pure helpers live in `components/logic.ts` so `npm test` can cover them.
- **Date range:** the top-bar selector writes `?range=today|week|month|all` (default 30 days) and only appears where it has an effect: Dashboard "Recent visits" and the Visits page. The KPI cards and Salesman activity are today's numbers by definition.
- **Global search** (management only): dealers via `GET /api/management/dealers/?q=`, salesmen filtered client-side from the full list. `/` or Ctrl/Cmd+K focuses it.
- **Alerts (bell):** built from live counts (overdue follow-ups, unassigned dealers, dealers with no visit in 30 days; for salesmen, their overdue and due-today follow-ups). There is no notifications table, so "new" means the counts changed since the menu was last opened on that device.
- **Not built:** Settings is listed in the sidebar as unavailable. There is no Beat Planning entry in the sidebar. Live tracking and nearby dealers come from the `apps/field` work.

Additive API fields used by the dashboard (nothing existing was removed or renamed): `GET /api/management/dashboard/` adds `trends` (yesterday's visits and new dealers) and, per salesman, `id` and `last_visit_at`; every visit row adds `checkin` (`{lat, lng, source}` from the visit's GPS fix, or `null`); `GET /api/management/dealers/?visit=stale` lists dealers never visited or not visited for 30 days, the same definition as the dashboard card (`stale_visit_q` in `apps/management/views.py`).
