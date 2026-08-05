/**
 * Fuel efficiency (Architecture V2 change plan §9.4). Pure and deterministic: from
 * odometer + litres across fill-ups, derive distance covered and km/litre. Uses the
 * fills AFTER the first (baseline) reading to attribute litres to distance. Values
 * are ordinary numbers (odometer/litres, not ledger money).
 */
export interface FuelLog {
  odometer: number | null;
  litres: number | null;
}

export interface FuelEfficiency {
  distance: number; // km covered across the readings
  litresUsed: number; // litres attributed to that distance
  kmPerLitre: number | null; // null when it can't be computed
}

export function fuelEfficiency(logs: FuelLog[]): FuelEfficiency {
  const valid = logs
    .filter((l): l is { odometer: number; litres: number } => typeof l.odometer === "number" && typeof l.litres === "number")
    .sort((a, b) => a.odometer - b.odometer);

  if (valid.length < 2) return { distance: 0, litresUsed: 0, kmPerLitre: null };

  const distance = valid[valid.length - 1]!.odometer - valid[0]!.odometer;
  // Litres from the second fill onward covered the distance from the first reading.
  const litresUsed = valid.slice(1).reduce((s, l) => s + l.litres, 0);
  const kmPerLitre = distance > 0 && litresUsed > 0 ? Math.round((distance / litresUsed) * 100) / 100 : null;

  return { distance, litresUsed, kmPerLitre };
}
