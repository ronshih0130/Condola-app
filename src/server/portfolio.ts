import { maybe, one, tx } from "./db";
import { FlowError } from "./errors";
import { normalizePhone } from "./lease-rules";
import { toMinor } from "./money";
import { assertPerm } from "./perms";
import type { Session } from "./types";
import type { Client } from "pg";

export type SpaceKind = "room" | "whole_unit";
export type ElectricityMethod = "submeter" | "tenant_direct";
export type PortfolioRoomType = "suite" | "shared_bath" | "studio" | "other";

export type PortfolioRow = {
  line: number;
  propertyName: string;
  address: string;
  ownerName: string;
  ownerEmail: string;
  kind: SpaceKind;
  floor: string;
  roomLabel: string | null;
  roomType: PortfolioRoomType | null;
  areaPing: number | null;
  rentMinor: number;
  tenantName: string | null;
  tenantPhone: string | null;
  tenantEmail: string | null;
  leaseStart: string | null;
  leaseEnd: string | null;
  depositMinor: number | null;
  rentDueDay: number | null;
  electricityMethod: ElectricityMethod;
  ratePerKwh: number | null;
  taipowerKwh: number | null;
  taipowerAmountMinor: number | null;
  openingArrearsMinor: number;
  depositCapReason: string | null;
  rateCapReason: string | null;
  notes: string | null;
};

export type PortfolioPlan = {
  rows: PortfolioRow[];
  owners: { name: string; email: string }[];
  properties: {
    name: string;
    address: string;
    ownerEmail: string;
    defaultKind: SpaceKind;
    spaces: PortfolioRow[];
  }[];
};

const CSV_HEADERS = [
  "物件名稱",
  "地址",
  "屋主姓名",
  "屋主 Email",
  "出租型態",
  "戶別／樓層",
  "房號",
  "房型",
  "坪數",
  "月租",
  "租客姓名",
  "租客電話",
  "租客 Email",
  "起租日",
  "到期日",
  "押金",
  "繳租日",
  "電費方式",
  "每度電價",
  "台電帳單度數",
  "台電帳單金額",
  "期初欠款",
  "押金超過上限原因",
  "電價超過上限原因",
  "備註",
] as const;

const ROOM_TYPES = new Set(["suite", "shared_bath", "studio", "other"]);

export function majorField(minor: string | null | undefined, currency: string) {
  if (minor === null || minor === undefined || minor === "") return "";
  const major = Number(minor) / 100;
  if (!Number.isFinite(major)) return "";
  return currency === "TWD" ? String(Math.round(major)) : String(Math.round(major * 100) / 100);
}

export class PortfolioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortfolioError";
  }
}

function blank(value: string | undefined) {
  const text = (value ?? "").trim();
  return text ? text : null;
}

function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.trim() !== "")) rows.push(row);
  }
  return rows;
}

function cell(row: string[], index: Map<string, number>, header: string) {
  const at = index.get(header);
  if (at === undefined) return "";
  return row[at] ?? "";
}

function optionalNumber(raw: string, line: number, label: string) {
  const text = raw.trim();
  if (!text) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) throw new PortfolioError(`第 ${line} 列的${label}不是有效數字`);
  return value;
}

function optionalDate(raw: string, line: number, label: string) {
  const text = raw.trim();
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new PortfolioError(`第 ${line} 列的${label}必須是 YYYY-MM-DD`);
  return text;
}

function optionalMinor(raw: string, line: number, label: string) {
  const major = optionalNumber(raw, line, label);
  if (major === null) return null;
  return toMinor(major);
}

