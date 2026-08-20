-- Reasoning effort, as a setting.
--
-- This turned out to be the largest cost lever in the system, and the one that was not
-- being set at all. Output tokens were 88% of the first complete run's cost, and the
-- same section call measured 2,414 output tokens on one attempt and 11,128 on the next
-- with an identical prompt. Inheriting the provider default means per-section cost is
-- simply not predictable.
--
-- Measured on one real section call (Sonnet 5, 16,000-token ceiling, same prompt):
--   high     16,000 output tokens and two characters of JSON — the whole budget went to
--            reasoning and the response was truncated. $0.16 for nothing.
--   medium    2,746 output tokens, copy on target.
--   low       1,568 output tokens, copy still inside the word target.
--
-- 'high' is deliberately still selectable: it is the right answer for a hard template,
-- and the guard against its failure mode is max_tokens, not a missing enum value.

alter table public.settings
  add column effort text not null default 'medium'
    check (effort in ('low', 'medium', 'high'));

comment on column public.settings.effort is
  'Reasoning effort for generation calls. Ignored for models that do not support it '
  '(Haiku 4.5 reports every level unsupported and returns 400 if sent the parameter).';
