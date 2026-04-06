# KostOps

A self-hosted AWS FinOps agent that runs entirely in your AWS account.
Deploy it, connect your billing data, and get ranked savings opportunities
with an AI chat interface. Pay AWS for compute. Pay nobody else.

## What it does

- Visibility — daily spend by service, account, tag, and resource
- Optimization — ranked savings opportunities (idle EC2, unattached EBS, rightsizing)
- AI Agent — natural language chat backed by AWS Strands + Claude on Bedrock
- Slack alerts — daily digest and anomaly notifications

## Architecture

```
Payer (management) account          Linked account (KostOps runs here)
──────────────────────────          ──────────────────────────────────
CUR export → S3  ←─────────────────── Glue Crawler (cross-account read)
  bucket policy allows                Athena        (queries payer CUR)
  linked account read                 DynamoDB      (findings)
Cost Explorer API ←─sts:AssumeRole── KostOps agent
Compute Optimizer                   Lambda + API Gateway
Budgets                             CloudFront + React UI
Cost Optimization Hub               Cognito
```

**No S3 replication.** The Glue crawler in the linked account reads the
payer CUR bucket directly via a cross-account S3 bucket policy. This
eliminates duplicate storage costs and keeps billing data in one place.

## Where to Find Logs

Every component writes to a different place. Use this map to go straight to the
right log for whatever is failing.

### During `cdk deploy` — deploy-time failures

| What failed | Where to look |
|---|---|
| Any stack resource failed to create | AWS Console → CloudFormation → select stack → **Events** tab → filter by `CREATE_FAILED` |
| CUR prefix auto-detection failed | CloudWatch Logs → `/aws/lambda/kostops-cur-prefix-detector` |
| Glue crawler did not start at deploy | CloudWatch Logs → log group starting with `/aws/lambda/KostOpsDataStack-CurPrefixProvider` (CDK framework Lambda) |
| Payer bucket policy failed to apply | CloudWatch Logs → log group starting with `/aws/lambda/KostOpsPayerStack-AWS` (CDK AwsCustomResource framework Lambda) |
| `deploy_agent.py` failed | Terminal output — the script logs to stdout. Also: AWS Console → CloudFormation → KostOpsAgentStack → Events |

**Quickest way to see all deploy-time errors in one place:**
```bash
# List events for all KostOps stacks, showing only failures
for stack in KostOpsAuthStack KostOpsDataStack KostOpsAgentStack KostOpsApiStack KostOpsFrontendStack; do
  echo "=== $stack ==="
  aws cloudformation describe-stack-events --stack-name $stack \
    --query 'StackEvents[?ResourceStatus==`CREATE_FAILED` || ResourceStatus==`UPDATE_FAILED`].[LogicalResourceId,ResourceStatusReason]' \
    --output table 2>/dev/null || echo "Stack not found"
done
```

### After deploy — runtime failures

| What failed | Where to look |
|---|---|
| Chat returns "Failed to fetch" or error | CloudWatch Logs → `/aws/lambda/kostops-chat-handler` |
| Agent times out / no response | CloudWatch Logs → `/aws/lambda/kostops-chat-handler` (look for `RuntimeClientError`) |
| Findings not showing in UI | CloudWatch Logs → `/aws/lambda/kostops-findings-handler` |
| Slack digest not sending | CloudWatch Logs → `/aws/lambda/kostops-slack-handler` |
| Dashboard charts empty | CloudWatch Logs → `/aws/lambda/kostops-dashboard-handler` |
| Athena queries failing | CloudWatch Logs → `/aws/lambda/kostops-chat-handler` + Athena console → Query history |
| Glue crawler failing daily | CloudWatch Logs → `/aws/glue/crawlers` → log stream `kostops-cur-crawler` |
| AgentCore Runtime unhealthy | AWS Console → Bedrock → AgentCore → Runtimes → `kostopsVisibilityAgent` → Status |

**Tail any Lambda log live:**
```bash
aws logs tail /aws/lambda/kostops-chat-handler --follow
aws logs tail /aws/lambda/kostops-cur-prefix-detector --follow
aws logs tail /aws/glue/crawlers --log-stream-name kostops-cur-crawler --follow
```