/** Turn the sample portfolio CSV into buildings, 屋主, and spaces. */
export function parsePortfolioCsv(text: string): PortfolioPlan {
  const table = parseCsv(text);
  if (table.length < 2) throw new PortfolioError("CSV 沒有資料列");
  const header = table[0].map((value) => value.trim());
  for (const name of CSV_HEADERS) {
    if (!header.includes(name)) throw new PortfolioError(`缺少欄位：${name}`);
  }
  const index = new Map(header.map((name, at) => [name, at]));
  const rows: PortfolioRow[] = [];
  for (let i = 1; i < table.length; i++) {
    const source = table[i];
    const line = i + 1;
    const propertyName = cell(source, index, "物件名稱").trim();
    const address = cell(source, index, "地址").trim();
    const ownerName = cell(source, index, "屋主姓名").trim();
    const ownerEmail = cell(source, index, "屋主 Email").trim().toLowerCase();
    const rental = cell(source, index, "出租型態").trim();
    const floor = cell(source, index, "戶別／樓層").trim();
    const roomLabel = blank(cell(source, index, "房號"));
    const roomTypeRaw = blank(cell(source, index, "房型"));
    if (!propertyName || !address || !ownerName || !ownerEmail || !floor) {
      throw new PortfolioError(`第 ${line} 列缺少物件、地址、屋主或戶別`);
    }
    if (!ownerEmail.includes("@")) throw new PortfolioError(`第 ${line} 列的屋主 Email 不正確`);
    const kind: SpaceKind | null = rental === "分租" ? "room" : rental === "整層" ? "whole_unit" : null;
    if (!kind) throw new PortfolioError(`第 ${line} 列的出租型態必須是分租或整層`);
    let roomType: PortfolioRoomType | null = null;
    if (kind === "room") {
      if (!roomLabel) throw new PortfolioError(`第 ${line} 列的分租空間需要房號`);
      const mapped = roomTypeRaw === "套房" ? "suite" : roomTypeRaw === "雅房" ? "shared_bath" : roomTypeRaw;
      if (!mapped || !ROOM_TYPES.has(mapped)) throw new PortfolioError(`第 ${line} 列的房型不正確`);
      roomType = mapped as PortfolioRoomType;
    } else if (roomLabel || roomTypeRaw) {
      throw new PortfolioError(`第 ${line} 列的整層空間不能有房號或房型`);
    }
    const rentMajor = optionalNumber(cell(source, index, "月租"), line, "月租");
    if (rentMajor === null) throw new PortfolioError(`第 ${line} 列缺少月租`);
    const electricityRaw = cell(source, index, "電費方式").trim();
    const electricityMethod: ElectricityMethod | null =
      electricityRaw === "分表" ? "submeter" : electricityRaw === "租客自繳" ? "tenant_direct" : null;
    if (!electricityMethod) throw new PortfolioError(`第 ${line} 列的電費方式必須是分表或租客自繳`);
    const due = optionalNumber(cell(source, index, "繳租日"), line, "繳租日");
    if (due !== null && (due < 1 || due > 31 || !Number.isInteger(due))) {
      throw new PortfolioError(`第 ${line} 列的繳租日必須是 1 到 31`);
    }
    rows.push({
      line,
      propertyName,
      address,
      ownerName,
      ownerEmail,
      kind,
      floor,
      roomLabel: kind === "room" ? roomLabel : null,
      roomType,
      areaPing: optionalNumber(cell(source, index, "坪數"), line, "坪數"),
      rentMinor: toMinor(rentMajor),
      tenantName: blank(cell(source, index, "租客姓名")),
      tenantPhone: blank(cell(source, index, "租客電話")),
      tenantEmail: blank(cell(source, index, "租客 Email"))?.toLowerCase() ?? null,
      leaseStart: optionalDate(cell(source, index, "起租日"), line, "起租日"),
      leaseEnd: optionalDate(cell(source, index, "到期日"), line, "到期日"),
      depositMinor: optionalMinor(cell(source, index, "押金"), line, "押金"),
      rentDueDay: due,
      electricityMethod,
      ratePerKwh: optionalNumber(cell(source, index, "每度電價"), line, "每度電價"),
      taipowerKwh: optionalNumber(cell(source, index, "台電帳單度數"), line, "台電帳單度數"),
      taipowerAmountMinor: optionalMinor(cell(source, index, "台電帳單金額"), line, "台電帳單金額"),
      openingArrearsMinor: optionalMinor(cell(source, index, "期初欠款"), line, "期初欠款") ?? 0,
      depositCapReason: blank(cell(source, index, "押金超過上限原因")),
      rateCapReason: blank(cell(source, index, "電價超過上限原因")),
      notes: blank(cell(source, index, "備註")),
    });
  }

  const owners = new Map<string, string>();
  const properties = new Map<string, PortfolioPlan["properties"][number] & { keys: Set<string> }>();
  for (const row of rows) {
    const knownOwner = owners.get(row.ownerEmail);
    if (knownOwner && knownOwner !== row.ownerName) {
      throw new PortfolioError(`屋主 Email ${row.ownerEmail} 對到兩個姓名`);
    }
    owners.set(row.ownerEmail, row.ownerName);
    const key = row.propertyName;
    const existing = properties.get(key);
    const spaceKey = row.kind === "room" ? `${row.floor}\n${row.roomLabel}` : row.floor;
    if (!existing) {
      properties.set(key, {
        name: row.propertyName,
        address: row.address,
        ownerEmail: row.ownerEmail,
        defaultKind: row.kind,
        spaces: [row],
        keys: new Set([spaceKey]),
      });
      continue;
    }
    if (existing.address !== row.address) throw new PortfolioError(`物件 ${row.propertyName} 的地址不一致`);
    if (existing.ownerEmail !== row.ownerEmail) throw new PortfolioError(`物件 ${row.propertyName} 的屋主不一致`);
    if (existing.keys.has(spaceKey)) throw new PortfolioError(`第 ${row.line} 列和同一物件的空間重複`);
    existing.keys.add(spaceKey);
    existing.spaces.push(row);
  }
  return {
    rows,
    owners: [...owners.entries()].map(([email, name]) => ({ email, name })),
    properties: [...properties.values()].map((property) => ({
      name: property.name,
      address: property.address,
      ownerEmail: property.ownerEmail,
      defaultKind: property.defaultKind,
      spaces: property.spaces,
    })),
  };
}

