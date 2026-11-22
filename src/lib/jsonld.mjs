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
