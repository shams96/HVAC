// The approved facts the chat agent may rely on, generated from the same owner-approved data files as the pages.
// Deploy step: `npm run catalog:sync` copies dist/catalog.json to api/config/catalog.json (refuses fixture/placeholder builds).
import type { APIRoute } from "astro";
import { business, isPlaceholderBuild, isFixtureBuild } from "../data/business";
import { services } from "../data/services";
import { activeAreas } from "../data/service-areas";

export const GET: APIRoute = () => {
  const catalog = {
    meta: { fixture: isFixtureBuild, placeholder: isPlaceholderBuild },
    business: {
      legalName: business.legalName,
      phoneE164: business.phoneE164,
      phoneDisplay: business.phoneDisplay,
      bookingUrl: business.bookingUrl,
      hours: business.hours,
    },
    services: services.map((s) => ({
      slug: s.slug, name: s.name, directAnswer: s.directAnswer, whoFor: s.whoFor,
      typicalScope: s.typicalScope, priceDrivers: s.priceDrivers, pricing: s.pricing,
    })),
    areas: activeAreas.map((a) => ({ zip: a.zip, city: a.city, state: a.state, serviceLines: a.serviceLines, travelBand: a.travelBand })),
    emergencyGuidance: null, // owner-approved wording; null uses the conservative default
    bannedClaims: [],
  };
  return new Response(JSON.stringify(catalog, null, 2), { headers: { "Content-Type": "application/json" } });
};