function cleanEmail(email: string) {
  const value = email.trim().toLowerCase();
  if (!value) return null;
  if (!value.includes("@")) throw new FlowError("errors.email");
  return value;
}

function cleanPhone(phone: string) {
  if (!phone.trim()) return null;
  const value = normalizePhone(phone);
  if (!value) throw new FlowError("errors.phone");
  return value;
}

function cleanKind(value: string): SpaceKind {
  if (value === "room" || value === "whole_unit") return value;
  throw new FlowError("errors.required");
}

function cleanElectricity(value: string): ElectricityMethod {
  if (value === "submeter" || value === "tenant_direct") return value;
  throw new FlowError("errors.required");
}

function cleanRoomType(value: string): PortfolioRoomType {
  if (ROOM_TYPES.has(value)) return value as PortfolioRoomType;
  throw new FlowError("errors.required");
}

async function ensureOwner(client: Client, orgId: string, propertyId: string, ownerContactId: string) {
  const owner = await maybe<{ id: string }>(
    client,
    `SELECT id::text FROM contacts
      WHERE id = $1 AND org_id = $2 AND is_owner AND archived_at IS NULL`,
    [ownerContactId, orgId],
  );
  if (!owner) throw new FlowError("errors.required");
  const linked = await maybe<{ id: string }>(
    client,
    `SELECT id::text FROM property_owners WHERE property_id = $1 AND owner_contact_id = $2`,
    [propertyId, ownerContactId],
  );
  if (linked) return;
  await client.query(
    `INSERT INTO property_owners (org_id, property_id, owner_contact_id, is_primary)
     VALUES ($1, $2, $3, NOT EXISTS (SELECT 1 FROM property_owners WHERE property_id = $2 AND is_primary))`,
    [orgId, propertyId, ownerContactId],
  );
}

