/** Get current device GPS position */
export function getCurrentPosition(): Promise<{ lat: number; lng: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation not available"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });
}

interface NominatimResult {
  display_name: string;
  address: {
    road?: string;
    house_number?: string;
    suburb?: string;
    city?: string;
    town?: string;
    state?: string;
    postcode?: string;
  };
}

/** Reverse geocode lat/lng to a street address using Nominatim (OSM) */
export async function reverseGeocode(lat: number, lng: number): Promise<{ address: string; street: string; suburb: string }> {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`;
  const res = await fetch(url, {
    headers: { "User-Agent": "FieldApp/1.0" },
  });
  if (!res.ok) throw new Error("Reverse geocode failed");
  const data: NominatimResult = await res.json();
  const a = data.address;
  const street = [a.house_number, a.road].filter(Boolean).join(" ");
  const suburb = a.suburb || a.town || a.city || "";
  const address = [street, suburb, a.state, a.postcode].filter(Boolean).join(", ");
  return { address, street, suburb };
}

interface ForwardResult {
  lat: string;
  lon: string;
  display_name: string;
}

/** Forward geocode an address to GPS coordinates using Nominatim */
export async function forwardGeocode(address: string): Promise<{ lat: number; lng: number; displayName: string } | null> {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=au`;
  const res = await fetch(url, {
    headers: { "User-Agent": "FieldApp/1.0" },
  });
  if (!res.ok) return null;
  const results: ForwardResult[] = await res.json();
  if (results.length === 0) return null;
  return {
    lat: parseFloat(results[0].lat),
    lng: parseFloat(results[0].lon),
    displayName: results[0].display_name,
  };
}