**Check AgentCore Runtime status:**
```bash
aws bedrock-agentcore-control list-agent-runtimes \
  --query 'agentRuntimes[?agentRuntimeName==`kostopsVisibilityAgent`].{Status:status,FailureReason:lastUpdateFailureReason}' \
  --output table
```

### Where CDK custom resource logs hide

CDK creates internal framework Lambdas with auto-generated names. Find them by prefix:
```bash
# List all KostOps-related Lambda log groups
aws logs describe-log-groups \
  --log-group-name-prefix /aws/lambda/KostOps \
  --query 'logGroups[*].logGroupName' \
  --output table
```

---

## Deployment Checklist

Use this checklist to verify each stage. Helps catch problems early in customer accounts.

### Stage 0 — Before you start

- [ ] CUR export exists in payer account (Billing → Cost & Usage Reports → Legacy Exports)
- [ ] CUR is configured with **Parquet** format and **Athena-compatible** S3 prefixes enabled
- [ ] You know the CUR S3 bucket name (`payerCurBucketName` context value)
- [ ] You have `AdministratorAccess` (or equivalent) on both payer and linked accounts

> **No need to find the prefix manually.** `cdk deploy --all` runs a Lambda
> (`kostops-cur-prefix-detector`) that scans the bucket automatically and
> wires the crawler to the correct parquet path.
- [ ] Node 18+, Python 3.12+, AWS CDK v2 installed

### Stage 1 — Payer stack deployed (`KostOpsPayerStack`)

- [ ] Stack status is `CREATE_COMPLETE` or `UPDATE_COMPLETE` in CloudFormation console
- [ ] `kostops-cross-account-role` exists in IAM → Roles in the payer account
- [ ] SSM parameter `/kostops/payer/cur-bucket-name` exists in the **linked** account

**Where to look if it fails:**
- CloudFormation console → KostOpsPayerStack → Events tab → look for `CREATE_FAILED`
- Common error: `BucketPolicyAlreadyExists` → the bucket already has a policy; check `stacks/payer-stack.ts` uses `AwsCustomResource` (not `CfnBucketPolicy`)

### Stage 2 — Linked account stacks deployed (`cdk deploy --all`)

- [ ] All 5 stacks `CREATE_COMPLETE`: AuthStack, DataStack, AgentStack, ApiStack, FrontendStack
- [ ] Cognito User Pool exists in us-east-1 → check CloudFormation output `UserPoolId`
- [ ] Admin user received temporary password email
- [ ] S3 bucket `kostops-athena-results-<account-id>` exists
- [ ] DynamoDB table `kostops-findings` exists with `status-index` GSI

**Where to look if it fails:**
- CloudFormation console → each stack → Events tab → filter `CREATE_FAILED`
- Common errors:
  - `Invalid principal`: role ARN referenced before it exists → use `AccountPrincipal` not role ARN
  - `adminEmail not set`: admin user not created → pass `--context adminEmail=you@company.com`

### Stage 3 — Glue crawler ran and Athena has the CUR table

This is the most common failure point in customer accounts because each customer's
CUR bucket has a different prefix structure.

- [ ] Crawler state is `READY` and `LastCrawl.Status` is `SUCCEEDED`:
  ```bash
  aws glue get-crawler --name kostops-cur-crawler \
    --query 'Crawler.{State:State,LastCrawl:LastCrawl}' --output json
  ```
- [ ] Exactly one table named `data` exists in `kostops_cur` Glue database:
  ```bash
  aws glue get-tables --database-name kostops_cur \
    --query 'TableList[*].{Name:Name,Location:StorageDescriptor.Location}'
  ```
- [ ] Table location points to the parquet data prefix (not bucket root, not CSV files)
- [ ] Test Athena query returns rows:
  ```bash
  # Start query
  aws athena start-query-execution \
    --query-string "SELECT line_item_product_code, ROUND(SUM(line_item_unblended_cost),2) AS cost FROM kostops_cur.data GROUP BY 1 ORDER BY 2 DESC LIMIT 5" \
    --work-group kostops-workgroup

  # Check status (replace <id> with QueryExecutionId from above)
  aws athena get-query-execution --query-execution-id <id> \
    --query 'QueryExecution.Status.State'

  # Get results
  aws athena get-query-results --query-execution-id <id>
  ```