async function syncOwnerProperties(client: Client, orgId: string, ownerId: string, propertyIds: string[]) {
  const unique = [...new Set(propertyIds.filter(Boolean))];
  for (const propertyId of unique) {
    const property = await maybe<{ id: string }>(
      client,
      `SELECT id::text FROM properties WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
      [propertyId, orgId],
    );
    if (!property) throw new FlowError("errors.notFound");
    await ensureOwner(client, orgId, propertyId, ownerId);
  }
  await client.query(
    `DELETE FROM property_owners
      WHERE org_id = $1 AND owner_contact_id = $2
        AND NOT (property_id = ANY($3::uuid[]))`,
    [orgId, ownerId, unique],
  );
}

export async function createOwner(
  session: Session,
  input: { name: string; email: string; phone: string; propertyIds: string[] },
) {
  assertPerm(session, "props.edit");
  const email = cleanEmail(input.email);
  if (!input.name.trim() || !email) throw new FlowError("errors.required");
  const phone = cleanPhone(input.phone);
  return tx(session.userId, async (client) => {
    const taken = await maybe<{ id: string }>(
      client,
      `SELECT id::text FROM contacts WHERE org_id = $1 AND email = $2 AND archived_at IS NULL`,
      [session.orgId, email],
    );
    if (taken) throw new FlowError("errors.emailTaken");
    const contact = await one<{ id: string }>(
      client,
      `INSERT INTO contacts (org_id, is_owner, display_name, email, phone_e164, locale)
       VALUES ($1, true, $2, $3, $4, $5) RETURNING id::text`,
      [session.orgId, input.name.trim(), email, phone, session.locale],
    );
    await syncOwnerProperties(client, session.orgId, contact.id, input.propertyIds);
    return contact.id;
  });
}

export async function updateOwner(
  session: Session,
  ownerId: string,
  input: { name: string; email: string; phone: string; propertyIds: string[] },
) {
  assertPerm(session, "props.edit");
  const email = cleanEmail(input.email);
  if (!input.name.trim() || !email) throw new FlowError("errors.required");
  const phone = cleanPhone(input.phone);
  await tx(session.userId, async (client) => {
    const owner = await maybe<{ id: string }>(
      client,
      `SELECT id::text FROM contacts WHERE id = $1 AND org_id = $2 AND is_owner AND archived_at IS NULL`,
      [ownerId, session.orgId],
    );
    if (!owner) throw new FlowError("errors.notFound");
    const taken = await maybe<{ id: string }>(
      client,
      `SELECT id::text FROM contacts
        WHERE org_id = $1 AND email = $2 AND id <> $3 AND archived_at IS NULL`,
      [session.orgId, email, ownerId],
    );
    if (taken) throw new FlowError("errors.emailTaken");
    await client.query(
      `UPDATE contacts
          SET display_name = $3, email = $4, phone_e164 = $5, updated_at = now()
        WHERE id = $1 AND org_id = $2`,
      [ownerId, session.orgId, input.name.trim(), email, phone],
    );
    await syncOwnerProperties(client, session.orgId, ownerId, input.propertyIds);
  });
}

export async function updateProperty(
  session: Session,
  propertyId: string,
  input: { name: string; city: string; district: string; street: string; ownerContactId: string },
) {
  assertPerm(session, "props.edit");
  if (!input.name.trim() || !input.street.trim() || !input.ownerContactId) throw new FlowError("errors.required");
  await tx(session.userId, async (client) => {
    const property = await maybe<{ country_code: string }>(
      client,
      `SELECT country_code FROM properties WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
      [propertyId, session.orgId],
    );
    if (!property) throw new FlowError("errors.notFound");
    const country = property.country_code.trim();
    const city = input.city.trim();
    const district = input.district.trim();
    const street = input.street.trim();
    const display = country === "TW" ? `${city}${district}${street}` : [street, city, district].filter(Boolean).join(", ");
    await client.query(
      `UPDATE properties
          SET name = $3,
              address = address || $4::jsonb,
              address_display = $5,
              updated_at = now()
        WHERE id = $1 AND org_id = $2`,
      [propertyId, session.orgId, input.name.trim(), JSON.stringify({ country, city, district, street }), display],
    );
    await client.query(`UPDATE property_owners SET is_primary = false WHERE property_id = $1 AND owner_contact_id <> $2`, [
      propertyId,
      input.ownerContactId,
    ]);
    await ensureOwner(client, session.orgId, propertyId, input.ownerContactId);
    await client.query(
      `UPDATE property_owners SET is_primary = true WHERE property_id = $1 AND owner_contact_id = $2`,
      [propertyId, input.ownerContactId],
    );
  });
}

