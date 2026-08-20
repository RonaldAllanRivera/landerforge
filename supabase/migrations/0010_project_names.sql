-- Project names are the handle people use, so they have to be unique.
--
-- Indexed on lower(btrim(name)) rather than on name: "Breezebox" and "breezebox " are
-- the same project to everyone except a byte comparison, and two of them in a dropdown
-- is exactly the confusion this is meant to prevent. Normalising in the application
-- too would be belt and braces; doing it ONLY there leaves the invariant one forgotten
-- .trim() away from breaking.
--
-- This will refuse to apply to a database that already holds duplicates, which is the
-- right outcome: which of the two to rename is not a decision a migration can make.

create unique index projects_name_unique on public.projects (lower(btrim(name)));

comment on index public.projects_name_unique is
  'Case- and whitespace-insensitive. See migration 0010.';
