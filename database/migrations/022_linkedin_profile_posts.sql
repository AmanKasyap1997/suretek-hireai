-- Posts on the connecting HR admin's own LinkedIn profile (Share on LinkedIn).
ALTER TABLE integration_publications DROP CONSTRAINT integration_publications_channel_check;
ALTER TABLE integration_publications ADD CONSTRAINT integration_publications_channel_check
 CHECK(channel IN ('company_announcement','job_listing','careers_website','profile_post'));
