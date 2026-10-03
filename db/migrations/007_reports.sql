-- Slice 7 (reports). Replace the source_performance view so a win means a signed contract, not "has a contract amount".
-- Safe to re-run. Dev databases only; review before running elsewhere.
DROP VIEW IF EXISTS source_performance;
CREATE VIEW source_performance AS
SELECT j.source,
       date_trunc('month', j.created_at AT TIME ZONE 'America/Chicago')::date AS month,
       count(*)                                         AS leads,
       count(*) FILTER (WHERE j.stage IN ('contract_signed','deposit_collected','materials_ordered','scheduled',
                                           'in_production','closeout_punchlist','invoiced','depreciation_pending','paid_in_full')) AS wins,
       round(100.0 * count(*) FILTER (WHERE j.stage IN ('contract_signed','deposit_collected','materials_ordered','scheduled',
                                           'in_production','closeout_punchlist','invoiced','depreciation_pending','paid_in_full'))
             / nullif(count(*),0), 1) AS close_rate_pct,
       max(ms.spend_cents) / nullif(count(*),0)         AS cost_per_lead_cents,
       max(ms.spend_cents) / nullif(count(*) FILTER (WHERE j.stage IN ('contract_signed','deposit_collected','materials_ordered','scheduled',
                                           'in_production','closeout_punchlist','invoiced','depreciation_pending','paid_in_full')),0) AS cost_per_win_cents
FROM jobs j
LEFT JOIN marketing_spend ms
  ON ms.source = j.source AND ms.month = date_trunc('month', j.created_at AT TIME ZONE 'America/Chicago')::date
WHERE j.job_type <> 'condition_report'
GROUP BY 1, 2;
CREATE INDEX IF NOT EXISTS job_stage_history_stage_idx ON job_stage_history (to_stage, changed_at);