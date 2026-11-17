-- Invitation provenance is metadata, never a raw token. Runtime updates remain column-scoped.
GRANT UPDATE(invited_by) ON user_invitations TO hireai_app;
