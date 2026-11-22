import { fixtureServices } from "./fixtures";
import { validateServices, assertNoErrors } from "../lib/gates.mjs";

export type Pricing = { kind: "free-estimate" } | { kind: "approved"; amount: string; currency: string };

export interface Service {
  slug: string;
  name: string;
  approved: boolean; // owner sign-off on every claim on the page
  directAnswer: string; // what it is, in plain text, opens the page
  whoFor: string;
  typicalScope: string[];
  priceDrivers: string[];
  pricing: Pricing;
}

// Empty until the owner supplies service lines and approved pricing (Phase 0 blocking input #3).
const real: Service[] = [];

export const services: Service[] = process.env.USE_FIXTURES === "1" ? fixtureServices : real;

assertNoErrors("Service", validateServices(services));