**If crawler creates wrong tables (CSV files, manifests, etc.):**
This should not happen with v1.1+ — the `CurPrefixDetector` Lambda automatically
finds the correct parquet prefix at deploy time. If you see wrong tables, it means
the detector Lambda failed. Check its logs:
```bash
aws logs tail /aws/lambda/kostops-cur-prefix-detector --since 1h
```
Common cause: no parquet files exist yet (CUR was just enabled — wait 24h for first delivery).

### Stage 4 — Agent deployed (`python scripts/deploy_agent.py`)

- [ ] Script exits with `KostOps agent deployed successfully!`
- [ ] AgentCore Runtime status is `READY`:
  ```bash
  aws bedrock-agentcore-control list-agent-runtimes \
    --query 'agentRuntimes[?agentRuntimeName==`kostopsVisibilityAgent`].status'
  ```
- [ ] Lambda `kostops-chat-handler` has `AGENT_RUNTIME_ARN` env var set

**If runtime fails with `RuntimeClientError: initialization time exceeded`:**
- The zip is missing Python dependencies — run `deploy_agent.py` (it bundles them automatically)
- Check the runtime uses ARM64-compatible wheels (the script uses `manylinux2014_aarch64`)

### Stage 5 — UI works end-to-end

- [ ] CloudFront URL opens the login page (no blank page / 403)
- [ ] Login with admin email + temporary password works
- [ ] Chat: type `"What are my top 3 AWS services by spend?"` — agent responds with real numbers
- [ ] Chat: type `"List my open findings"` — returns findings (may be empty on first run, that's OK)

**If chat returns "Failed to fetch":**
- Open browser DevTools → Network → look at the `/chat` API call → check response body
- Common causes: CORS (API Gateway stage not deployed), AGENT_RUNTIME_ARN not set, Cognito JWT expired

---

## Install — two commands, ~30 minutes

### Prerequisites

- AWS CLI configured for both payer and linked accounts
- Node.js 18+, Python 3.12+, uv (`curl -LsSf https://astral.sh/uv/install.sh | sh`)
- AWS CDK v2: `npm install -g aws-cdk`
- CUR already enabled in your payer account (Billing → Cost & Usage Reports → Exports)
  with Parquet format and Athena-compatible prefixes enabled

#### IAM permissions required

The AWS credentials used to run each CDK deploy must have sufficient permissions.
The simplest approach is `AdministratorAccess` on both accounts. If your organisation
requires least-privilege, the minimum permissions are:

**Payer account** (Step 1 — `KostOpsPayerStack`):
- `s3:PutBucketPolicy` — adds cross-account read policy to your existing CUR bucket
- `iam:CreateRole`, `iam:PutRolePolicy`, `iam:AttachRolePolicy`, `iam:PassRole`
- `ssm:PutParameter`
- `cloudformation:*` (CDK requires full CloudFormation access)
- `sts:GetCallerIdentity` (CDK bootstrap)

**Linked account** (Step 2 — `cdk deploy --all`):
- `cognito-idp:CreateUserPool`, `cognito-idp:CreateUserPoolClient`
- `s3:CreateBucket`, `s3:PutBucketPolicy`
- `athena:CreateWorkGroup`, `glue:CreateDatabase`, `glue:CreateCrawler`
- `dynamodb:CreateTable`
- `iam:CreateRole`, `iam:PutRolePolicy`, `iam:AttachRolePolicy`, `iam:PassRole`
- `bedrock:*` (AgentCore Runtime provisioning)
- `lambda:CreateFunction`, `lambda:AddPermission`
- `apigateway:*`
- `cloudfront:CreateDistribution`, `cloudfront:CreateOriginAccessControl`
- `ssm:PutParameter`, `ssm:GetParameter`
- `cloudformation:*`
- `sts:GetCallerIdentity`

### Step 1 — Run once in your payer account (~5 minutes)

```bash
git clone https://github.com/kostops/kostops
cd kostops
npm install

# Switch to payer account credentials
export AWS_PROFILE=my-payer-account

cdk --app "npx ts-node cdk/payer-app.ts" deploy KostOpsPayerStack \
  --context linkedAccountId=123456789012 \
  --context payerCurBucketName=my-existing-cur-bucket
```

This creates:
- A cross-account S3 bucket policy on `my-existing-cur-bucket` allowing the linked account to read CUR data directly (no replication)
- `kostops-cross-account-role` — IAM role trusted by the linked account agent
- SSM parameters `/kostops/payer/*` for the linked account deploy to read
- The final CDK output shows you the exact command to run next

### Step 2 — Run in your linked account (~10 minutes)

Copy the command from Step 1's output, or run:

```bash
# Switch to linked account credentials
export AWS_PROFILE=my-linked-account

cd frontend && npm install && npm run build && cd ..

cdk deploy --all \
  --context payerAccountId=987654321098 \
  --context payerCrossAccountRoleArn=arn:aws:iam::987654321098:role/kostops-cross-account-role \
  --context payerCurBucketName=my-existing-cur-bucket \
  --context adminEmail=you@yourcompany.com \
  --context slackWebhookUrl=https://hooks.slack.com/services/YOUR/WEBHOOK

python scripts/deploy_agent.py
```

### Step 3 — Open the UI

CDK outputs the URL at the end of deploy:

```
KostOpsFrontendStack.SiteUrl = https://d1234abcd.cloudfront.net
```

Log in with your admin email. Check your inbox for the temporary password.
Ask the agent: "What are my top savings opportunities?" to run the first scan.

## Destroying

```bash
# Linked account
cdk destroy --all

# Payer account
export AWS_PROFILE=my-payer-account
cdk --app "npx ts-node cdk/payer-app.ts" destroy KostOpsPayerStack
```

Note: The DynamoDB findings table uses `RemovalPolicy.RETAIN` — delete manually
to preserve findings history. The payer CUR bucket is not owned by KostOps and
will not be affected.

## Contributing

Open source under MIT. PRs welcome.
See CONTRIBUTING.md for how to add a new detection rule.

## Roadmap

### V2 — Multi-Agent + Cost Transparency

#### Proactive Daily Scan — Always-Populated Dashboard (CRITICAL)

**Current gap:** Findings only appear in DynamoDB when a user explicitly asks the
agent in chat. On first open, the UI dashboard is blank. Customers expect to see
recommendations immediately without typing anything.

**Fix:** A scheduled Lambda (`kostops-scan-handler`) that runs daily at 07:00 UTC
and proactively fetches all recommendations, writing them directly to DynamoDB.

```
EventBridge Scheduler (daily 07:00 UTC)
  └── kostops-scan-handler Lambda
        ├── Cost Optimization Hub → top 50 recommendations
        ├── Compute Optimizer     → over-provisioned EC2s
        ├── Cost Explorer         → active anomalies
        ├── EC2                   → unattached EBS volumes, old snapshots
        └── for each result → DynamoDB put_item()
              (idempotent: skip if identical finding already OPEN for same resource)
```

**Key design decisions:**
- Calls boto3 directly with payer credentials — no agent loop, no LLM cost, runs in <30s
- Idempotent: uses `resource_id + type` as dedup key so re-running never creates duplicates
- Agent chat still adds value on top: explains findings, ranks them, answers "why"
- First scan triggered at deploy time (same pattern as Glue crawler bootstrap)

**Implementation:**
- New `lambda/scan_handler.py`
- EventBridge Scheduler rule in `stacks/api-stack.ts`
- Deploy-time bootstrap: `AwsCustomResource` invoking the Lambda once immediately after deploy
- IAM: scan Lambda needs same payer cross-account role permissions as the agent

---

#### Multi-Agent Architecture (Super Agent + Sub-Agents)
Replace the single visibility agent with a **supervisor + specialist** model:

```
User
 └── Super Agent  (orchestrator — routes, synthesises, owns the session)
       ├── Visibility Agent   — spend analysis, trends, anomalies, CUR/Athena
       ├── Optimization Agent — savings recommendations, rightsizing, idle resources
       └── Remediation Agent  — executes approved fixes, tracks changes, rollback
```

- **Super Agent** receives every user message, decides which sub-agent(s) to invoke,
  aggregates their responses, and returns a single coherent answer.
  Built with Strands multi-agent delegation (`agent.tool` calling a sub-agent).
- **Visibility Agent** (extracted from v1): Cost Explorer, CUR/Athena, CloudWatch metrics.
- **Optimization Agent** (new): Compute Optimizer, rightsizing, Savings Plans, idle
  resource ranking. Returns ranked findings with estimated monthly savings.
- **Remediation Agent** (new): Executes safe remediations (stop instance, delete snapshot,
  resize) behind a human-approval gate. Every action is logged to DynamoDB with
  before/after state for rollback.

Each sub-agent deploys as its own **AgentCore Runtime** (independent scaling, separate
IAM roles with least-privilege per capability). The Super Agent runtime invokes them
via `invoke_agent_runtime`.

---

#### Cost of KostOps — Infrastructure Transparency

Show the cost to run KostOps as a first-class metric alongside the savings it surfaces.
This builds trust and lets customers judge ROI directly in the product.

**What to show:**
- Monthly infra cost of KostOps (Lambda, Fargate/AgentCore, CloudFront, S3, DynamoDB,
  Athena, CloudWatch, NAT).
- Breakdown by component: `ui`, `api`, `agent`, `storage`, `data`.
- Unit economics: cost per day, cost per 1,000 analyzed resources.
- ROI callout: "KostOps cost $42 this month, identified $1,400 in savings (33x ROI)."

**How to calculate it:**
- Tag all KostOps resources at deploy time: `App=Kostops`,
  `Component=ui|api|agent|storage`, `CustomerId=<account-id>`.
- CDK applies these tags via `cdk.Tags.of(app).add(...)` so every resource inherits them.
- New Athena tool `get_kostops_monthly_cost()` queries CUR directly: filters
  `resource_tags_user_app = 'Kostops'`, sums `line_item_unblended_cost` grouped by
  `product_service_name` and month.
- Results are cached in S3 (`kostops-athena-results-<account-id>`) automatically by
  Athena — same as every other cost query. No separate storage needed.
- DynamoDB is **not** used here — it is reserved for findings (records that need
  CRUD: create, status updates, get by ID). Self-cost is read-only spend data,
  so Athena + S3 is the right fit.

**Where to surface it in the UI:**
- **Header badge**: "KostOps infra: ~$X/mo" with info tooltip.
- **Overview card**: "This month: $X | Estimated annual: $Y".
- **Settings → KostOps Overhead page**:
  - Trend sparkline: cost last 3 months.
  - Service breakdown bar chart: Lambda, AgentCore, DB, S3, logs, data transfer.
  - Net value banner: "KostOps cost $42, enabled $1,400/month in identified savings."
  - Text: "Typical range for accounts your size: $30–$80/month."

#### Recommendations Page — Static View, Export, and Share

For customers who want a spreadsheet-style view of recommendations to review offline
or share with colleagues who don't have KostOps access.

**What it surfaces (always fresh, fetched live — not agent-dependent):**
- Compute Optimizer: rightsizing recommendations (EC2, EBS, Lambda, RDS)
- Cost Optimization Hub: cross-service recommendations ranked by savings
- Savings Plans: recommended hourly commitment + estimated monthly savings
- All sorted by estimated monthly savings, filterable by account / resource type

**Export CSV:** Downloads the full recommendations table as a CSV file directly
from the browser. No server-side storage — generated on demand.

**Send Report:** Emails a formatted HTML report + CSV attachment to any email
addresses the user enters. Uses SES. Useful for sending to a team lead or FinOps
analyst who doesn't log into KostOps.

**Implementation:**
- New `lambda/recommendations_handler.py`: calls Compute Optimizer, Cost Optimization
  Hub, and Savings Plans APIs directly with payer credentials (no agent loop — pure
  data fetch + format). Returns JSON, CSV string, or triggers SES email.
- New API routes: `GET /recommendations`, `GET /recommendations/export`,
  `POST /recommendations/send`
- New React page `/recommendations`: sortable/filterable table + Export CSV +
  Send Report buttons
- SES sender identity verified at deploy time via CDK

**What makes this different from Findings:**
Findings are tracked action items with a lifecycle (OPEN → RESOLVED). The
Recommendations page is a live snapshot — always current, not stored, designed
for sharing. Both complement each other: Recommendations for discovery and
sharing, Findings for tracking what you're actually working on.

---

### V3 — Reporting + Enterprise

#### Weekly Report
Automated weekly summary delivered to Slack and surfaced in the UI:
- **New findings this week** — what the agent discovered (type, resource, estimated savings)
- **Actions taken** — findings that moved from OPEN → RESOLVED this week
- **Savings realised** — sum of `estimatedMonthlySavings` for RESOLVED findings
- **Still open** — backlog ranked by savings, with age (days since created)
- **ROI line** — "This week: found $X in savings, resolved $Y, KostOps cost $Z"

Implementation notes:
- Add `resolvedAt` timestamp to findings when status → RESOLVED (findings_handler.py PATCH)
- New `lambda/weekly_report.py`: queries DynamoDB for findings created or resolved in last 7 days, formats report, sends to Slack
- EventBridge Scheduler: Mondays 08:00 UTC → weekly_report Lambda
- API route `POST /reports/weekly` for on-demand trigger from the UI
- Store each report as a DynamoDB item in `kostops-reports` table for historical viewing

#### Recommendations History and Trend — Hybrid S3 + Athena Approach

**Why history matters:** Today the Recommendations page is a live snapshot —
it tells you what's wrong *now* but not whether you're improving. Customers
want to see: "Last month I had 45 recommendations worth $12k. Now I have 28
worth $7k. I've resolved $5k of savings — are we trending in the right direction?"

**Architecture (hybrid):**

```
Layer 1 — Live (on-demand, API call, 4h S3 cache)
  Recommendations page current view
  → same as V2: Lambda calls APIs, caches in S3, returns in 2-3s
  → no change, no cost increase

Layer 2 — Historical (continuous S3 exports → Athena)
  Cost Optimization Hub  → AWS Data Exports → S3 daily parquet snapshots
  Compute Optimizer      → ExportEC2InstanceRecommendations → S3 (triggered weekly)
                           ↓
  Glue Crawler (separate from CUR crawler) → kostops_recommendations Glue database
                           ↓
  Athena views:
    recommendations_weekly_snapshot  — count + total savings per week
    recommendations_by_type          — breakdown by action type over time
    resolved_vs_open_trend           — how fast findings are being cleared
                           ↓
  UI trend charts (Recharts sparklines):
    "Total identified savings over last 13 weeks"
    "Recommendations resolved per week"
    "Savings realised vs identified — ROI trend"
```

**What gets stored in S3 (free AWS exports):**

| Source | Export format | Refresh | Contains |
|---|---|---|---|
| Cost Optimization Hub | Parquet via AWS Data Exports | Daily (continuous) | All recommendations, estimated savings, resource details |
| Compute Optimizer | Parquet export jobs | Weekly trigger via EventBridge | EC2/EBS/Lambda rightsizing with CPU metrics |

**Why this is better than pure API polling for history:**
- AWS exports are **free** — no API call cost per snapshot
- **Richer data** — exports include fields not available in the API (e.g. full utilisation metrics history)
- **Durable** — S3 retains months of snapshots automatically via lifecycle policy
- **Consistent with CUR** — same Glue + Athena pattern already in place, no new patterns to learn

**What stays on-demand (not exported):**
- Savings Plans recommendations — small, cheap API call, no export available
- Budgets — already free API, no history needed

**Implementation:**
- CDK: enable Cost Optimization Hub data export via `AwsCustomResource` at deploy time
- CDK: EventBridge weekly rule → Lambda triggers `compute-optimizer:ExportEC2InstanceRecommendations` to S3
- CDK: second Glue crawler for `s3://kostops-athena-results-<account>/recommendations-exports/`
- New Athena views for weekly snapshots and trend queries
- New API route `GET /recommendations/trend?weeks=13` → Athena query → chart data
- UI: trend sparklines on Recommendations page, exportable as part of CSV/email report

**Cost estimate:**
- AWS Data Exports (COH): free
- Compute Optimizer export Lambda: ~4 invocations/month = $0
- S3 storage: ~10MB/month of parquet snapshots = $0.0003/month
- Athena trend queries: KB scanned per query = effectively $0
- Glue crawler: ~4 runs/month = $0.01/month
- **Total added cost: < $0.05/month**

**UI trend views:**

```
Recommendations page (V3)
├── Current snapshot table (same as V2 — live, on-demand)
│
├── Trend panel (new)
│   ├── Sparkline: "Total savings opportunity — last 13 weeks"
│   ├── Bar chart: "Resolved vs open by week"
│   ├── Number: "Net savings realised this quarter: $X"
│   └── [Export trend data as CSV]
│
└── [Send report] — now includes trend data in email
```

#### Enterprise
- Multi-cloud (Azure Cost Management, GCP Billing)
- Enterprise policy engine (enforce tagging, budget guardrails)
- AWS Marketplace listing
- SSO / SAML federation
