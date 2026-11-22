// Single source of truth for owner-verified facts (site, schema, and later GBP sync).
// Every field is null until the owner supplies it. Nothing here is invented.
export interface Business {
  legalName: string | null;
  phoneDisplay: string | null; // e.g. "(555) 010-0100"
  phoneE164: string | null; // e.g. "+15550100100"
  bookingUrl: string | null;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  licenseNumbers: string[] | null;
  hours: string | null;
  serviceRegion: string | null; // human wording for the region, used in copy; owner stated: Dallas and Fort Worth
  timeZone: string | null; // IANA zone, for hours and reporting
}

export const business: Business = {
  legalName: null,
  phoneDisplay: null,
  phoneE164: null,
  bookingUrl: null,
  streetAddress: null,
  city: null,
  state: "TX", // owner said the work is in the DFW area (2026-11-22); Dallas and Fort Worth are in Texas
  postalCode: null,
  licenseNumbers: null,
  hours: null,
  serviceRegion: "the Dallas and Fort Worth area",
  timeZone: "America/Chicago", // DFW is in the Central time zone
};

// Fields the production build requires before it will emit.
export const requiredForProduction: (keyof Business)[] = [
  "legalName",
  "phoneDisplay",
  "phoneE164",
  "bookingUrl",
];

export const missingFields = requiredForProduction.filter((k) => business[k] == null);

// A build with missing facts is a placeholder build: noindex, and fails unless explicitly allowed.
export const isPlaceholderBuild = missingFields.length > 0;

// Fixture data (fake ZIPs/services) may never ship: always noindex, and refused when facts are complete.
export const isFixtureBuild = process.env.USE_FIXTURES === "1";
if (isFixtureBuild && !isPlaceholderBuild && import.meta.env.PROD) {
  throw new Error("Production build blocked: USE_FIXTURES=1 with complete business facts would publish fake data.");
}

if (isPlaceholderBuild && import.meta.env.PROD && process.env.ALLOW_PLACEHOLDERS !== "1") {
  throw new Error(
    `Production build blocked: owner-supplied facts missing: ${missingFields.join(", ")}. ` +
      `Set ALLOW_PLACEHOLDERS=1 only for a noindex staging build.`
  );
}
