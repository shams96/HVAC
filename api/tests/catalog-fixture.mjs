// FAKE catalog for tests only (Sampleville). Never a source of real business facts.
export const fixtureCatalog = () => ({
  business: { legalName: "Sample HVAC Co (fixture)", phoneE164: "+14155550100", phoneDisplay: "(415) 555-0100", bookingUrl: "https://example.org/book", hours: "Mon-Fri 8-5 (fixture)" },
  services: [
    { slug: "repair", name: "Repair", directAnswer: "FIXTURE: we diagnose and repair heating and cooling equipment.", whoFor: "Homeowners with a broken system.", typicalScope: ["diagnose", "quote", "repair"], priceDrivers: ["equipment age", "parts"], pricing: { kind: "free-estimate" } },
    { slug: "tuneup", name: "Seasonal tune-up", directAnswer: "FIXTURE: a yearly inspection and cleaning.", whoFor: "Anyone wanting fewer breakdowns.", typicalScope: ["inspect", "clean"], priceDrivers: ["system count"], pricing: { kind: "approved", amount: "129", currency: "USD" } },
    { slug: "install", name: "Installation", directAnswer: "FIXTURE: replace or add equipment.", whoFor: "Owners replacing old equipment.", typicalScope: ["site visit", "sizing", "install"], priceDrivers: ["system size"], pricing: { kind: "free-estimate" } },
  ],
  areas: [
    { zip: "00001", city: "Sampleville", state: "XX", serviceLines: ["repair", "tuneup", "install"], travelBand: "0-15" },
    { zip: "00002", city: "Exampleton", state: "XX", serviceLines: ["repair"], travelBand: "15-30" },
  ],
  emergencyGuidance: null,
  bannedClaims: ["guaranteed lowest price", "number one", "#1"],
});

// A bigger FAKE catalog so 40 distinct panel queries exist (the base fixture has only 4 ZIP and service combinations).
export const bigFixtureCatalog = () => ({
  business: {}, emergencyGuidance: null, bannedClaims: [],
  services: [
    { slug: "repair", name: "AC repair", pricing: { kind: "free-estimate" } },
    { slug: "install", name: "Furnace installation", pricing: { kind: "free-estimate" } },
    { slug: "tuneup", name: "Maintenance", searchTerm: "hvac tune up", pricing: { kind: "free-estimate" } },
  ],
  areas: ["00001", "00002", "00003", "00004", "00005"].map((zip, i) => ({ zip, city: `City${i}`, state: "XX", travelBand: "0-15", serviceLines: ["repair", "install", "tuneup"] })),
});