export type SpaceInput = {
  propertyId: string;
  ownerContactId: string;
  kind: string;
  floor: string;
  roomLabel: string;
  roomType: string;
  area: number | null;
  rentMajor: number;
  electricityMethod: string;
  ratePerKwh: number | null;
  rateCapReason: string;
  taipowerKwh: number | null;
  taipowerAmountMajor: number | null;
  notes: string;
};

type SpaceWrite = {
  kind: SpaceKind;
  floor: string;
  roomLabel: string | null;
  roomType: PortfolioRoomType | null;
  area: number | null;
  rentMinor: number;
  electricityMethod: ElectricityMethod;
  ratePerKwh: number | null;
  rateCapReason: string | null;
  taipowerKwh: number | null;
  taipowerAmountMinor: number | null;
  notes: string | null;
};

function spaceWrite(input: SpaceInput): SpaceWrite {
  const kind = cleanKind(input.kind);
  const floor = input.floor.trim();
  if (!input.propertyId || !input.ownerContactId || !floor) throw new FlowError("errors.required");
  if (!Number.isFinite(input.rentMajor) || input.rentMajor < 0) throw new FlowError("errors.amount");
  const roomLabel = input.roomLabel.trim();
  const roomType = kind === "room" ? cleanRoomType(input.roomType) : null;
  if (kind === "room" && !roomLabel) throw new FlowError("errors.required");
  return {
    kind,
    floor,
    roomLabel: kind === "room" ? roomLabel : null,
    roomType,
    area: input.area !== null && Number.isFinite(input.area) ? input.area : null,
    rentMinor: toMinor(input.rentMajor),
    electricityMethod: cleanElectricity(input.electricityMethod),
    ratePerKwh: input.ratePerKwh !== null && Number.isFinite(input.ratePerKwh) ? input.ratePerKwh : null,
    rateCapReason: input.rateCapReason.trim() || null,
    taipowerKwh: input.taipowerKwh !== null && Number.isFinite(input.taipowerKwh) ? input.taipowerKwh : null,
    taipowerAmountMinor:
      input.taipowerAmountMajor !== null && Number.isFinite(input.taipowerAmountMajor)
        ? toMinor(input.taipowerAmountMajor)
        : null,
    notes: input.notes.trim() || null,
  };
}

