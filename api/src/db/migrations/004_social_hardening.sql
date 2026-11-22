-- Social publishing, defence in depth for the audit and proof tables.
-- Row triggers already block UPDATE and DELETE. A TRUNCATE bypasses row triggers, and reviews had no DELETE guard, so
-- the post event trail, the consent proof and the captured reviews (testimonial provenance) could still be wiped by
-- anyone with SQL access. These statement-level and delete triggers close that.

CREATE TRIGGER social_post_events_no_truncate BEFORE TRUNCATE ON social_post_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER social_connections_no_truncate BEFORE TRUNCATE ON social_connections
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER reviews_no_delete BEFORE DELETE ON reviews
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER reviews_no_truncate BEFORE TRUNCATE ON reviews
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
