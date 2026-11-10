// What each migration leaves behind in the database. Used ONLY by the one-time baseline (see baseline.ts) to
// recognise migrations that production already has. Pick objects that exist only because of that migration.
//
// Add one for every new migration (tests/migrate-db.test.ts fails if a migration has none, and checks each signature
// against a real database built by the runner, so a wrong name is caught).
export type Signature = { tables?: string[]; columns?: string[]; indexes?: string[]; views?: string[] };

export const SIGNATURES: Record<string, Signature> = {
  "001_schema": { tables: ["users", "login_tokens", "sessions", "customers", "jobs", "scopes", "documents", "payments"] },
  "002_scope_builder": { columns: ["scopes.cost_cents", "scopes.target_margin_bps", "scope_items.kind", "scope_items.sort_order"] },
  "003_contracts": { tables: ["contract_signatures"], columns: ["documents.file_data", "documents.unsigned_sha256"], indexes: ["one_live_contract"] },
  "004_payments": { columns: ["payments.voided_at", "payments.check_photo_data", "payments.reference"], indexes: ["payments_job_idx"] },
  "005_leads": { columns: ["customers.phone_digits", "jobs.needs_review", "jobs.created_by"], indexes: ["customers_phone_digits_idx"] },
  "006_commission": {
    tables: ["commission_settings", "commission_runs", "commission_draw_applications"],
    columns: ["commission_payouts.kind", "commission_payouts.run_id", "commission_draws.applied_cents"],
    indexes: ["one_earned_per_payment", "one_reversal_per_payment", "commission_unpaid_idx"],
  },
  "007_reports": { views: ["source_performance"], indexes: ["job_stage_history_stage_idx"] },
  "008_scope_divisions": { columns: ["scopes.division"], indexes: ["one_selected_scope_per_division"] },
  "009_production": {
    tables: ["production_trades", "production_events"], columns: ["jobs.materials_ordered_at", "jobs.po_reference"],
    indexes: ["production_trades_crew_idx", "production_events_job_idx"],
  },
  "010_companycam": { columns: ["jobs.companycam_project_id", "jobs.companycam_status", "jobs.companycam_next_attempt_at"], indexes: ["jobs_companycam_project_idx"] },
  "011_closeout_invoicing": { tables: ["invoices"], columns: ["punchlist_items.division", "punchlist_items.sort_order"], indexes: ["invoices_one_live_idx", "punchlist_items_job_idx"] },
  "012_measurements": { tables: ["job_measurements", "integration_credentials"], indexes: ["job_measurements_job_idx"] },
  "013_roofing_assemblies": { tables: ["roofing_assembly_lines"], columns: ["scope_items.unit"] },
  "014_work_orders": { tables: ["work_orders", "work_order_lines"], indexes: ["work_order_lines_order_idx"] },
  "015_audit_log": { tables: ["audit_log"], indexes: ["audit_log_at_idx", "audit_log_entity_idx"] },
  "016_rate_limits": { tables: ["rate_limits"], indexes: ["rate_limits_reset_idx"] },
  "017_pruett_sync": { tables: ["pruett_sync_runs", "product_price_history"], columns: ["products.cost_cents", "products.active", "products.source"], indexes: ["pruett_sync_runs_started_idx", "product_price_history_product_idx"] },
};