async function propertyCountry(client: Client, orgId: string, propertyId: string) {
  const property = await maybe<{ country_code: string }>(
    client,
    `SELECT country_code FROM properties WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
    [propertyId, orgId],
  );
  if (!property) throw new FlowError("errors.notFound");
  return property.country_code.trim();
}

async function unitForFloor(client: Client, orgId: string, propertyId: string, floor: string, kind: SpaceKind) {
  const areaUnit = (await propertyCountry(client, orgId, propertyId)) === "TW" ? "ping" : "sqft";
  const existing = await maybe<{ id: string; rental_mode: string }>(
    client,
    `SELECT id::text, rental_mode::text FROM units
      WHERE property_id = $1 AND org_id = $2 AND label = $3 AND archived_at IS NULL`,
    [propertyId, orgId, floor],
  );
  if (!existing) {
    const created = await one<{ id: string }>(
      client,
      `INSERT INTO units (org_id, property_id, label, floor, rental_mode, area_unit)
       VALUES ($1, $2, $3, $3, $4, $5) RETURNING id::text`,
      [orgId, propertyId, floor, kind === "room" ? "by_room" : "whole_unit", areaUnit],
    );
    return { id: created.id, areaUnit, created: true };
  }
  if (kind === "room" && existing.rental_mode === "whole_unit") throw new FlowError("errors.wholeUnit");
  if (kind === "whole_unit" && existing.rental_mode !== "whole_unit") throw new FlowError("errors.generic");
  return { id: existing.id, areaUnit, created: false };
}

export async function createSpace(session: Session, input: SpaceInput) {
  assertPerm(session, "props.edit");
  const write = spaceWrite(input);
  return tx(session.userId, async (client) => {
    await ensureOwner(client, session.orgId, input.propertyId, input.ownerContactId);
    const unit = await unitForFloor(client, session.orgId, input.propertyId, write.floor, write.kind);
    if (write.kind === "whole_unit") {
      if (!unit.created) throw new FlowError("errors.generic");
      await client.query(
        `UPDATE units
            SET area_value = $2, area_unit = $3, base_rent_minor = $4,
                electricity_method = $5, rate_per_kwh = $6, rate_cap_reason = $7,
                taipower_kwh = $8, taipower_amount_minor = $9, notes = $10, updated_at = now()
          WHERE id = $1 AND org_id = $11`,
        [
          unit.id,
          write.area,
          unit.areaUnit,
          write.rentMinor,
          write.electricityMethod,
          write.ratePerKwh,
          write.rateCapReason,
          write.taipowerKwh,
          write.taipowerAmountMinor,
          write.notes,
          session.orgId,
        ],
      );
      return { kind: "whole_unit" as const, id: unit.id };
    }
    const clash = await maybe<{ id: string }>(
      client,
      `SELECT id::text FROM rooms WHERE unit_id = $1 AND label = $2 AND archived_at IS NULL`,
      [unit.id, write.roomLabel],
    );
    if (clash) throw new FlowError("errors.generic");
    const room = await one<{ id: string }>(
      client,
      `INSERT INTO rooms (
         org_id, unit_id, label, room_type, area_value, area_unit, base_rent_minor,
         electricity_method, rate_per_kwh, rate_cap_reason, taipower_kwh, taipower_amount_minor, notes
       ) VALUES ($1,$2,$3,$4::room_type,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id::text`,
      [
        session.orgId,
        unit.id,
        write.roomLabel,
        write.roomType,
        write.area,
        unit.areaUnit,
        write.rentMinor,
        write.electricityMethod,
        write.ratePerKwh,
        write.rateCapReason,
        write.taipowerKwh,
        write.taipowerAmountMinor,
        write.notes,
      ],
    );
    return { kind: "room" as const, id: room.id };
  });
}

export async function updateSpace(session: Session, kind: SpaceKind, spaceId: string, input: SpaceInput) {
  assertPerm(session, "props.edit");
  const write = spaceWrite({ ...input, kind });
  await tx(session.userId, async (client) => {
    if (kind === "whole_unit") {
      const unit = await maybe<{ id: string; property_id: string }>(
        client,
        `SELECT id::text, property_id::text FROM units
          WHERE id = $1 AND org_id = $2 AND rental_mode = 'whole_unit' AND archived_at IS NULL`,
        [spaceId, session.orgId],
      );
      if (!unit) throw new FlowError("errors.notFound");
      await ensureOwner(client, session.orgId, unit.property_id, input.ownerContactId);
      const country = await propertyCountry(client, session.orgId, unit.property_id);
      await client.query(
        `UPDATE units
            SET label = $3, floor = $3, area_value = $4, area_unit = $5, base_rent_minor = $6,
                electricity_method = $7, rate_per_kwh = $8, rate_cap_reason = $9,
                taipower_kwh = $10, taipower_amount_minor = $11, notes = $12, updated_at = now()
          WHERE id = $1 AND org_id = $2`,
        [
          spaceId,
          session.orgId,
          write.floor,
          write.area,
          country === "TW" ? "ping" : "sqft",
          write.rentMinor,
          write.electricityMethod,
          write.ratePerKwh,
          write.rateCapReason,
          write.taipowerKwh,
          write.taipowerAmountMinor,
          write.notes,
        ],
      );
      return;
    }
    const room = await maybe<{ id: string; unit_id: string; property_id: string }>(
      client,
      `SELECT r.id::text, r.unit_id::text, u.property_id::text
         FROM rooms r JOIN units u ON u.id = r.unit_id
        WHERE r.id = $1 AND r.org_id = $2 AND r.archived_at IS NULL`,
      [spaceId, session.orgId],
    );
    if (!room) throw new FlowError("errors.notFound");
    await ensureOwner(client, session.orgId, room.property_id, input.ownerContactId);
    const unit = await unitForFloor(client, session.orgId, room.property_id, write.floor, "room");
    const clash = await maybe<{ id: string }>(
      client,
      `SELECT id::text FROM rooms
        WHERE unit_id = $1 AND label = $2 AND id <> $3 AND archived_at IS NULL`,
      [unit.id, write.roomLabel, spaceId],
    );
    if (clash) throw new FlowError("errors.generic");
    await client.query(
      `UPDATE rooms
          SET unit_id = $3, label = $4, room_type = $5::room_type, area_value = $6, area_unit = $7,
              base_rent_minor = $8, electricity_method = $9, rate_per_kwh = $10, rate_cap_reason = $11,
              taipower_kwh = $12, taipower_amount_minor = $13, notes = $14, updated_at = now()
        WHERE id = $1 AND org_id = $2`,
      [
        spaceId,
        session.orgId,
        unit.id,
        write.roomLabel,
        write.roomType,
        write.area,
        unit.areaUnit,
        write.rentMinor,
        write.electricityMethod,
        write.ratePerKwh,
        write.rateCapReason,
        write.taipowerKwh,
        write.taipowerAmountMinor,
        write.notes,
      ],
    );
  });
}

async function upsertTerms(
  client: Client,
  orgId: string,
  target: { unitId: string | null; roomId: string | null },
  row: PortfolioRow,
) {
  const existing = await maybe<{ id: string }>(
    client,
    target.roomId
      ? `SELECT id::text FROM listing_terms WHERE room_id = $1`
      : `SELECT id::text FROM listing_terms WHERE unit_id = $1`,
    [target.roomId ?? target.unitId],
  );
  const values = [
    row.tenantName,
    row.tenantPhone,
    row.tenantEmail,
    row.leaseStart,
    row.leaseEnd,
    row.depositMinor,
    row.rentDueDay,
    row.depositCapReason,
    row.openingArrearsMinor,
  ];
  if (existing) {
    await client.query(
      `UPDATE listing_terms
          SET tenant_name = $2, tenant_phone = $3, tenant_email = $4, lease_start = $5, lease_end = $6,
              deposit_minor = $7, rent_due_day = $8, deposit_cap_reason = $9, opening_arrears_minor = $10,
              updated_at = now()
        WHERE id = $1 AND org_id = $11`,
      [existing.id, ...values, orgId],
    );
    return;
  }
  await client.query(
    `INSERT INTO listing_terms (
       org_id, unit_id, room_id, tenant_name, tenant_phone, tenant_email, lease_start, lease_end,
       deposit_minor, rent_due_day, deposit_cap_reason, opening_arrears_minor
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [orgId, target.unitId, target.roomId, ...values],
  );
}

async function applySpaceColumns(
  client: Client,
  table: "units" | "rooms",
  id: string,
  orgId: string,
  areaUnit: string,
  row: PortfolioRow,
) {
  await client.query(
    `UPDATE ${table}
        SET area_value = $2, area_unit = $3, base_rent_minor = $4,
            electricity_method = $5, rate_per_kwh = $6, rate_cap_reason = $7,
            taipower_kwh = $8, taipower_amount_minor = $9, notes = $10, updated_at = now()
      WHERE id = $1 AND org_id = $11`,
    [
      id,
      row.areaPing,
      areaUnit,
      row.rentMinor,
      row.electricityMethod,
      row.ratePerKwh,
      row.rateCapReason,
      row.taipowerKwh,
      row.taipowerAmountMinor,
      row.notes,
      orgId,
    ],
  );
}

/** Load a portfolio CSV into the caller's firm. Reuses a building or 屋主 with the same name or email. */
export async function seedPortfolio(session: Session, csv: string) {
  assertPerm(session, "props.edit");
  const plan = parsePortfolioCsv(csv);
  await tx(session.userId, async (client) => {
    const jurisdiction = await one<{ id: string }>(client, `SELECT id FROM jurisdictions WHERE code = 'TW'`);
    const ownerIds = new Map<string, string>();
    for (const owner of plan.owners) {
      const existing = await maybe<{ id: string }>(
        client,
        `SELECT id::text FROM contacts
          WHERE org_id = $1 AND is_owner AND lower(email::text) = $2 AND archived_at IS NULL`,
        [session.orgId, owner.email],
      );
      if (existing) {
        await client.query(`UPDATE contacts SET display_name = $2, updated_at = now() WHERE id = $1`, [
          existing.id,
          owner.name,
        ]);
        ownerIds.set(owner.email, existing.id);
        continue;
      }
      const created = await one<{ id: string }>(
        client,
        `INSERT INTO contacts (org_id, is_owner, display_name, email, locale)
         VALUES ($1, true, $2, $3, 'zh-TW') RETURNING id::text`,
        [session.orgId, owner.name, owner.email],
      );
      ownerIds.set(owner.email, created.id);
    }
    for (const property of plan.properties) {
      const ownerId = ownerIds.get(property.ownerEmail);
      if (!ownerId) throw new PortfolioError(`找不到屋主 ${property.ownerEmail}`);
      let propertyId =
        (
          await maybe<{ id: string }>(
            client,
            `SELECT id::text FROM properties WHERE org_id = $1 AND name = $2 AND archived_at IS NULL`,
            [session.orgId, property.name],
          )
        )?.id ?? "";
      if (!propertyId) {
        const created = await one<{ id: string }>(
          client,
          `INSERT INTO properties (
             org_id, name, address, address_display, country_code, jurisdiction_id, currency, timezone, default_rental_mode
           ) VALUES ($1,$2,$3::jsonb,$4,'TW',$5,'TWD','Asia/Taipei',$6) RETURNING id::text`,
          [
            session.orgId,
            property.name,
            JSON.stringify({ country: "TW", line: property.address }),
            property.address,
            jurisdiction.id,
            property.defaultKind === "room" ? "by_room" : "whole_unit",
          ],
        );
        propertyId = created.id;
      }
      await ensureOwner(client, session.orgId, propertyId, ownerId);
      await client.query(
        `UPDATE property_owners SET is_primary = (owner_contact_id = $2) WHERE property_id = $1`,
        [propertyId, ownerId],
      );
      for (const space of property.spaces) {
        if (space.kind === "whole_unit") {
          const unit = await unitForFloor(client, session.orgId, propertyId, space.floor, "whole_unit");
          await applySpaceColumns(client, "units", unit.id, session.orgId, "ping", space);
          await upsertTerms(client, session.orgId, { unitId: unit.id, roomId: null }, space);
          continue;
        }
        const unit = await unitForFloor(client, session.orgId, propertyId, space.floor, "room");
        const existingRoom = await maybe<{ id: string }>(
          client,
          `SELECT id::text FROM rooms WHERE unit_id = $1 AND label = $2 AND archived_at IS NULL`,
          [unit.id, space.roomLabel],
        );
        const roomId = existingRoom
          ? existingRoom.id
          : (
              await one<{ id: string }>(
                client,
                `INSERT INTO rooms (org_id, unit_id, label, room_type, area_unit)
                 VALUES ($1,$2,$3,$4::room_type,'ping') RETURNING id::text`,
                [session.orgId, unit.id, space.roomLabel, space.roomType],
              )
            ).id;
        await applySpaceColumns(client, "rooms", roomId, session.orgId, "ping", space);
        if (space.roomType) {
          await client.query(`UPDATE rooms SET room_type = $2::room_type WHERE id = $1`, [roomId, space.roomType]);
        }
        await upsertTerms(client, session.orgId, { unitId: null, roomId }, space);
      }
    }
  });
  return plan;
}
