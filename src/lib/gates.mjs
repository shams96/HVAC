// Build-time content gates. Pure functions returning a list of error strings ([] = pass).

export function validateServiceAreas(areas) {
  const errors = [];
  const seenZip = new Set();
  const seenSlug = new Set();
  const jobOwner = new Map(); // normalized job summary -> zip

  for (const a of areas) {
    const id = `ZIP ${a.zip}`;
    if (!/^\d{5}$/.test(a.zip ?? "")) errors.push(`${id}: zip must be 5 digits`);
    if (seenZip.has(a.zip)) errors.push(`${id}: duplicate zip`);
    seenZip.add(a.zip);
    if (a.status !== "active") continue; // planned/excluded get no page and need no content

    if (!a.slug) errors.push(`${id}: missing slug`);
    if (seenSlug.has(a.slug)) errors.push(`${id}: duplicate slug "${a.slug}"`);
    seenSlug.add(a.slug);
    if (!a.branchId) errors.push(`${id}: missing branchId`);
    if (!a.serviceLines?.length) errors.push(`${id}: no service lines`);

    const approvedJobs = (a.localJobs ?? []).filter((j) => j.approved === true && j.summary?.trim());
    if (approvedJobs.length < 1) errors.push(`${id}: needs at least one approved local job`);
    const sourcedFacts = (a.localFacts ?? []).filter((f) => f.text?.trim() && /^https?:\/\//.test(f.sourceUrl ?? ""));
    if (sourcedFacts.length < 1) errors.push(`${id}: needs at least one sourced local fact (text + http(s) sourceUrl)`);

    for (const j of approvedJobs) {
      const key = j.summary.trim().toLowerCase().replace(/\s+/g, " ");
      if (jobOwner.has(key) && jobOwner.get(key) !== a.zip) {
        errors.push(`${id}: job summary copied across ZIPs (also in ${jobOwner.get(key)}); each ZIP needs unique copy`);
      }
      jobOwner.set(key, a.zip);
    }
  }
  return errors;
}

const PRICING_KINDS = new Set(["free-estimate", "approved"]);

export function validateServices(services) {
  const errors = [];
  const seen = new Set();
  for (const s of services) {
    const id = `service "${s.slug}"`;
    if (seen.has(s.slug)) errors.push(`${id}: duplicate slug`);
    seen.add(s.slug);
    if (s.approved !== true) errors.push(`${id}: not owner-approved`);
    if (!s.name?.trim()) errors.push(`${id}: missing name`);
    if (!s.directAnswer?.trim()) errors.push(`${id}: missing direct answer`);
    if (!s.whoFor?.trim()) errors.push(`${id}: missing who-it-is-for`);
    if (!s.typicalScope?.length) errors.push(`${id}: missing typical scope`);
    if (!s.priceDrivers?.length) errors.push(`${id}: missing price drivers`);
    if (!PRICING_KINDS.has(s.pricing?.kind)) errors.push(`${id}: pricing kind must be free-estimate or approved`);
    else if (s.pricing.kind === "approved" && !(s.pricing.amount && s.pricing.currency)) {
      errors.push(`${id}: approved pricing needs amount and currency`);
    }
  }
  return errors;
}

export function assertNoErrors(label, errors) {
  if (errors.length) throw new Error(`${label} gate failed:\n - ${errors.join("\n - ")}`);
}
