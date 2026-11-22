// Stated service area: the Dallas and Fort Worth area (owner, 2026-11-22). Texas, Central time.
// ZIP codes below come from the US Census Bureau 2020 ZCTA to county relationship file: every ZIP code tabulation
// area in Texas (75xxx and 76xxx) whose land lies at least half inside Dallas, Tarrant, Collin or Denton county.
// ZCTAs approximate postal ZIP codes, and the edges are not owner confirmed. This list answers "do you serve my ZIP"
// for the stated area; it does NOT create per ZIP landing pages (those stay gated behind approved local jobs and facts).
import zips from "./dfw-zips.json";

export interface County { name: string; cities: string[]; zips: string[] }

// Major cities per county, for orientation only (not exhaustive, not a promise of service to every street).
const cities: Record<string, string[]> = {
  Dallas: ["Dallas", "Irving", "Garland", "Mesquite", "Grand Prairie", "Carrollton", "Rowlett", "DeSoto", "Cedar Hill", "Duncanville", "Coppell"],
  Tarrant: ["Fort Worth", "Arlington", "Euless", "Bedford", "Hurst", "Grapevine", "Southlake", "Keller", "Mansfield", "North Richland Hills"],
  Collin: ["Plano", "Frisco", "McKinney", "Allen", "Wylie", "Murphy", "Prosper", "Fairview"],
  Denton: ["Denton", "Lewisville", "Flower Mound", "The Colony", "Little Elm", "Corinth", "Highland Village"],
};

export const counties: County[] = ["Dallas", "Tarrant", "Collin", "Denton"].map((name) => ({
  name,
  cities: cities[name],
  zips: zips.filter((z) => z.county === name).map((z) => z.zip),
}));

export const coverageZips: Record<string, string> = Object.fromEntries(zips.map((z) => [z.zip, z.county]));
export const totalZips = zips.length;
