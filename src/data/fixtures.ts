// FIXTURE DATA: obviously fake, for template development only. Loaded only when USE_FIXTURES=1.
// Fixture builds are noindex and are refused in production (see business.ts).
import type { ServiceArea } from "./service-areas";
import type { Service } from "./services";

export const fixtureAreas: ServiceArea[] = [
  {
    zip: "00001", city: "Sampleville", state: "XX", branchId: "fixture-main", status: "active", travelBand: "0-15",
    serviceLines: ["fixture-repair", "fixture-install"], slug: "sampleville-00001", lastVerified: "2026-01-01",
    localJobs: [{ summary: "FIXTURE: replaced a sample furnace in a sample 1950s bungalow.", approved: true }],
    localFacts: [{ text: "FIXTURE: sample permit note for Sampleville.", sourceUrl: "https://example.org/sampleville-permits", sourceLabel: "Sampleville permit page (fixture)" }],
  },
  {
    zip: "00002", city: "Exampleton", state: "XX", branchId: "fixture-main", status: "active", travelBand: "15-30",
    serviceLines: ["fixture-repair"], slug: "exampleton-00002", lastVerified: "2026-01-01",
    localJobs: [{ summary: "FIXTURE: sample heat pump tune-up at a sample townhouse.", approved: true }],
    localFacts: [{ text: "FIXTURE: sample climate note for Exampleton.", sourceUrl: "https://example.org/exampleton-climate", sourceLabel: "Exampleton climate normals (fixture)" }],
  },
  {
    zip: "00003", city: "Placeholder Heights", state: "XX", branchId: "fixture-main", status: "planned", travelBand: "30-45",
    serviceLines: [], slug: "placeholder-heights-00003", lastVerified: "2026-01-01", localJobs: [], localFacts: [],
  },
];

export const fixtureServices: Service[] = [
  {
    slug: "fixture-repair", name: "Fixture repair service", approved: true,
    directAnswer: "FIXTURE: a sample direct answer describing what the service is, in one or two plain sentences.",
    whoFor: "FIXTURE: sample homeowners with a sample problem.",
    typicalScope: ["FIXTURE: diagnose the issue", "FIXTURE: quote before work", "FIXTURE: repair and test"],
    priceDrivers: ["FIXTURE: equipment age", "FIXTURE: part availability", "FIXTURE: access"],
    pricing: { kind: "free-estimate" },
  },
  {
    slug: "fixture-install", name: "Fixture installation service", approved: true,
    directAnswer: "FIXTURE: a second sample direct answer.",
    whoFor: "FIXTURE: sample property owners replacing old equipment.",
    typicalScope: ["FIXTURE: site visit", "FIXTURE: sizing", "FIXTURE: install and commission"],
    priceDrivers: ["FIXTURE: system size", "FIXTURE: ductwork condition"],
    pricing: { kind: "free-estimate" },
  },
];
