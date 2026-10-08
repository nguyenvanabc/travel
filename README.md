# Seoul Trip Companion 2026 — refactored build

## Deploy
Upload the contents of this folder to the GitHub Pages repository. Keep the directory structure:

- `index.html`
- `css/styles.css`
- `js/app.js`
- `js/services/route-service.js`

## Important routing decision
This build intentionally does **not** call Naver/Kakao/Google routing APIs and contains no routing API token.

The app:
- keeps the existing Leaflet day map;
- shows ordered day-to-day place segments;
- shows straight-line distance only as an estimate;
- provides normal map links for opening an actual route in a map app/service;
- never invents transit duration.

Actual transit duration is therefore calculated by the map service after the user opens the route, rather than by this GitHub Pages app.

## Main refactor
- CSS moved out of `index.html`.
- Application JavaScript moved out of `index.html`.
- Token-free navigation helpers isolated in `js/services/route-service.js`.
- Mobile navigation reduced to five primary destinations.
- Mobile-first touch targets and bottom-sheet modal layout.
- Day summary and route segment presentation.
- Explicit `Asia/Seoul` trip clock for Today/countdown/alerts.
- Only the active screen is re-rendered instead of rebuilding all six screens on every state update.
- Quick navigation from More for Places/DSP/Itinerary/Expenses.
- Offline/online visual state indicator.
- Existing Firestore collections and field model are preserved; no Firebase data migration is included.
