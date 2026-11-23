// llms.txt: a plain Markdown map of the site for language models. Optional and with no proven ranking effect; kept accurate
// because it is generated from the same approved data as the pages. Only non-null facts and approved services appear.
export function buildLlmsTxt({ business: b, services, areas, siteUrl, counties }) {
  const out = [`# ${b.brandName}`, ""];
  const region = b.serviceRegion ? ` in ${b.serviceRegion}` : "";
  out.push(`> Heating and cooling service for homes and commercial buildings${region}. A person confirms the details before anything is scheduled.`, "");

  const approved = services.filter((s) => s.approved === true);
  if (approved.length) {
    out.push("## Services", "");
    for (const s of approved) out.push(`- [${s.name}](${siteUrl}/services/${s.slug}/): ${s.directAnswer}`);
    out.push("");
  }

  out.push("## Service area", "");
  out.push(`- [Cities, counties and ZIP codes we serve](${siteUrl}/service-area/)`);
  if (counties.length) out.push(`- Counties: ${counties.join(", ")}`);
  const active = areas.filter((a) => a.status === "active");
  if (active.length) out.push(`- Active ZIP code pages: ${active.length}`);
  out.push("");

  const contact = [];
  if (b.phoneDisplay) contact.push(`- Phone: ${b.phoneDisplay}`);
  if (b.streetAddress && b.city && b.state && b.postalCode) contact.push(`- Address: ${b.streetAddress}, ${b.city}, ${b.state} ${b.postalCode}`);
  if (b.hours) contact.push(`- Hours: ${b.hours}`);
  if (b.bookingUrl) contact.push(`- Booking: ${b.bookingUrl}`);
  if (contact.length) out.push("## Contact", "", ...contact, "");

  out.push("## Pages", "", `- [Home](${siteUrl}/)`, `- [Privacy policy](${siteUrl}/privacy/)`, `- [Terms](${siteUrl}/terms/)`, "");
  return out.join("\n");
}
