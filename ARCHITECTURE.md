# KostOps — Technical Architecture (Level 300)

This document is the authoritative reference for engineers and architects who want to understand, debug, or extend KostOps. It covers internal design, data flows, AWS service integration patterns, and the reasoning behind key decisions.

For **deployment instructions** see `README.md`. For the **product roadmap** see the plans directory.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture Diagram](#2-architecture-diagram)
3. [AWS Services Reference](#3-aws-services-reference)
4. [CDK Stack Architecture](#4-cdk-stack-architecture)
5. [Data Pipeline — CUR to QuickSight](#5-data-pipeline--cur-to-quicksight)
6. [Agent Architecture — strands-agents + AgentCore](#6-agent-architecture--strands-agents--agentcore)
7. [Authentication & Security Model](#7-authentication--security-model)
8. [Slack Integration Architecture](#8-slack-integration-architecture)
9. [Frontend Architecture](#9-frontend-architecture)
10. [Architecture Decision Records](#10-architecture-decision-records)

---

## 1. System Overview

KostOps is an AI-native AWS FinOps platform that deploys entirely into a customer's own AWS account. It gives engineering and finance teams a conversational interface to their AWS Cost and Usage Report (CUR) data, surfaces ranked savings opportunities, and delivers proactive Slack alerts — all without any data leaving the customer's infrastructure.

**Core problem it solves:** CUR data is stored as raw Parquet in an S3 bucket in the payer (management) account. It is complex to query, requires Athena expertise, and is inaccessible to engineers in linked accounts who need cost insights. AWS Cost Explorer answers simple questions but cannot support ad-hoc analysis or natural language queries.

**Two-account model:**
- **Payer account** — where AWS delivers CUR Parquet files to S3. KostOps adds a cross-account S3 bucket policy and an IAM role here. Nothing else runs in the payer account.
- **Linked / management account** — where KostOps is fully deployed (all 5 CDK stacks, all Lambda functions, the React frontend, the AI agent). The Glue crawler in this account reads the payer CUR bucket directly via the cross-account policy — no replication.

---

## 2. Architecture Diagram

```
┌─────────────────────────────────┐    ┌──────────────────────────────────────────────────────┐
│       PAYER ACCOUNT             │    │         LINKED / MANAGEMENT ACCOUNT                  │
│                                 │    │                                                      │
│  S3 (CUR Parquet)               │    │  ┌──────────────┐    ┌──────────┐   ┌─────────────┐ │
│  └─ BILLING_PERIOD=YYYY-MM/     │◄───┼──│ Glue Crawler │───►│  Athena  │──►│  QuickSight │ │
│     *.parquet                   │    │  │ (daily 06:00)│    │ Workgroup│   │  (SPICE)    │ │
│                                 │    │  └──────────────┘    └──────────┘   └──────┬──────┘ │
│  kostops-cross-account-role     │    │         │                                  │embed   │
│  ├─ ce:GetCostAndUsage          │◄───┼──────────┘  sts:AssumeRole                │URL     │
│  ├─ budgets:ViewBudget          │    │                                            ▼        │
│  ├─ compute-optimizer:Get*      │    │  ┌──────────────────────────────────────────────┐   │
│  └─ s3:GetObject (CUR bucket)   │    │  │  AgentCore Runtime (kostopsVisibilityAgent)  │   │
│                                 │    │  │  strands-agents loop + tools/*.py            │   │
└─────────────────────────────────┘    │  │  Claude Sonnet (Bedrock inference profile)  │   │
                                       │  └───────────────┬──────────────────────────────┘   │
                                       │                  │InvokeAgentRuntime                │
                                       │  ┌───────────────▼──────────────────────────────┐   │
                                       │  │  API Gateway (REST)  /prod                   │   │
                                       │  │  Cognito JWT authorizer on all routes        │   │
                                       │  │  except POST /slack/command (HMAC auth)      │   │
                                       │  └─┬────────────────────────────────────────────┘   │
                                       │    │                                                 │
                                       │  Lambda functions (Python 3.12)                     │
                                       │  ├─ chat-handler (300s timeout)                     │
                                       │  ├─ findings-handler (30s)                          │
                                       │  ├─ slack-handler (60s)                             │
                                       │  ├─ slack-command-handler (300s, self-invokes)       │
                                       │  ├─ integrations-handler (30s)                      │
                                       │  ├─ dashboard-handler (120s)                        │
                                       │  ├─ chat-sessions-handler (30s)                     │
                                       │  └─ keepwarm-handler (35s, every 5 min)             │
                                       │                  │                                  │
                                       │  DynamoDB (PAY_PER_REQUEST, AES-256 at rest)        │
                                       │  ├─ kostops-findings       (findings + GSIs)         │
                                       │  ├─ kostops-integrations   (Slack/Jira config)       │
                                       │  └─ kostops-conversations  (chat history, 30d TTL)  │
                                       │                                                      │
                                       │  React SPA ──── CloudFront ──── S3 (frontend)        │
                                       │  AWS Amplify (Cognito auth)                         │
                                       │                                                      │
                                       │  Slack: Incoming Webhook (digest) + slash commands  │
                                       └──────────────────────────────────────────────────────┘
```

---

## 3. AWS Services Reference

| Service | CDK Stack | Purpose | Key Configuration |
|---------|-----------|---------|-------------------|
| **Cognito User Pool** (`kostops-user-pool`) | AuthStack | User authentication for React SPA and API Gateway | `selfSignUpEnabled: false` (admin-only), SRP auth flow, 12-char min password, 1h token expiry, 30d refresh token |
| **API Gateway REST** (`kostops-api`) | ApiStack | HTTP entry point for all client requests | Stage: `prod`, throttle 100 RPS / 200 burst, Cognito authorizer on all routes except `/slack/command`, CORS ALL_ORIGINS (tightened at CloudFront) |
| **Lambda** | ApiStack, AgentStack | 9 function handlers (see §6, §8) | Python 3.12, shared execution role, structured CloudWatch logging, 2-week log retention (3 days for keepwarm) |
| **DynamoDB** (3 tables) | DataStack | Findings, integrations, conversation history | PAY_PER_REQUEST billing, AWS-managed encryption, PITR enabled on findings table, TTL on findings (30d) and conversations (30d) |
| **Glue Crawler** (`kostops-cur-crawler`) | DataStack | Discovers CUR Parquet schema and Hive partitions | Runs daily at 06:00 UTC, also triggered once at deploy time via `CrawlerBootstrap` custom resource, reads payer S3 cross-account |
| **Glue Database** (`kostops_cur`) | DataStack | Metadata store for Athena CUR table | Points at payer S3 bucket prefix (auto-detected by `cur_prefix_detector.py`) |
| **Athena Workgroup** (`kostops-workgroup`) | DataStack | Isolated query execution for CUR analysis | `enforceWorkGroupConfiguration: true`, 10 GB scan hard limit per query (cost guard), SSE_S3 result encryption, 7-day results lifecycle |
| **S3 — Athena results** (`kostops-athena-results-{account}`) | DataStack | Stores Athena query output files | Private, SSE, 7-day lifecycle, `DESTROY` removal policy |
| **S3 — Frontend** | FrontendStack | Hosts the built React SPA | Private (OAC), static website not enabled — served only via CloudFront |
| **CloudFront** | FrontendStack | CDN for React SPA with HTTPS | OAC to S3, default root object `index.html`, SPA routing via error page redirect |
| **AgentCore Runtime** (`kostopsVisibilityAgent-*`) | AgentStack (custom resource) | Managed runtime for the strands-agents AI agent | Created/updated by `agentcore_deploy.py` Lambda at CDK deploy time; ARN written to SSM and Lambda env vars |
| **Bedrock** (inference profiles) | AgentStack (agent role) | Claude model inference | Cross-region inference profiles (e.g. `us.anthropic.claude-sonnet-4-5-20250929-v1:0`); region prefix auto-selected from deploy region |
| **S3 — CDK Assets** | AgentStack | Stores the agent zip (strands-agents + tools) | Managed by CDK; bundled locally at deploy time via `AgentCodeBundler.tryBundle()` |
| **QuickSight** (optional) | QuickSightStack | SPICE-powered interactive dashboards | Requires Enterprise subscription + Session Capacity Pricing; enabled with `--context installQuickSight=true`; 6 dashboards (billing-summary, compute, storage, ai-ml, commitments, rightsizing) |
| **SSM Parameter Store** | Multiple stacks | Runtime config and secrets | See SSM parameter table in §7 |
| **EventBridge** | ApiStack | Scheduled triggers | Two rules: `kostops-agent-keepwarm` (every 5 min) and `kostops-slack-daily-digest` (Mon-Fri 09:00 UTC) |
| **IAM** | All stacks | Least-privilege execution roles | Agent role, API Lambda role, Glue crawler role, AgentCore deploy role — all separate with scoped policies |
| **CloudWatch Logs** | All Lambdas | Structured logging and metrics | API Gateway access logs, Lambda function logs, Athena workgroup metrics. Default 2-week retention. |

---

## 4. CDK Stack Architecture

### Stack Dependency Order

```
KostOpsPayerStack  ─── deployed separately in payer account, no deps
       (no CDK deps on linked stacks)

KostOpsAuthStack   ─── 1st (no dependencies)
       │
       ├──▶ KostOpsDataStack  ─── 2nd (no CDK deps, but logically after Auth)
       │           │
       │           └──▶ KostOpsAgentStack  ─── 3rd (needs DataStack outputs + AuthStack deployed)
       │                       │
       │                       └──▶ KostOpsApiStack  ─── 4th (needs Agent + Auth + Data)
       │                                   │
       │                                   └──▶ KostOpsFrontendStack  ─── 5th (needs API URL + Cognito IDs)
       │                                               │
       │                                               └──▶ KostOpsQuickSightStack  ─── optional, after Api
```

`app.ts` lines 65–93 encode these dependencies explicitly via `addDependency()`.

### Stack Responsibilities

#### `KostOpsPayerStack` (`stacks/payer-stack.ts`)
Deployed once, in the **payer account**. Run with a separate `payer-app.ts` CDK entry.

Resources created:
- S3 bucket policy on the **existing** CUR bucket — adds `AllowLinkedAccountKostOpsRead` statement that grants the linked account `s3:GetObject` + `s3:ListBucket`. Uses `AwsCustomResource` (not `BucketPolicy`) because CloudFormation refuses to create a bucket policy over an existing one on an unmanaged bucket.
- IAM role `kostops-cross-account-role` — trusted by the linked account (`AccountPrincipal`). Has read-only permissions for Cost Explorer, Compute Optimizer, Budgets, Cost Optimization Hub, and Organizations.
- SSM parameters `/kostops/payer/cur-bucket-name` and `/kostops/payer/cross-account-role-arn` so the linked account deploy can read them.

On stack delete: the custom resource restores the original billing-service-only bucket policy.

#### `KostOpsAuthStack` (`stacks/auth-stack.ts`)
- Cognito User Pool `kostops-user-pool` — `selfSignUpEnabled: false`, email sign-in, SRP auth flow, admin invitation email template.
- User Pool Client `kostops-web-client` — no client secret (browser app), SRP auth, 1h token validity.
- Admin user created on first deploy if `adminEmail` context is set. Uses `RETAIN` removal policy so password resets survive stack updates.

Outputs: `UserPoolId`, `UserPoolClientId` — consumed by FrontendStack for `runtime-config.json`.

#### `KostOpsDataStack` (`stacks/data-stack.ts`)
- **Athena results S3 bucket** — `kostops-athena-results-{account}`, private, 7-day lifecycle.
- **Athena workgroup** `kostops-workgroup` — enforced result location and 10 GB scan limit.
- **CUR prefix auto-detection** — `cur_prefix_detector.py` Lambda runs as CloudFormation custom resource (`CREATE` + `UPDATE`). Lists objects in the payer CUR bucket to find the first key matching `BILLING_PERIOD=` Hive partition pattern. Writes the detected prefix to the Glue crawler config and SSM `/kostops/cur-prefix`.
- **Glue database** `kostops_cur` — points at detected prefix in payer S3.
- **Glue crawler** `kostops-cur-crawler` — daily schedule (06:00 UTC). `CrawlerBootstrap` custom resource starts it once at deploy so initial schema is available immediately.
- **3 DynamoDB tables:**
  - `kostops-findings` — PK: `findingId`, SK: `createdAt`. GSIs: `status-index` and `type-index`. PITR enabled. TTL: 30 days. `RETAIN` on destroy.
  - `kostops-integrations` — PK: `pk` (e.g. `INTEGRATION#slack`), SK: `sk` (`CONFIG`). Stores non-secret integration metadata. `RETAIN`.
  - `kostops-conversations` — PK: `userId` (Cognito sub), SK: `sessionId`. JSON-encoded messages array. TTL: 30 days. `DESTROY` on stack delete.

#### `KostOpsAgentStack` (`stacks/agent-stack.ts`)
The most complex stack. Creates the AI agent runtime through a custom resource lifecycle.

**Step 1 — Agent code bundle (at CDK synth/deploy time):**
`AgentCodeBundler.tryBundle()` (local, no Docker) runs:
1. `pip install strands-agents bedrock-agentcore` into outputDir targeting `manylinux2014_aarch64` Python 3.12
2. Strips packages that cause >30s cold-start (`pydantic_core`, `bedrock_agentcore`, Starlette, etc.)
3. Copies `visibility_agent.py`, `payer_role.py`, `tools/`, `mcp/`, `strands/` (local stub overrides the real strands-agents package to avoid heavy imports)
4. CDK zips outputDir → uploads to CDK assets S3 bucket

**Step 2 — AgentCore Runtime (at CloudFormation deploy time):**
`agentcore_deploy.py` Lambda (custom resource) calls AgentCore control-plane APIs:
- `CreateAgentRuntime` with agent name, IAM role ARN, S3 code location
- Polls `GetAgentRuntime` until status is `ACTIVE` (up to 12 min)
- Writes runtime ARN to SSM `/kostops/agent-runtime-arn`
- Updates `AGENT_RUNTIME_ARN` env var on `kostops-chat-handler` and `kostops-slack-command-handler`

On `UPDATE`: deletes old runtime, creates new one (no `UpdateAgentRuntime` API due to botocore shape issues).

**Agent IAM role** (`kostops-agent-role`):
- Bedrock: `InvokeModel` + `InvokeModelWithResponseStream` on `anthropic.claude-*` foundation models across 9 regions + cross-region inference profile ARNs
- STS: `AssumeRole` on `kostops-cross-account-role` (payer account)
- Billing APIs: Cost Explorer, Compute Optimizer, Budgets, Cost Optimization Hub
- CloudWatch: GetMetricData for idle EC2 detection
- Athena + Glue: query execution
- S3: read payer CUR bucket, read/write Athena results bucket
- EC2: describe-only (instance/volume/snapshot/tag discovery)
- DynamoDB: read/write `kostops-findings` table

#### `KostOpsApiStack` (`stacks/api-stack.ts`)
All 9 Lambda functions share a single IAM execution role with scoped policies.

**Lambda functions:**

| Function name | Handler | Timeout | Memory | Purpose |
|---|---|---|---|---|
| `kostops-chat-handler` | `chat_handler.handler` | 300s | 256 MB | Proxies chat to AgentCore Runtime, stores conversation in DynamoDB |
| `kostops-chat-sessions-handler` | `chat_sessions_handler.handler` | 30s | 128 MB | `GET /chat/sessions` — list and retrieve chat history |
| `kostops-findings-handler` | `findings_handler.handler` | 30s | 128 MB | CRUD for findings table (`GET`, `PATCH` status) |
| `kostops-slack-handler` | `slack_handler.handler` | 60s | 128 MB | Daily digest + anomaly alerts via Slack webhook |
| `kostops-slack-command-handler` | `slack_command_handler.handler` | 300s | 256 MB | `/kostops` slash command — HMAC verify → ACK → async self-invoke → agent → reply |
| `kostops-integrations-handler` | `integrations_handler.handler` | 30s | 128 MB | `GET/PUT/DELETE/POST` for `/integrations/{name}` |
| `kostops-dashboard-handler` | `dashboard_handler.handler` | 120s | 128 MB | `GET /dashboard/monthly-spend` — Athena-backed spend data |
| `kostops-keepwarm-handler` | `keepwarm_handler.handler` | 35s | 128 MB | Sends no-op to AgentCore every 5 min to prevent cold-start |
| `kostops-agentcore-deploy` | `agentcore_deploy.handler` | 15 min | 256 MB | CDK custom resource for AgentCore Runtime lifecycle |

**API Gateway routes:**
```
POST   /chat                       → chat-handler            (Cognito auth)
GET    /chat/sessions              → chat-sessions-handler   (Cognito auth)
GET    /chat/sessions/{sessionId}  → chat-sessions-handler   (Cognito auth)
GET    /findings                   → findings-handler        (Cognito auth)
GET    /findings/{id}              → findings-handler        (Cognito auth)
PATCH  /findings/{id}              → findings-handler        (Cognito auth)
POST   /slack/digest               → slack-handler           (Cognito auth)
POST   /slack/command              → slack-command-handler   (NO auth — Slack HMAC)
GET    /integrations               → integrations-handler    (Cognito auth)
GET    /integrations/{name}        → integrations-handler    (Cognito auth)
PUT    /integrations/{name}        → integrations-handler    (Cognito auth)
DELETE /integrations/{name}        → integrations-handler    (Cognito auth)
POST   /integrations/{name}/{action} → integrations-handler (Cognito auth)
GET    /dashboard/monthly-spend    → dashboard-handler       (Cognito auth)
GET    /dashboard/quicksight-url   → quicksight-embed-handler (Cognito auth, if QS installed)
```

**EventBridge rules (also in ApiStack):**
- `kostops-agent-keepwarm` — rate 5 minutes → `keepwarm-handler`
- `kostops-slack-daily-digest` — cron `0 9 * * MON-FRI` → `slack-handler`

#### `KostOpsFrontendStack` (`stacks/frontend-stack.ts`)
- Builds React app at CDK deploy time: `npm ci && vite build` inside `frontend/` directory
- Deploys `frontend/dist/` to a private S3 bucket
- Creates CloudFront distribution with OAC pointing to the bucket
- **Key design:** custom resource writes `/runtime-config.json` to S3 after the build. This file contains real `userPoolId`, `userPoolClientId`, `apiUrl` values. The React app fetches this at startup — no config is baked into the JS bundle.

#### `KostOpsQuickSightStack` (`stacks/quicksight-stack.ts`)
Optional — enabled with `--context installQuickSight=true`.
- Custom resource calls `quicksight_setup_handler.py` which creates: Athena views, SPICE datasets, 6 dashboards
- `quicksight_embed_handler.py` Lambda added to ApiStack: `GET /dashboard/quicksight-url?dashboard=<key>` → 60-min signed embed URL via `GenerateEmbedUrlForRegisteredUser`

---

## 5. Data Pipeline — CUR to QuickSight

### Step-by-step Flow

```
1. AWS billing service writes CUR Parquet daily to payer S3:
   s3://<payer-cur-bucket>/<report-name>/data/BILLING_PERIOD=YYYY-MM/<uuid>.parquet

2. KostOps deploy → cur_prefix_detector.py Lambda:
   - Lists objects in payer bucket (cross-account s3:ListBucket)
   - Finds first key matching regex /BILLING_PERIOD=\d{4}-\d{2}/
   - Extracts prefix up to the Hive partition directory
   - Stores result in Glue crawler target path

3. Glue Crawler (kostops-cur-crawler):
   - Runs daily 06:00 UTC + once at deploy time
   - Reads Parquet headers cross-account (sts:AssumeRole not needed — S3 bucket policy grants s3:GetObject to linked account root)
   - Creates/updates Glue table 'data' in database 'kostops_cur'
   - Stores column names, types, and BILLING_PERIOD partitions in Glue Data Catalog

4. Athena (kostops-workgroup):
   - Queries Glue Data Catalog to locate table 'kostops_cur.data'
   - Reads Parquet directly from payer S3 cross-account
   - Results written to kostops-athena-results-{account}/results/ (7-day lifecycle)
   - 10 GB scan hard limit enforced by workgroup

5. QuickSight (optional):
   - quicksight_setup_handler.py creates Athena data sources pointing at kostops-workgroup
   - Creates summary_view, compute_view, storage_view as Athena named queries
   - Creates SPICE datasets from each view (ingestion is triggered once at setup)
   - Creates 6 dashboards with CategoryFilter controls (SelectAllOptions: FILTER_ALL_VALUES)

6. Embed flow (React UI):
   React → GET /dashboard/quicksight-url?dashboard=billing-summary
         → quicksight_embed_handler.py → GenerateEmbedUrlForRegisteredUser (60-min TTL)
         → React renders <iframe src={embedUrl}> full-bleed
```

### Why `billing_period` (STRING) not `usage_date` (DATETIME) for filters

CUR data ends 30-60 days before the current date because AWS needs time to process all linked account charges. A `RelativeDatesFilter` set to "last 3 months" calculates backwards from today — from April 2026 that means January–March, but CUR data may only reach February 2026.

Using `CategoryFilter` on `billing_period` (STRING format `YYYY-MM`) with `SelectAllOptions: FILTER_ALL_VALUES` shows all months present in the data regardless of today's date. This is more reliable and intuitive for billing dashboards.

### Athena View Design

Views (`summary_view`, `compute_view`, `storage_view`) denormalize the raw CUR table into clean analytic schemas. Key columns in every view:

| Column | Source CUR Column | Notes |
|--------|-------------------|-------|
| `billing_period` | `DATE_FORMAT(line_item_usage_start_date, '%Y-%m')` | STRING, used for X-axis and filter |
| `usage_date` | `CAST(line_item_usage_start_date AS DATE)` | DATE, for day-level views |
| `linked_account_id` | `line_item_usage_account_id` | For multi-account filtering |
| `product_name` | `product_servicecode` | Human-readable service name |
| `region` | `product_region_code` | AWS region |
| `charge_type` | `line_item_line_item_type` | Usage, Tax, Credit, Refund |
| `unblended_cost` | `ROUND(SUM(line_item_unblended_cost), 4)` | Aggregated to 4 decimal places |

All views exclude `Credit`, `Refund`, `Tax` charge types by default (configurable via filter controls in QuickSight).

---

## 6. Agent Architecture — strands-agents + AgentCore

### Invocation Path

```
React Chat UI
    │ POST /chat  {message: "What's my EC2 spend this month?", sessionId: "uuid"}
    ▼
API Gateway (Cognito JWT validated by authorizer before Lambda invokes)
    ▼
chat_handler.py (Lambda, 300s timeout, 256 MB)
    │ bedrock_agentcore.InvokeAgentRuntime(
    │   agentRuntimeId=...,
    │   sessionId=sessionId,
    │   inputText=message
    │ )
    ▼
AgentCore Runtime (kostopsVisibilityAgent-*)
    │ Manages: conversation history, streaming, retry-on-throttle
    │ Injects: system prompt + previous turns + new user message
    ▼
Claude Sonnet (Bedrock cross-region inference profile)
    │ Reasoning: decides which tool(s) to call
    │ Returns: tool_use block(s)
    ▼
strands-agents tool loop (runs inside AgentCore Runtime process)
    │ Dispatches tool calls to @tool-decorated functions
    │
    ├── tools/athena_tools.py
    │   └── run_athena_query(sql, workgroup) → Athena StartQueryExecution + poll GetQueryResults
    │
    ├── tools/billing_tools.py
    │   └── get_cost_and_usage(start, end, granularity, group_by) → Cost Explorer API
    │       (via sts:AssumeRole on kostops-cross-account-role in payer)
    │
    ├── tools/ec2_tools.py
    │   └── get_idle_ec2_instances() → DescribeInstances + CloudWatch GetMetricStatistics (CPU 14d)
    │
    ├── tools/findings_tools.py
    │   └── create_finding / list_findings / update_finding → DynamoDB PutItem / Query / UpdateItem
    │
    └── tools/optimization_tools.py
        └── calculate_savings() → pure Python, no AWS calls
    │
    ▼
Claude assembles final text response from tool outputs
    ▼
AgentCore streams response chunks back to chat_handler.py
    ▼
chat_handler.py stores full conversation in kostops-conversations DynamoDB table
    ▼
Response returned to React via API Gateway
```

### Tool Design Pattern

All tools use the strands-agents `@tool` decorator which auto-generates the JSON schema from Python type hints and docstrings:

```python
@tool
def get_monthly_costs(months: int = 3) -> str:
    """Get total AWS cost breakdown by service for the last N months."""
    # implementation...
    return json.dumps(results)  # always returns string
```

The decorator extracts the function name, parameter types, and docstring to create a Bedrock-compatible tool specification. Return type is always `str` — the agent includes tool output in the next model call's context.

When a tool fails, it returns an error string (e.g. `"Error: AccessDenied calling Cost Explorer. Check cross-account role setup."`). The agent can then explain the failure or suggest a workaround rather than crashing silently.

### Cold-Start Mitigation

AgentCore Runtime containers shut down after ~5 minutes of inactivity. Without mitigation, the first chat message after idle hits a 30s initialization delay.

`keepwarm_handler.py` is invoked every 5 minutes by an EventBridge rule. It calls `InvokeAgentRuntime` with the message `__keepwarm__`. The agent's system prompt recognizes this string and returns immediately without calling any tools. Net result: first-message latency stays under 3 seconds.

### Agent Code Bundling

The agent zip must contain all Python dependencies that the AgentCore Runtime does not provide. The bundling process (in `AgentCodeBundler.tryBundle()`):

1. `pip install strands-agents bedrock-agentcore` targeting `manylinux2014_aarch64` Python 3.12 (AgentCore's runtime architecture)
2. Strip packages to keep zip under 50 MB and cold-start init under 30s:
   - `pydantic_core` (4.1 MB ARM64 `.so` — causes 30s+ `dlopen()` timeout)
   - `starlette`, `uvicorn`, `httpx`, `anyio` (web frameworks not needed — agent uses stdlib HTTP server)
   - `strands`, `strands_agents` (replaced by local `strands/` stub — avoids telemetry and model imports)
   - `bedrock_agentcore` (AgentCore runtime pre-installs its own copy)
3. Copy source files: `visibility_agent.py`, `payer_role.py`, `tools/`, `mcp/`, `strands/`
4. The local `strands/__init__.py` provides a no-op `@tool` decorator, saving ~8 MB

`boto3`/`botocore` are **not** removed — AgentCore does not pre-install them, and removing them would cause silent import failures.

### AgentCore ARN Stability

AgentCore Runtime ARN changes on every `CreateAgentRuntime` call (each deploy gets a new ARN). Two mechanisms ensure handlers always have the current ARN:

1. `agentcore_deploy.py` calls `lambda:UpdateFunctionConfiguration` on both `kostops-chat-handler` and `kostops-slack-command-handler` after every deploy to update the `AGENT_RUNTIME_ARN` env var.
2. Both handlers also read SSM `/kostops/agent-runtime-arn` at invocation time as a fallback (in case the env var is stale from a partial deploy).

---

## 7. Authentication & Security Model

### Cognito JWT Auth Flow

```
React (Amplify Auth)
    │ 1. User submits email + password
    ▼
Cognito (SRP protocol — password never sent in plaintext)
    │ 2. Returns: idToken (JWT, 1h), accessToken (JWT, 1h), refreshToken (30d)
    ▼
React stores tokens in memory (Amplify manages refresh automatically)
    │
    │ 3. Every API call: Authorization: Bearer <idToken>
    ▼
API Gateway Cognito Authorizer
    │ 4. Validates: iss (Cognito JWKS endpoint), aud (User Pool Client ID), exp
    │ 5. Rejects 401 if invalid — Lambda never invokes
    ▼
Lambda receives request with Cognito claims in requestContext.authorizer.claims
    (no auth code in Lambda needed)
```

### Cross-Account IAM Trust Model

```
Lambda / AgentCore (linked account)
    │
    │ sts:AssumeRole
    ▼
kostops-cross-account-role (payer account)
    Trust policy: AccountPrincipal(linkedAccountId)
    — Any IAM principal in the linked account can assume this role
    — The restriction is enforced on the linked side: only kostops-agent-role
      has sts:AssumeRole permission on this ARN
    │
    │ Returns: temporary credentials (1h session)
    ▼
Cost Explorer, Compute Optimizer, Budgets, Organizations APIs
(all return consolidated payer data)
```

**Why `AccountPrincipal` not `ArnPrincipal`:** The payer stack deploys before the agent stack, so the agent role ARN doesn't exist yet. Using account-level trust avoids a chicken-and-egg circular dependency.

### Slack HMAC Verification

`slack_command_handler.py` verifies every inbound request before processing:

```python
# 1. Parse timestamp from header
ts = request_headers['X-Slack-Request-Timestamp']
if abs(time.time() - int(ts)) > 300:
    return 403  # replay attack — reject requests older than 5 minutes

# 2. Build base string
base = f"v0:{ts}:{raw_body}"

# 3. HMAC-SHA256 with signing secret
expected = 'v0=' + hmac.new(signing_secret, base, sha256).hexdigest()

# 4. Constant-time comparison (prevents timing attacks)
if not hmac.compare_digest(expected, request_headers['X-Slack-Signature']):
    return 403
```

The signing secret is stored in SSM SecureString `/kostops/integrations/slack-signing-secret` (not in environment variables or code).

### SSM Parameter Store Usage

| Parameter | Type | Set by | Read by | Purpose |
|---|---|---|---|---|
| `/kostops/agent-runtime-arn` | String | `agentcore_deploy.py` (after each deploy) | `chat_handler.py`, `slack_command_handler.py` | Current AgentCore Runtime ARN (changes on each deploy) |
| `/kostops/agentcore-config` | String | AgentStack CDK | Manual debugging | Human-readable agent config snapshot |
| `/kostops/cur-prefix` | String | `cur_prefix_detector.py` | Glue crawler config | Auto-detected CUR S3 prefix |
| `/kostops/payer/cur-bucket-name` | String | PayerStack | Linked account CDK deploy | CUR bucket name without cross-account console access |
| `/kostops/payer/cross-account-role-arn` | String | PayerStack | Linked account CDK deploy | Cross-account role ARN |
| `/kostops/integrations/slack-webhook-url` | SecureString | Integrations handler (user via UI) | `slack_handler.py` | Slack Incoming Webhook URL |
| `/kostops/integrations/slack-signing-secret` | SecureString | Integrations handler (user via UI) | `slack_command_handler.py` | Slack app signing secret for HMAC |

---

## 8. Slack Integration Architecture

KostOps has two independent Slack integration flows.

### Flow 1: Daily Digest (Push)

```
EventBridge cron (Mon–Fri, 09:00 UTC)
    │
    ▼
kostops-slack-handler Lambda (60s timeout)
    │ 1. Queries Cost Explorer for last 7 days top services
    │ 2. Queries DynamoDB for OPEN findings count + top savings opportunity
    │ 3. Checks for anomalies via Cost Explorer GetAnomalies
    │
    ▼
Slack Incoming Webhook POST (webhook URL from SSM SecureString)
    │ Block Kit message: summary table + findings callout + link to UI
    ▼
Slack channel
```

Also triggered manually via `POST /slack/digest` from the UI (settings page).

### Flow 2: Slash Command `/kostops` (Interactive)

Slack imposes a **3-second response deadline** for slash commands. The agent call takes 8–30 seconds. Solution: immediate ACK → async self-invoke → post result via `response_url`.

```
User types /kostops what's my biggest cost this month?
    │
    ▼
Slack HTTP POST to API Gateway /slack/command (3s deadline)
    │
    ▼
kostops-slack-command-handler Lambda (sync invocation, must respond <3s)
    │ 1. Verify Slack HMAC signature (< 100ms)
    │ 2. Return HTTP 200 with ACK body:
    │    {"response_type": "ephemeral",
    │     "text": "⏳ Analysing your AWS cost data, this may take a few seconds…"}
    │ 3. Self-invoke async:
    │    lambda.invoke(
    │      FunctionName=self,
    │      InvocationType='Event',   ← fire-and-forget
    │      Payload={mode:'async', text:..., response_url:...}
    │    )
    ▼ (ACK returned to Slack in < 1s — satisfies 3s deadline)

    ┌─ Async self-invocation (separate Lambda execution, up to 300s) ─┐
    │                                                                  │
    │ kostops-slack-command-handler Lambda (async leg)                 │
    │   │ 1. Read AGENT_RUNTIME_ARN from env (or SSM fallback)        │
    │   │ 2. InvokeAgentRuntime with user's question                  │
    │   │    (full strands-agents tool loop — 8-30s)                  │
    │   │ 3. POST result to response_url (valid for 30 min):          │
    │   │    {"response_type": "in_channel", "text": agent_answer}    │
    │   ▼                                                              │
    │  Slack channel shows the agent's answer                         │
    └──────────────────────────────────────────────────────────────────┘
```

**Why self-invoke instead of SQS/SNS:** Self-invoke adds zero infrastructure overhead and no cold-start for the async leg (same warm container pool). SQS would add polling Lambda cost + queue management. At current scale (< 100 commands/day), self-invoke is optimal.

**`lambda:InvokeFunction` on itself** is an explicit IAM permission added to `slackCommandHandler` in `api-stack.ts` (line 194):
```typescript
slackCommandHandler.addToRolePolicy(new iam.PolicyStatement({
  sid:       'SelfInvoke',
  actions:   ['lambda:InvokeFunction'],
  resources: [slackCommandHandler.functionArn],
}));
```

**Slack app reinstall requirement:** After adding or modifying a slash command's Request URL in the Slack app config, the app must be **reinstalled to the workspace** for changes to take effect. The `/kostops` command will not appear in the Slack command picker until reinstall completes.

---

## 9. Frontend Architecture

### Runtime Config Pattern

KostOps uses a runtime configuration approach instead of build-time environment variables. This is the most important frontend design decision.

**Problem with build-time env (`.env`):** Vite bakes `VITE_USER_POOL_ID` etc. into the JS bundle. Any change to Cognito or API URL requires a full `npm run build` and redeploy.

**KostOps approach:**
1. `vite build` runs without any AWS-specific values — the bundle is identical for all environments
2. `FrontendStack` custom resource writes `/runtime-config.json` to the S3 bucket after the build, containing the actual Cognito IDs and API URL
3. `runtimeConfig.ts` fetches this JSON at React app startup (`fetch('/runtime-config.json')`)
4. `amplifyConfig` is populated dynamically before `Amplify.configure()` is called

Result: config changes (new API URL, new Cognito pool) = update `/runtime-config.json` in S3. No rebuild needed.

### Component Architecture

```
App.tsx  (React Router v6)
│
├── AppShell.tsx
│   ├── SidebarNav.tsx          ← reads nav/config.ts for section/item structure
│   └── HeaderActions.tsx       ← user menu, sign-out button
│
└── Routes:
    │
    ├── /visibility/billing-summary   → EmbedPage  dashboard="billing-summary"
    ├── /visibility/compute           → EmbedPage  dashboard="compute"
    ├── /visibility/storage           → EmbedPage  dashboard="storage"
    ├── /visibility/ai-ml             → EmbedPage  dashboard="ai-ml"
    │
    ├── /optimization/coverage-commitments → EmbedPage  dashboard="commitments"
    ├── /optimization/rightsizing          → EmbedPage  dashboard="rightsizing"
    │
    ├── /assistant/chat          → Chat.tsx         (chat interface, session management)
    ├── /findings/*              → Findings.tsx     (list + detail + status update)
    └── /settings/integrations   → Integrations.tsx (Slack, Jira, webhook config)
```

### `EmbedPage.tsx` — Parameterized QuickSight Embed

A single component handles all 6 QuickSight dashboards. Key behaviours:
- `useEffect` dep array includes `dashboard` prop → re-fetches embed URL on navigation between dashboards
- Refresh timer cleared on dashboard change to avoid stale 55-minute refresh firing after navigation
- Full-bleed iframe using negative margin overrides: `-mx-6 -my-6 md:-mx-8 md:-my-7`
- Height: `calc(100vh - 3.25rem)` subtracts the fixed header
- Three states: `loading` (spinner), `not-configured` (QuickSight stack not installed), `error` (failed to fetch URL)

### Navigation Config (`nav/config.ts`)

Centralised nav structure consumed by `SidebarNav.tsx`. Adding a new page = add an entry here + a route in `App.tsx`. No changes to navigation component logic needed.

### API Client (`api/client.ts`)

Typed wrapper around `fetch` that:
1. Retrieves the current Cognito JWT from Amplify (`fetchAuthSession()`)
2. Adds `Authorization: Bearer <token>` header
3. Maps to the correct API Gateway URL from `runtimeConfig`
4. Exports typed functions: `getChatResponse`, `getQuickSightEmbedUrl(dashboard: DashboardKey)`, `getFindings`, etc.

---

## 10. Architecture Decision Records

| # | Decision | Alternatives Considered | Rationale |
|---|---|---|---|
| **ADR-01** | Single CDK app, 5 stacks in linked account + 1 in payer | Monolith stack; separate repos per stack | Selective deploy (`cdk deploy KostOpsApiStack`). Stacks share typed outputs (no SSM lookups between linked stacks). Payer stack is intentionally separate — customer runs it in a different account. |
| **ADR-02** | Cross-account S3 read (no CUR replication) | S3 replication to linked account bucket | Replication costs ~$0.015/GB/month and introduces 15-min lag. Glue crawler reads payer S3 in-place via cross-account bucket policy. Eliminates duplicate storage and sync delay. |
| **ADR-03** | AgentCore Runtime vs raw Bedrock `InvokeModel` | Raw `InvokeModel` in Lambda; Bedrock Agents (KB-based) | AgentCore manages conversation history, streaming reassembly, retry-on-throttle, and cold-start container management. Raw InvokeModel requires reimplementing all of these. Bedrock Agents requires Knowledge Base setup, is harder to debug, and has higher per-token overhead. |
| **ADR-04** | strands-agents `@tool` decorator | Bedrock tool JSON schema; LangChain tools | `@tool` auto-extracts schema from Python type hints + docstrings — no separate JSON schema file to maintain. Strands stub in `strands/__init__.py` provides the decorator with zero dependencies, keeping bundle size small. |
| **ADR-05** | Runtime `/runtime-config.json` vs build-time `.env` | Vite `import.meta.env.*` baked into bundle | Same JS bundle works for any environment. Config change = S3 file update only (no rebuild, no redeploy). Critical for `FrontendStack` because Cognito Pool ID and API URL are only known after AgentStack and ApiStack deploy. |
| **ADR-06** | QuickSight optional (`--context installQuickSight=true`) | Always-on; use Recharts/Chart.js instead | QuickSight Enterprise costs $24/user/month or requires Session Capacity Pricing setup. Not all customers need interactive dashboards. Phase 3 adds Recharts for custom user-defined dashboards (no QuickSight required). |
| **ADR-07** | Slack async self-invoke pattern | SQS + poller Lambda; SNS trigger; Step Functions | Self-invoke adds zero infrastructure. Avoids SQS polling Lambda cost ($0.20/million requests) and queue management. Step Functions overkill for a single async task. Valid for current scale (< 100 commands/day). |
| **ADR-08** | `CategoryFilter` on `billing_period` STRING | `RelativeDatesFilter` on `usage_date` DATETIME | CUR data ends 30-60 days before current date. `RelativeDatesFilter("LAST 3 MONTHS")` from April 2026 calculates Jan–Mar 2026 — missing some months if data ends in February. `CategoryFilter` with `SelectAllOptions: FILTER_ALL_VALUES` shows all months actually present in the dataset. |
| **ADR-09** | PAY_PER_REQUEST DynamoDB billing | Provisioned capacity | Workload is spiky (chat sessions) not predictable. PAY_PER_REQUEST requires no capacity planning and is cheaper below ~1M read capacity units/month. DynamoDB on-demand handles 40,000 RCU/WCU burst without pre-provisioning. |
| **ADR-10** | Cognito User Pools (not IAM Identity Center) | IAM Identity Center (AWS SSO); self-managed JWT | User Pools work without an AWS Organization. Customers deploying into a standalone linked account do not need to configure organization-level SSO. Phase 5 roadmap adds SAML 2.0 / OIDC via Cognito Identity Providers for enterprise customers who already have SSO. |

---

## Extension Points

### Adding a New Agent Tool
1. Create `@tool` function in the appropriate `tools/*.py` file
2. Import it in `visibility_agent.py` tools list
3. Add required IAM permissions to `kostops-agent-role` in `stacks/agent-stack.ts`
4. Redeploy: `cdk deploy KostOpsAgentStack` (triggers AgentCore Runtime update)

### Adding a New API Route
1. Add a new Lambda function in `stacks/api-stack.ts` (follow existing pattern)
2. Add a resource + method to the `api` object with `authOptions`
3. Add the corresponding handler file to `lambda/`
4. Frontend: add a typed function to `frontend/src/api/client.ts`

### Adding a New Dashboard Page
1. Add the `DashboardKey` value to `frontend/src/api/client.ts`
2. Add a route in `frontend/src/App.tsx`: `<Route path="/..." element={<EmbedPage dashboard="new-key" />} />`
3. Add navigation entry in `frontend/src/nav/config.ts`
4. Add the dashboard definition in `lambda/quicksight_setup_handler.py`
5. Add env var for its ARN in `stacks/api-stack.ts` (QuickSight embed handler)

### Adding a New Slack Alert Type
1. Extend `slack_handler.py` with new data collection logic
2. Format using Slack Block Kit (`blocks` array)
3. POST to webhook URL from SSM
4. If alert is event-driven (not scheduled), add a new EventBridge rule in `stacks/api-stack.ts`

---

*Document version: April 2026. Reflects KostOps v3 codebase (Phases 1–2 implemented).*
