/**
 * Orders a candidate's resumes for one application, best first: the resume
 * sent with that application, then resumes staff uploaded to the candidate,
 * then resumes sent with the candidate's other applications; newest first
 * within each. `document` is the candidate_documents alias and `application`
 * an SQL expression for the application id.
 */
export const applicationResumeOrder = (document: string, application: string) =>
  `CASE WHEN ${document}.application_id=${application} THEN 0 WHEN ${document}.application_id IS NULL THEN 1 ELSE 2 END,${document}.created_at DESC,${document}.id DESC`;
