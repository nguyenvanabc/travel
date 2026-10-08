# Seoul Trip Companion 2026 — refactored build

## Deploy
Upload the contents of this folder to the GitHub Pages repository. Keep the directory structure:

- `index.html`
- `css/styles.css`
- `js/app.js`
- `js/services/map-navigation.js`

## Map and navigation decision
The app does not include a transit-routing engine or call Naver/Kakao/Google routing APIs.

The app:
- keeps the existing Leaflet day map;
- shows the ordered places for each day;
- shows straight-line distance only as a visual estimate;
- lets the user open individual places in a normal map app/service when navigation is needed;
- does not display or guess transit duration.

There is therefore no transit API key/token, routing SDK, or transit-routing module in this build.


## Main refactor
- CSS moved out of `index.html`.
- Application JavaScript moved out of `index.html`.
- Map-opening helpers isolated in `js/services/map-navigation.js`.
- Mobile navigation reduced to five primary destinations.
- Mobile-first touch targets and bottom-sheet modal layout.
- Day summary and route segment presentation.
- Explicit `Asia/Seoul` trip clock for Today/countdown/alerts.
- Only the active screen is re-rendered instead of rebuilding all six screens on every state update.
- Quick navigation from More for Places/DSP/Itinerary/Expenses.
- Offline/online visual state indicator.
- Existing Firestore collections and field model are preserved; no Firebase data migration is included.
