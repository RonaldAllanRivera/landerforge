-- Move the standard tier to Claude Sonnet 5.
--
-- Sonnet 5 is both newer and cheaper than the Sonnet 4.6 this table shipped with:
-- $2/$10 per MTok against $3/$15. The saving is smaller than it looks, because Claude
-- 4.7 and later use a tokenizer that emits roughly 30% more tokens for the same text,
-- so the real-terms gap is about 13% rather than 33% — still a gain, and it comes with
-- a better model.
--
-- 0006 is left untouched. It has already run everywhere, and rewriting an applied
-- migration means two databases with the same version and different contents.

alter table public.settings
  alter column standard_model set default 'claude-sonnet-5';

-- Existing installs carry the old value in their row, and the column default does not
-- reach them. Move only rows still on the shipped default: anything else is a
-- deliberate operator choice and is not ours to overwrite.
update public.settings
   set standard_model = 'claude-sonnet-5'
 where standard_model = 'claude-sonnet-4-6';
