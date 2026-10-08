/* Map navigation links only.
 *
 * This module does not call a routing API and contains no routing credentials.
 * It only creates normal links/deep-links for opening a place in a map app.
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
