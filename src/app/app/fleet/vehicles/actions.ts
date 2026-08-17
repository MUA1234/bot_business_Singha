"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";
import { parseMoneyInput } from "@/lib/money";

async function requireFleet() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "fleet") throw new Error("Not allowed");
  return p;
}

export async function createVehicle(formData: FormData): Promise<void> {
  const p = await requireFleet();
  const registration_no = String(formData.get("registration_no") ?? "").trim();
  if (!registration_no) return;
  const make = String(formData.get("make") ?? "").trim() || null;
  const model = String(formData.get("model") ?? "").trim() || null;
  const yearRaw = String(formData.get("year") ?? "").trim();
  const year = yearRaw ? Number(yearRaw) || null : null;

  const { data, error } = await supabaseWriteClient()
    .from("vehicles")
    .insert({ company_id: p.companyId, registration_no, make, model, year, status: "active" })
    .select("id")
    .maybeSingle();
  if (error) return; // e.g. duplicate registration or table missing
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "vehicle.created", entityType: "vehicle", entityId: data?.id ?? null, payload: { registration_no } });
  revalidatePath("/app/fleet/vehicles");
  revalidatePath("/app/fleet");
}

/** Confirm a vehicle belongs to the caller's company. */
async function vehicleInCompany(id: string, companyId: string) {
  const { data } = await supabaseWriteClient().from("vehicles").select("id").eq("id", id).eq("company_id", companyId).maybeSingle();
  return data ?? null;
}

export async function addVehicleDocument(formData: FormData): Promise<void> {
  const p = await requireFleet();
  const vid = String(formData.get("vehicle_id") ?? "");
  if (!(await vehicleInCompany(vid, p.companyId))) return;
  const doc_type = String(formData.get("doc_type") ?? "other");
  const reference = String(formData.get("reference") ?? "").trim() || null;
  const expiry_date = String(formData.get("expiry_date") ?? "").trim() || null;
  if (!["insurance", "registration", "emission", "permit", "other"].includes(doc_type)) return;
  await supabaseWriteClient().from("vehicle_documents").insert({ company_id: p.companyId, vehicle_id: vid, doc_type, reference, expiry_date });
  revalidatePath(`/app/fleet/vehicles/${vid}`);
  revalidatePath("/app/fleet");
}

export async function addMaintenance(formData: FormData): Promise<void> {
  const p = await requireFleet();
  const vid = String(formData.get("vehicle_id") ?? "");
  if (!(await vehicleInCompany(vid, p.companyId))) return;
  const kind = String(formData.get("kind") ?? "").trim() || null;
  const description = String(formData.get("description") ?? "").trim() || null;
  // Decimal money, nullable: empty/zero/unparseable → null (absent), exactly as before — no JS float.
  const costMoney = parseMoneyInput(formData.get("cost"), "LKR");
  const cost = costMoney && !costMoney.isZero() ? costMoney.toString() : null;
  const service_date = String(formData.get("service_date") ?? "").trim() || null;
  const next_service_date = String(formData.get("next_service_date") ?? "").trim() || null;
  await supabaseWriteClient().from("maintenance_records").insert({ company_id: p.companyId, vehicle_id: vid, kind, description, cost, service_date, next_service_date });
  revalidatePath(`/app/fleet/vehicles/${vid}`);
  revalidatePath("/app/fleet");
}

export async function addFuelLog(formData: FormData): Promise<void> {
  const p = await requireFleet();
  const vid = String(formData.get("vehicle_id") ?? "");
  if (!(await vehicleInCompany(vid, p.companyId))) return;
  const litres = Number(formData.get("litres") ?? 0) || null;
  // Decimal money, nullable: empty/zero/unparseable → null (absent), exactly as before — no JS float.
  const costMoney = parseMoneyInput(formData.get("cost"), "LKR");
  const cost = costMoney && !costMoney.isZero() ? costMoney.toString() : null;
  const odometer = Number(formData.get("odometer") ?? 0) || null;
  await supabaseWriteClient().from("fuel_logs").insert({ company_id: p.companyId, vehicle_id: vid, litres, cost, odometer });
  revalidatePath(`/app/fleet/vehicles/${vid}`);
}

export async function addTrip(formData: FormData): Promise<void> {
  const p = await requireFleet();
  const vid = String(formData.get("vehicle_id") ?? "");
  if (!(await vehicleInCompany(vid, p.companyId))) return;
  const driver_id = String(formData.get("driver_id") ?? "").trim() || null;
  const purpose = String(formData.get("purpose") ?? "").trim() || null;
  const start_odometer = Number(formData.get("start_odometer") ?? 0) || null;
  const end_odometer = Number(formData.get("end_odometer") ?? 0) || null;
  await supabaseWriteClient().from("trips").insert({ company_id: p.companyId, vehicle_id: vid, driver_id, purpose, start_odometer, end_odometer, started_at: new Date().toISOString() });
  revalidatePath(`/app/fleet/vehicles/${vid}`);
}

export async function createDriver(formData: FormData): Promise<void> {
  const p = await requireFleet();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const licence_number = String(formData.get("licence_number") ?? "").trim() || null;
  const licence_expiry = String(formData.get("licence_expiry") ?? "").trim() || null;
  const phone = String(formData.get("phone") ?? "").trim() || null;
  await supabaseWriteClient().from("drivers").insert({ company_id: p.companyId, name, licence_number, licence_expiry, phone, status: "active" });
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "driver.created", entityType: "driver", entityId: name });
  revalidatePath("/app/fleet/drivers");
}
