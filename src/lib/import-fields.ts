export const CANONICAL_FIELDS = [
  "phone",
  "first_name",
  "last_name",
  "owner_name",
  "property_address",
  "street_name",
  "city",
  "state",
  "postal_code",
  "county",
  "acreage",
  "property_type",
  "source",
  "external_id",
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number];
export type ColumnMapping = Partial<Record<CanonicalField, string>>;
