# Multi-Cloud Connectors — Billing File Ingestion

> KostOps uses **file-based billing exports** (not API polling) for bulk ingestion across all cloud platforms. This mirrors the AWS CUR pattern across every provider. API calls are reserved for MCP real-time queries only.

---

## Design Principle: Push, Don't Poll

```
Cloud billing system pushes export → KostOps reads file/table → Glue ETL → FOCUS schema → Athena
```

Each cloud provider pushes billing data on a schedule. KostOps reads it. No rate limits, no auth token rotation, no API quota management. The same pattern AWS pioneered with CUR applies to every connector.

---

## Connector Comparison

| Platform | Export type | Format | Lands in | KostOps reads from | FOCUS native? |
|---|---|---|---|---|---|
| AWS | CUR 2.0 | Parquet | S3 (payer account) | Glue Crawler → Athena | ✅ FOCUS export available |
| Azure | Cost Management export | CSV or FOCUS | Azure Blob Storage | Lambda copies to S3 | ✅ Native FOCUS export |
| GCP | BigQuery billing export | BigQuery table | Your BigQuery dataset | BigQuery Storage API → S3 | 🔄 FOCUS converter |
| Snowflake | ACCOUNT_USAGE schema | SQL views | Snowflake (stays there) | MCP tool call (real-time) or scheduled SQL export | 🔄 Manual mapping |
| Databricks | system.billing tables | Delta/SQL tables | Unity Catalog | MCP tool call (real-time) or Delta export | 🔄 Manual mapping |
| MongoDB Atlas | Invoices API | JSON | REST endpoint | Lambda scheduled pull | ❌ API only |
| Datacenter | CMDB / chargeback | CSV / API | ServiceNow | Lambda scheduled pull | ❌ Custom mapping |

---

## AWS — CUR 2.0 (foundation — already in KostOps)

**Mechanism**: AWS pushes CUR 2.0 Parquet files to a designated S3 bucket in the payer account on a daily schedule. KostOps reads via cross-account IAM role — no data copying between accounts.

```
AWS billing → S3 (payer account) → Glue Crawler → Athena table → normalized store
```

**Setup**: Enable CUR 2.0 in AWS Data Exports console. Point to KostOps S3 bucket. Done.

**Key improvement over CUR 1.0**: Fixed schema (no monthly column drift), nested tags as key-value pairs, additional columns `bill_payer_account_name` and `line_item_usage_account_name`.

**FOCUS**: AWS now supports native FOCUS export via Data Exports — enables zero-ETL path directly into the FOCUS normalized schema.

**IAM permissions** (read-only on payer):
```
ce:Get*, compute-optimizer:Get*, budgets:ViewBudget,
s3:GetObject on CUR bucket, organizations:List*
```

---

## Azure — Cost Management Export (CUR equivalent)

**Mechanism**: Azure Cost Management pushes CSV or FOCUS-format files to an Azure Blob Storage container on a daily or monthly schedule. A Lambda function triggered by Azure Event Grid (or a simple EventBridge schedule) copies new files to S3 for Glue processing.

```
Azure billing → Blob Storage (your container) → Lambda copy → S3 → Glue ETL → normalized store
```

**Why not the API?** The Cost Management API has rate limits, pagination complexity, and requires active polling. The export is push-based, complete, and mirrors the AWS CUR pattern exactly.

**FOCUS native**: Azure exports natively in FOCUS format — enable this in Cost Management → Exports → select FOCUS format. This eliminates the Azure-specific ETL entirely. The Glue job receives data already in FOCUS schema.

**Setup steps**:
1. Azure portal → Cost Management → Exports → Create export
2. Select: FOCUS format, Daily granularity, Blob Storage destination
3. Grant KostOps service principal `Storage Blob Data Reader` on the container
4. EventBridge schedule triggers Lambda to `azcopy` new files to S3 daily

**Key fields** (when not using FOCUS export):
```
UsageDate, ResourceId, ResourceGroupName, SubscriptionId,
MeterCategory, MeterSubcategory, ConsumedService,
PreTaxCost, Currency, Tags
```

**Billing lag**: Azure finalizes costs 24–72 hours after usage. Lambda pulls with 3-day lookback and upserts using `ResourceId + UsageDate` as composite key.

**Credentials**: Service Principal (App Registration) with `Cost Management Reader` role. Client ID + secret stored in AWS Secrets Manager.

---

## GCP — BigQuery Billing Export (CUR equivalent)

**Mechanism**: GCP pushes billing data directly into a BigQuery dataset in your GCP project on a continuous basis (not daily batch — it streams). KostOps reads from BigQuery using the BigQuery Storage API and loads into S3/Athena.

```
GCP billing → BigQuery dataset → BigQuery Storage API → Lambda → S3 → Glue ETL → normalized store
```

**Why BigQuery, not files?** GCP deprecated CSV/JSON billing exports in 2017. BigQuery is the authoritative export destination. You can export BigQuery → GCS → S3 if preferred, but the Storage API read is simpler.

**Two export types** (use Detailed):
- `gcp_billing_export_v1_<BILLING_ACCOUNT_ID>` — standard: service, SKU, project, labels, cost, credits
- `gcp_billing_export_resource_v1_<BILLING_ACCOUNT_ID>` — **detailed**: everything above + resource-level data (specific VM, SSD). Use this for rightsizing signals.

