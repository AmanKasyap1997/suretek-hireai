# Provider ports and adapters

- ObjectStoragePort: private local development/test storage and SigV4 S3-compatible storage. Production uses HTTPS S3. No public ACL/URL is generated; provision a private bucket.
- MalwareScanPort: the explicit stub returns PENDING, never CLEAN. Implement a real scanner adapter before making resumes downloadable. No provider is called here.
- CaptchaPort: explicitly disabled stub. Persistent rate limits and a honeypot remain active; no CAPTCHA provider is contacted.

See docs/milestone-b-operations.md for configuration, quarantine, erasure retry and storage-inventory recovery. AI/voice/calendar/email/queue integrations remain out of scope.
