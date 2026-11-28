-- Careers website deliveries share the durable, one-dispatch publication ledger
-- used for LinkedIn, so retries and history work the same way for every channel.
ALTER TABLE integration_publications DROP CONSTRAINT integration_publications_channel_check;
ALTER TABLE integration_publications ADD CONSTRAINT integration_publications_channel_check
 CHECK(channel IN ('company_announcement','job_listing','careers_website'));
