import type { APIRoute } from "astro";
import { business } from "../data/business";
import { services } from "../data/services";
import { serviceAreas } from "../data/service-areas";
import { counties } from "../data/dfw-coverage";
import { buildLlmsTxt } from "../lib/llms.mjs";

export const GET: APIRoute = ({ site }) => {
  const siteUrl = (site ?? new URL("http://localhost")).origin;
  const body = buildLlmsTxt({ business, services, areas: serviceAreas, siteUrl, counties: counties.map((c) => `${c.name} County`) });
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
