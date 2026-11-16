#!/usr/bin/env bash
set -euo pipefail

# Run with an administrative PostgreSQL connection. PGHOST, PGPORT and
# PGPASSWORD use standard psql behavior; passwords never have source defaults.
: "${HIREAI_OWNER_PASSWORD:?Set HIREAI_OWNER_PASSWORD}"
: "${HIREAI_APP_PASSWORD:?Set HIREAI_APP_PASSWORD}"
admin_user="${POSTGRES_USER:-postgres}"
admin_database="${POSTGRES_DB:-postgres}"
hireai_database="${HIREAI_DATABASE:-hireai}"

psql --no-psqlrc --set=ON_ERROR_STOP=1 \
  --username="$admin_user" --dbname="$admin_database" \
  --set=owner_password="$HIREAI_OWNER_PASSWORD" \
  --set=app_password="$HIREAI_APP_PASSWORD" \
  --set=hireai_database="$hireai_database" <<'SQL'
SELECT 'CREATE ROLE hireai_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hireai_owner')
\gexec
SELECT 'CREATE ROLE hireai_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hireai_app')
\gexec
ALTER ROLE hireai_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE hireai_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
SELECT format('ALTER ROLE hireai_owner PASSWORD %L', :'owner_password')
\gexec
SELECT format('ALTER ROLE hireai_app PASSWORD %L', :'app_password')
\gexec
SELECT 'REVOKE hireai_owner FROM hireai_app'
WHERE EXISTS (
  SELECT 1 FROM pg_auth_members membership
  JOIN pg_roles granted ON granted.oid = membership.roleid
  JOIN pg_roles member_role ON member_role.oid = membership.member
  WHERE granted.rolname = 'hireai_owner' AND member_role.rolname = 'hireai_app'
)
\gexec
SELECT format('CREATE DATABASE %I OWNER hireai_owner', :'hireai_database')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'hireai_database')
\gexec
SELECT format('ALTER DATABASE %I OWNER TO hireai_owner', :'hireai_database')
\gexec
SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC', :'hireai_database')
\gexec
SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM hireai_app', :'hireai_database')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO hireai_app', :'hireai_database')
\gexec
SQL

psql --no-psqlrc --set=ON_ERROR_STOP=1 \
  --username="$admin_user" --dbname="$hireai_database" <<'SQL'
-- Existing tables keep their current owner. Upgrade ownership deliberately
-- before migrating; this initializer never silently reassigns application data.
ALTER SCHEMA public OWNER TO hireai_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO hireai_app;
SQL
