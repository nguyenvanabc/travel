/*
 * Token-free navigation helpers.
 *
 * IMPORTANT:
 * - This module NEVER calls a routing API.
 * - It does not require an API key/token.
 * - The app only builds normal web/app navigation URLs.
 * - Transit time is deliberately NOT guessed or cached as fact.
 */

function coords(place) {
  const lat = Number(place?.lat);
  const lng = Number(place?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function encoded(value) {
  return encodeURIComponent(String(value ?? ""));
}

export function buildPlaceNavigationLinks(place) {
  const c = coords(place);
  const name = place?.name || "";
  const hasCoord = !!c;

  const googleWeb = c
    ? `https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lng}`
    : (place?.googleMapsUrl || (name ? `https://www.google.com/maps/search/?api=1&query=${encoded(name)}` : ""));

  const naverWeb = c
    ? `https://map.naver.com/p?c=15.00,${c.lng},${c.lat},0,0,0,dh`
    : (place?.naverMapsUrl || (name ? `https://map.naver.com/p/search/${encoded(name)}` : ""));

  const naverApp = c
    ? `nmap://place?lat=${c.lat}&lng=${c.lng}&zoom=15${name ? `&name=${encoded(name)}` : ""}`
    : (name ? `nmap://search?query=${encoded(name)}` : "");

  const googleApp = c
    ? `comgooglemaps://?q=${c.lat},${c.lng}`
    : (name ? `comgooglemaps://?q=${encoded(name)}` : "");

  return {
    hasCoord,
    lat: c?.lat,
    lng: c?.lng,
    naverApp,
    googleApp,
    naverWeb,
    googleWeb,
    preferredApp: (/(Android|iPhone|iPad|iPod)/i.test(navigator.userAgent)
      ? (naverApp || googleApp || naverWeb || googleWeb)
      : (naverWeb || googleWeb || naverApp || googleApp))
  };
}

export function buildExternalRouteLinks(fromPoint, toPoint) {
  const a = coords(fromPoint);
  const b = coords(toPoint);
  if (!a || !b) return {};

  const fromName = fromPoint?.place?.name || fromPoint?.name || "Start";
  const toName = toPoint?.place?.name || toPoint?.name || "Destination";

  // Google Maps Directions is a normal web URL, not a Maps API call.
  // It therefore needs no API key/token. The actual transit calculation happens
  // in the map service after the user opens the link.
  const googleTransit = `https://www.google.com/maps/dir/?api=1&origin=${a.lat},${a.lng}&destination=${b.lat},${b.lng}&travelmode=transit`;

  // Naver is provided as a destination map link rather than pretending we know
  // an undocumented directions URL. Users can then choose directions in Naver.
  const naverFrom = `https://map.naver.com/p?c=15.00,${b.lng},${b.lat},0,0,0,dh`;

  return { googleTransit, naverFrom, fromName, toName };
}
