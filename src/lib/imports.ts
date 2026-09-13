import { parse as parseCsv } from "csv-parse/sync";
import { readSheet } from "read-excel-file/node";
import type { ImportRowStatus } from "@prisma/client";
import {
  CANONICAL_FIELDS,
  type CanonicalField,
  type ColumnMapping,
} from "@/lib/import-fields";
import { normalizeUSPhone } from "@/lib/phone";

export { CANONICAL_FIELDS } from "@/lib/import-fields";
export type { CanonicalField, ColumnMapping } from "@/lib/import-fields";
export type SourceRow = Record<string, string>;

export interface AnalyzedRow {
  rowNumber: number;
  status: ImportRowStatus;
  normalizedPhone: string | null;
  mappedData: Record<CanonicalField, string>;
  rawData: SourceRow;
  errorMessage: string | null;
}

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

const aliases: Record<CanonicalField, string[]> = {
  phone: [
    "phone",
    "phone_number",
    "mobile",
    "cell",
    "telephone",
    "owner_phone",
  ],
  first_name: ["first_name", "firstname", "first"],
  last_name: ["last_name", "lastname", "last"],
  owner_name: ["owner_name", "owner", "name", "mail_name"],
  property_address: [
    "property_address",
    "address",
    "site_address",
    "situs_address",
  ],
  street_name: ["street_name", "street", "property_street"],
  city: ["city", "property_city", "situs_city"],
  state: ["state", "property_state", "situs_state"],
  postal_code: ["postal_code", "zip", "zipcode", "zip_code", "property_zip"],
  county: ["county", "property_county"],
  acreage: ["acreage", "acres", "lot_acres"],
  property_type: ["property_type", "type", "land_use"],
  source: ["source", "list_source"],
  external_id: ["external_id", "record_id", "parcel_id", "apn"],
};

export function suggestColumnMapping(headers: string[]): ColumnMapping {
  const normalized = new Map(
    headers.map((header) => [normalizeHeader(header), header]),
  );
  const mapping: ColumnMapping = {};
  for (const field of CANONICAL_FIELDS) {
    const match = aliases[field]
      .map((alias) => normalized.get(alias))
      .find(Boolean);
    if (match) mapping[field] = match;
  }
  return mapping;
}

export async function parseImportFile(
  fileName: string,
  bytes: Buffer,
): Promise<SourceRow[]> {
  const extension = fileName.toLowerCase().split(".").pop();
  if (extension === "csv") {
    const records = parseCsv(bytes, {
      columns: true,
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    }) as Record<string, unknown>[];
    return records.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          value == null ? "" : String(value),
        ]),
      ),
    );
  }
  if (extension === "xlsx") {
    const matrix = await readSheet(bytes);
    const [headerRow, ...dataRows] = matrix;
    if (!headerRow) return [];
    const headers = headerRow.map((value) => String(value ?? "").trim());
    return dataRows
      .filter((row) =>
        row.some((value) => value != null && String(value).trim() !== ""),
      )
      .map((row) =>
        Object.fromEntries(
          headers.map((header, index) => [
            header,
            String(row[index] ?? "").trim(),
          ]),
        ),
      );
  }
  throw new Error("Only CSV and XLSX files are supported");
}

export function mapRow(
  row: SourceRow,
  mapping: ColumnMapping,
): Record<CanonicalField, string> {
  return Object.fromEntries(
    CANONICAL_FIELDS.map((field) => [
      field,
      mapping[field] ? (row[mapping[field]!] ?? "").trim() : "",
    ]),
  ) as Record<CanonicalField, string>;
}

export function analyzeImportRows(
  rows: SourceRow[],
  mapping: ColumnMapping,
  suppressedPhones: ReadonlySet<string>,
): AnalyzedRow[] {
  const seenPhoneProperty = new Set<string>();
  return rows.map((rawData, index) => {
    const mappedData = mapRow(rawData, mapping);
    if (!mappedData.phone) {
      return {
        rowNumber: index + 2,
        status: "MISSING_REQUIRED",
        normalizedPhone: null,
        mappedData,
        rawData,
        errorMessage: "Phone is required",
      };
    }
    const normalizedPhone = normalizeUSPhone(mappedData.phone);
    if (!normalizedPhone) {
      return {
        rowNumber: index + 2,
        status: "INVALID_PHONE",
        normalizedPhone: null,
        mappedData,
        rawData,
        errorMessage: "Invalid US phone number",
      };
    }
    const propertyKey = [
      mappedData.external_id,
      mappedData.property_address,
      mappedData.city,
      mappedData.state,
    ]
      .map((value) => value.trim().toLowerCase())
      .join("|");
    const identity = `${normalizedPhone}|${propertyKey}`;
    if (seenPhoneProperty.has(identity)) {
      return {
        rowNumber: index + 2,
        status: "DUPLICATE_PHONE_PROPERTY",
        normalizedPhone,
        mappedData,
        rawData,
        errorMessage: "Duplicate phone/property in this import",
      };
    }
    seenPhoneProperty.add(identity);
    if (suppressedPhones.has(normalizedPhone)) {
      return {
        rowNumber: index + 2,
        status: "SUPPRESSED",
        normalizedPhone,
        mappedData,
        rawData,
        errorMessage: "Phone is globally suppressed",
      };
    }
    return {
      rowNumber: index + 2,
      status: "ELIGIBLE",
      normalizedPhone,
      mappedData,
      rawData,
      errorMessage: null,
    };
  });
}

export function summarizeImport(rows: AnalyzedRow[]) {
  const count = (statuses: ImportRowStatus[]) =>
    rows.filter((row) => statuses.includes(row.status)).length;
  return {
    uploaded: rows.length,
    eligible: count(["ELIGIBLE"]),
    duplicate: count(["DUPLICATE_PHONE", "DUPLICATE_PHONE_PROPERTY"]),
    suppressed: count(["SUPPRESSED"]),
    invalid: count(["INVALID_PHONE"]),
    missing: count(["MISSING_REQUIRED"]),
  };
}
