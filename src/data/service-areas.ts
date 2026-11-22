import { fixtureAreas } from "./fixtures";
import { validateServiceAreas, assertNoErrors } from "../lib/gates.mjs";

export type TravelBand = "0-15" | "15-30" | "30-45";

export interface LocalJob { summary: string; approved: boolean }
export interface LocalFact { text: string; sourceUrl: string; sourceLabel: string }

export interface ServiceArea {
  zip: string;
  city: string;
  state: string;
  branchId: string;
  status: "active" | "planned" | "excluded";
  travelBand: TravelBand;
  serviceLines: string[]; // service slugs
  slug: string;
  lastVerified: string; // ISO date the owner last confirmed this row
  localJobs: LocalJob[];
  localFacts: LocalFact[];
}

// Empty until the owner supplies the ZIP list (Phase 0 blocking input #2).
const real: ServiceArea[] = [];

export const serviceAreas: ServiceArea[] = process.env.USE_FIXTURES === "1" ? fixtureAreas : real;
export const activeAreas = serviceAreas.filter((a) => a.status === "active");

assertNoErrors("Service-area", validateServiceAreas(serviceAreas));