**Setup steps**:
1. GCP console → Billing → Billing export → BigQuery export → Enable detailed export
2. Create GCP Service Account with `BigQuery Data Viewer` on the billing dataset
3. Store service account key in AWS Secrets Manager
4. EventBridge schedule triggers Lambda daily: query BigQuery using `billing_period` partition filter, write to S3 as Parquet

**Incremental query** (append-only, no full reload):
```sql
SELECT * FROM `project.dataset.gcp_billing_export_resource_v1_ACCOUNT_ID`
WHERE DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 3 DAY)
```

**Nested structure**: GCP labels are nested JSON — Glue ETL flattens `labels` array to key-value map matching FOCUS `Tags` field. `service.description` → `ServiceName`, `project.id` → `SubAccountId`.

**FOCUS**: GCP native FOCUS export is in progress (expected 2025–2026). Until then, use open-source FOCUS converter from FinOps Foundation GitHub to transform GCP billing schema to FOCUS.

**Credentials**: GCP Service Account JSON key in AWS Secrets Manager. Rotate quarterly.

---

## Snowflake — ACCOUNT_USAGE (dual-mode: MCP + scheduled export)

**Primary mode — MCP real-time**: Snowflake managed MCP server queries `ACCOUNT_USAGE` views on demand. Used by the Visibility Agent for live "why did spend spike?" questions.

**Secondary mode — scheduled export**: For FMI scoring and historical trend analysis, a daily Lambda uses the Snowflake Python connector (Lambda layer) to query and write results to S3.

```sql
-- Daily export query for FMI scoring
SELECT
  warehouse_name,
  DATE(start_time) AS usage_date,
  SUM(credits_used_compute) AS compute_credits,
  SUM(credits_used_compute) - SUM(credits_attributed_compute_queries) AS idle_credits,
  COUNT(DISTINCT query_id) AS query_count
FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
WHERE start_time >= DATEADD('days', -3, CURRENT_TIMESTAMP())
GROUP BY 1, 2
```

**Key views**: `WAREHOUSE_METERING_HISTORY`, `QUERY_HISTORY`, `STORAGE_USAGE`, `METERING_DAILY_HISTORY`, `WAREHOUSE_LOAD_HISTORY`

**Auth**: Dedicated `KOSTOPS_FINOPS_READER` role with `MONITOR USAGE` privilege. Password in AWS Secrets Manager.

---

## Databricks — system.billing (dual-mode: MCP + scheduled export)

**Primary mode — MCP real-time**: Databricks Unity AI Gateway MCP server queries `system.billing` tables on demand for live queries.

**Secondary mode — scheduled export**: Daily Lambda exports to S3 for FMI scoring.

```sql
-- Daily export: dollar cost per cluster per day
SELECT
  u.usage_date,
  u.usage_metadata.cluster_id,
  u.sku_name,
  SUM(u.usage_quantity * p.pricing.effective_list.default) AS cost_usd,
  c.cluster_name,
  c.creator_user_name AS owner
FROM system.billing.usage u
JOIN system.billing.list_prices p ON p.sku_name = u.sku_name
  AND u.usage_date BETWEEN p.price_start_time AND COALESCE(p.price_end_time, CURRENT_DATE())
LEFT JOIN system.compute.clusters c ON c.cluster_id = u.usage_metadata.cluster_id
WHERE u.usage_date >= DATEADD(DAY, -3, CURRENT_DATE())
GROUP BY 1, 2, 3, 5, 6
```

**Auth**: Databricks PAT (account-level admin) in AWS Secrets Manager.

---

## FOCUS Normalization — Replacing Custom ETL

All connectors output to the **FOCUS v1.2 schema** before entering the KostOps normalized store. This replaces the previous custom normalization ETL.

| FOCUS column | KostOps use | AWS source | Azure source | GCP source |
|---|---|---|---|---|
| `EffectiveCost` | FMI O-baseline | `line_item_unblended_cost` (amortized) | `CostInBillingCurrency` | `cost` after credits |
| `BilledCost` | COIN ratio | `bill_total` | `BilledCost` | `cost` |
| `ServiceCategory` | Cross-cloud grouping | Mapped from `product_product_name` | `MeterCategory` | `service.description` |
| `ResourceId` | Owner lookup | `line_item_resource_id` | `ResourceId` | `resource.name` |
| `SubAccountId` | BU layer 1 | `line_item_usage_account_id` | `SubscriptionId` | `project.id` |
| `Tags` | FMI C-component | `resource_tags` map | `Tags` JSON | `labels` array → flattened |
| `CommitmentDiscountStatus` | RI/SP coverage | `savings_plan_savings_plan_arn` / `reservation_*` | `BenefitName` | `credits[].type` |

**AWS and Azure**: Already emit FOCUS natively — Glue ETL runs as a validator + Optum-specific enrichment (BU mapping, owner resolution, FMI contribution scoring), not a full transform.

**GCP, Snowflake, Databricks**: Use FinOps Foundation open-source FOCUS converters, then Optum enrichment layer.

> Reference: [FOCUS v1.2 Specification](https://focus.finops.org/focus-specification/v1-2/) — FinOps Foundation, ratified June 2025
