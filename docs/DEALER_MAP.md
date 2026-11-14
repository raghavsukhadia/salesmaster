# Dealer locations and salesman tracking

Live Salesman Tracking shows all saved, non-archived dealer locations as **red location pins**. The salesman selected in the name dropdown appears with a separate **blue person icon**. Stale or lost salesman positions retain the person shape with an amber or grey treatment and their actual position age; off-duty salesmen have no location marker.

Dealer pins remain visible before choosing a salesman and while the selected salesman is off duty. Selecting a salesman focuses the map on their available position without removing dealer pins. Click a dealer pin to see its name, contact and saved address/location details. An unverified location has a dashed pin outline and is labelled in its details.

## Saving a dealer list on Google Cloud

The map reads the backend's Django `Dealer` records. In the prepared Google Cloud deployment these records are in Cloud SQL. Use these existing dealer fields when saving/importing records:

| Field | Purpose |
| --- | --- |
| `name` | Dealer name shown on the pin; duplicate names are allowed |
| `phone` | Unique mobile number when provided |
| `latitude` | Exact shop latitude, such as `18.520400` |
| `longitude` | Exact shop longitude, such as `73.856700` |
| `address`, `city`, `state` | Dealer details shown with the name |
| `location_source` | Use the existing source appropriate to the capture, for example `import` |

The example coordinates above identify a point in Pune; they are not a default to apply to other shops. Store each dealer's own coordinates. A name or name/city alone cannot identify an exact shop location, particularly because dealer names can repeat. The map does not guess a position or automatically geocode names.

For dealers already saved without coordinates, open **Management → Dealer Locations**, choose the dealer, and set its location with the existing map pin or latitude/longitude fields. Save and verify the shop location when appropriate. A GPS fix captured during new-dealer entry can also supply coordinates.

Uploading a CSV to a Cloud Storage bucket alone does not create database dealers. Import its records into the application's dealer table through your data-import process first, including each shop's coordinates, or set those coordinates in Dealer Locations afterwards. Do not edit order or visit attribution during a dealer import.

## Refresh and access

The management-only `GET /api/management/field/dealer-markers/` endpoint returns every located dealer, without the ordinary 25-row pagination or nearby-search radius/result cap. It excludes archived dealers, missing/partial coordinates, invalid latitude/longitude and the `(0, 0)` placeholder. Missing locations are counted and linked to Dealer Locations on the tracking page.

Dealer pins reload on page entry, on **Refresh**, and every 60 seconds while the page is visible. Salesman positions continue to refresh every 15 seconds. When deployed, the frontend's existing `VITE_API_BASE_URL` points these calls at the Google Cloud backend; no database credentials are sent to the browser.

No map data was inserted as part of this feature. The actual dealer list and coordinates must be saved in the application's database before its pins can appear.
