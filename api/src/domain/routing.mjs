// rules: [{ zip, service_line ('*' = any), branch_id, assignee_group }]. No rule = unrouted (human triage).
export function pickRoute(rules, zip, serviceLine) {
  const forZip = rules.filter((r) => r.zip === zip);
  const exact = forZip.find((r) => r.service_line === serviceLine);
  if (exact) return { branchId: exact.branch_id, assigneeGroup: exact.assignee_group ?? null, routedBy: "zip+service" };
  const any = forZip.find((r) => r.service_line === "*");
  if (any) return { branchId: any.branch_id, assigneeGroup: any.assignee_group ?? null, routedBy: "zip" };
  return { branchId: null, assigneeGroup: null, routedBy: "unrouted" };
}
