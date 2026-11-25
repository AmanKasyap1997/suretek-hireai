# Careers website publishing

When an HR Admin publishes a job and ticks **Careers website**, HireAI sends the
job to your website through the organization's **Careers CMS / API** connection.

## Setup

1. The deployment operator sets `INTEGRATION_CAREERS_CMS_PUBLISH_URL` to the
   website's HTTPS job endpoint (and, as for any Careers CMS connection,
   `INTEGRATION_CAREERS_CMS_VERIFY_URL`, plus `INTEGRATION_CAREERS_CMS_TOKEN_URL`
   or `INTEGRATION_CAREERS_CMS_API_KEY_HEADER` when the method needs them).
   Browser-supplied URLs are never used, and redirects are refused.
2. An HR Admin connects, tests and enables Careers CMS in **Integrations**.
   HireAI uses the production connection when it is enabled, otherwise sandbox.

## Request

`POST {INTEGRATION_CAREERS_CMS_PUBLISH_URL}` with the connection's credentials
(API key header, bearer token, basic auth or an OAuth client-credentials token),
`Content-Type: application/json` and `Idempotency-Key: {externalId}`.

```json
{
  "event": "job.published",
  "externalId": "<organization id>:<job id>",
  "organization": "<organization careers slug>",
  "job": {
    "id": "<job id>",
    "title": "Senior PHP Developer",
    "description": "Plain text…",
    "department": "Engineering",
    "location": "Noida",
    "employmentType": "FULL_TIME",
    "openings": 2,
    "salary": { "min": 1200000, "max": 1800000, "currency": "INR" },
    "publishedAt": "2026-11-20T09:30:00.000Z"
  }
}
```

`salary` is `null` when no range was entered.

**Create or update the job by `externalId`.** HireAI may send the same job again
after a timeout or server error, and the website must not create a duplicate.

Candidates apply through HireAI, so the website stores no applications: link
to HireAI's apply page, or post your own form to the public API. See
[Candidate applications](candidate-applications.md).

## Response

Any `2xx` means the job is live. Optionally return a receipt:

```json
{ "id": "website-job-42", "url": "https://careers.example.com/jobs/42" }
```

The HTTPS `url` is shown to the HR Admin, and LinkedIn uses it as the
application link when no other link is entered.

| Website response                  | HireAI status | Can be sent again               |
| --------------------------------- | ------------- | ------------------------------- |
| `2xx`                             | Published     | No (already live)               |
| `4xx`                             | Failed        | Yes                             |
| `5xx`, timeout or network failure | Unknown       | Yes; relies on the upsert above |

Closing a job in HireAI does not remove it from the website yet.
