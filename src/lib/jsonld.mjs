// JSON-LD builders. Emit only owner-confirmed facts; return null rather than a partial record.
// Deliberately absent: AggregateRating (needs reviews displayed on the page), FAQPage (needs real customer questions).

const REQUIRED = ["legalName", "phoneE164", "streetAddress", "city", "state", "postalCode"];
const hasFacts = (b) => REQUIRED.every((k) => b[k] != null && String(b[k]).trim() !== "");

export function buildLocalBusiness(b, areas, siteUrl) {
  if (!hasFacts(b)) return null;
  const j = {
    "@context": "https://schema.org",
    "@type": "HVACBusiness",
    "@id": `${siteUrl}/#business`,
    name: b.legalName,
    url: siteUrl,
    telephone: b.phoneE164,
    address: {
      "@type": "PostalAddress",
      streetAddress: b.streetAddress,
      addressLocality: b.city,
      addressRegion: b.state,
      postalCode: b.postalCode,
    },
    areaServed: areas
      .filter((a) => a.status === "active")
      .map((a) => ({ "@type": "Place", name: `${a.city}, ${a.state} ${a.zip}` })),
  };
  if (b.hours) j.openingHours = b.hours;
  return j;
}

// Structured data that needs only facts the owner has already stated (brand name, region, counties).
// Returns null on a localhost or unparseable site URL, so a build without a real address never emits wrong URLs.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
export function isRealSiteUrl(u) {
  try {
    const h = new URL(u).hostname;
    return !LOCAL_HOSTS.has(h) && !h.endsWith(".localhost");
  } catch {
    return false;
  }
}

// The business id is shared with HVACBusiness: when full facts exist the page emits HVACBusiness instead of Organization.
export function buildOrganization(b, siteUrl, areaNames = []) {
  if (!isRealSiteUrl(siteUrl) || !b.brandName) return null;
  const j = {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${siteUrl}/#business`,
    name: b.brandName,
    url: siteUrl,
    logo: `${siteUrl}/icon-512.png`,
  };
  if (areaNames.length) j.areaServed = areaNames.map((name) => ({ "@type": "AdministrativeArea", name }));
  return j;
}

export function buildWebSite(b, siteUrl) {
  if (!isRealSiteUrl(siteUrl) || !b.brandName) return null;
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${siteUrl}/#website`,
    name: b.brandName,
    url: siteUrl,
    inLanguage: "en-US",
    publisher: { "@id": `${siteUrl}/#business` },
  };
}

// trail: [{ name, path }] after Home; Home is added here.
export function buildBreadcrumbs(trail, siteUrl) {
  if (!isRealSiteUrl(siteUrl) || !trail?.length) return null;
  const items = [{ name: "Home", path: "/" }, ...trail];
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, name: it.name, item: `${siteUrl}${it.path}` })),
  };
}

export function buildService(s, b, siteUrl) {
  if (!hasFacts(b) || s.approved !== true) return null;
  const offers =
    s.pricing.kind === "approved"
      ? { "@type": "Offer", price: s.pricing.amount, priceCurrency: s.pricing.currency }
      : { "@type": "Offer", description: "Free estimate" };
  return {
    "@context": "https://schema.org",
    "@type": "Service",
    name: s.name,
    description: s.directAnswer,
    provider: { "@id": `${siteUrl}/#business` },
    offers,
  };
}
