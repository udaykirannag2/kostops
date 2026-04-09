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
| AgentCore Runtime creation failed | CloudWatch Logs → log group starting with `/aws/lambda/KostOpsAgentStack-AWS` (CDK AwsCustomResource framework Lambda). Also: AWS Console → Bedrock → AgentCore → Runtimes |

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

> **Two runs required on first deploy.**  
> Run 1 creates all infrastructure. At synthesis time the backend stacks don't exist
> yet, so `runtime-config.json` cannot be written. A `NextStep` output tells you to
> run again. Run 2 finds the real Cognito/API values and writes the config file —
> after which the UI is fully operational.

- [ ] Run 1 ends with a `NextStep` output: *"Run `npx cdk deploy --all` one more time to finalize frontend config"*
- [ ] All 5 stacks `CREATE_COMPLETE` after run 1: AuthStack, DataStack, AgentStack, ApiStack, FrontendStack
- [ ] Run 2 (same command) completes and prints `SiteUrl` with a real CloudFront domain
- [ ] Cognito User Pool exists → check CloudFormation output `UserPoolId`
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

### Stage 4 — Agent deployed (automatic — no manual step needed)

The AgentCore Runtime is built and deployed automatically during `cdk deploy --all`
via a CDK custom resource. No separate script required.

- [ ] AgentCore Runtime status is `READY`:
  ```bash
  aws bedrock-agentcore-control list-agent-runtimes \
    --query 'agentRuntimes[?agentRuntimeName==`kostopsVisibilityAgent`].status'
  ```
- [ ] Lambda `kostops-chat-handler` has `AGENT_RUNTIME_ARN` env var set

**If runtime fails with `RuntimeClientError: initialization time exceeded`:**
- The AgentCore Runtime zip must include `boto3` and all its dependencies
  (`botocore`, `s3transfer`, `jmespath`). These are NOT pre-installed by the runtime.
- Redeploy `KostOpsAgentStack` — the CDK custom resource re-bundles and re-uploads
  the zip automatically.
- If the error persists, check the CDK custom resource logs:
  ```bash
  aws logs describe-log-groups \
    --log-group-name-prefix /aws/lambda/KostOpsAgentStack-AWS \
    --query 'logGroups[*].logGroupName' --output table
  ```

### Stage 5 — UI works end-to-end

- [ ] CloudFront URL opens the login page (no blank page / 403)
- [ ] Login with admin email + temporary password works
- [ ] Chat: type `"What are my top 3 AWS services by spend?"` — agent responds with real numbers
- [ ] Chat: type `"List my open findings"` — returns findings (may be empty on first run, that's OK)

**If chat returns "Failed to fetch":**
- Open browser DevTools → Network → look at the `/chat` API call → check response body
- Common causes: CORS (API Gateway stage not deployed), AGENT_RUNTIME_ARN not set, Cognito JWT expired, AgentCore Runtime not yet `READY`

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

### Step 2 — Run in your linked account (~15 minutes)

Copy the command from Step 1's output, or run:

```bash
# Switch to linked account credentials
export AWS_PROFILE=my-linked-account

# First run — creates all infrastructure
# (frontend npm install + build and agent bundle happen automatically)
cdk deploy --all \
  --context payerAccountId=987654321098 \
  --context payerCrossAccountRoleArn=arn:aws:iam::987654321098:role/kostops-cross-account-role \
  --context payerCurBucketName=my-existing-cur-bucket \
  --context adminEmail=you@yourcompany.com \
  --context slackWebhookUrl=<your-slack-webhook-url>
```

At the end of the first run you will see:

```
KostOpsFrontendStack.NextStep = Run `npx cdk deploy --all` one more time to finalize frontend config
```

This is expected. Run it a second time with the same flags:

```bash
# Second run — writes runtime-config.json so the UI can talk to Cognito + API
cdk deploy --all \
  --context payerAccountId=987654321098 \
  --context payerCrossAccountRoleArn=arn:aws:iam::987654321098:role/kostops-cross-account-role \
  --context payerCurBucketName=my-existing-cur-bucket \
  --context adminEmail=you@yourcompany.com \
  --context slackWebhookUrl=<your-slack-webhook-url>
```

> **Why two runs?** CDK synthesises all stacks before deploying any of them.
> On the first run the backend stacks (Auth, API) don't exist yet at synthesis
> time, so the frontend config file can't be written with real Cognito IDs.
> The second run finds the now-deployed stacks and writes the config.
> All subsequent deploys (updates, config changes) only need one run.

> **Non-US deployments:** By default KostOps uses
> `us.anthropic.claude-sonnet-4-5-20250929-v1:0` (cross-region inference).
> For EU or Asia-Pacific, pass `--context bedrockModelId=eu.anthropic.claude-sonnet-4-5-20250929-v1:0`
> (or `ap.*`). CDK auto-detects the region if you omit this context.

### Step 3 — Open the UI

CDK outputs the URL at the end of the second deploy:

```
KostOpsFrontendStack.SiteUrl = https://d1234abcd.cloudfront.net
```

Log in with your admin email. Check your inbox for the temporary password.
Ask the agent: "What are my top savings opportunities?" to run the first scan.

## Integrations

### Slack

KostOps integrates with Slack for two-way communication:

- **Outbound** — daily digest of open findings (Mon–Fri, 9 AM UTC) and cost anomaly alerts posted to a channel
- **Inbound** — `/kostops` slash command: any team member can ask the AI agent a cost question and get an answer inside Slack
- **Remediation approvals** *(Phase 2, not yet available)* — approve or deny automated fixes via Approve/Deny buttons in Slack

**Time to complete:** ~15 minutes

---

#### Before you start

You need **Slack Workspace Admin** (or Owner) access to create a Slack App and
install it to your workspace. If you are not an admin, ask your Slack admin to
follow these steps or to grant you the **App Manager** permission first.

You also need KostOps already deployed (the slash command URL comes from the KostOps UI).

---

#### Step 1 — Create a Slack App

1. Open a browser and go to **[https://api.slack.com/apps](https://api.slack.com/apps)**
   (log in with the account that has workspace admin access if prompted)

2. Click the green **Create New App** button in the top-right

3. A dialog appears asking how you want to configure the app.
   Choose **From scratch**

4. Fill in:
   - **App Name:** `KostOps` (or any name your team prefers — this is what users see in Slack)
   - **Pick a workspace to develop your app in:** choose your company's Slack workspace from the dropdown

5. Click **Create App**

   > You will land on the app's settings page. The left sidebar is your navigation
   > for the rest of these steps.

6. In the left sidebar click **Basic Information**

7. Scroll down to the **App Credentials** section. You will see a **Signing Secret** field
   with a **Show** button next to it

8. Click **Show**, then copy the Signing Secret and save it somewhere safe
   (a text file or password manager) — you will paste it into KostOps in Step 5

   > The Signing Secret proves to KostOps that slash command requests genuinely
   > came from Slack and were not forged by someone else.

---

#### Step 2 — Set up Incoming Webhooks (so KostOps can post to Slack)

Incoming Webhooks give KostOps a URL it can call to post messages to a Slack channel.

1. In the left sidebar click **Incoming Webhooks**

2. At the top of the page there is a toggle labelled **Activate Incoming Webhooks**.
   Click it so it turns **ON** (green)

3. Scroll down. A new section appears: **Webhook URLs for Your Workspace**.
   Click the **Add New Webhook to Workspace** button

4. A Slack permission screen opens. Use the dropdown to choose the channel KostOps
   should post to — for example `#finops-alerts`. If the channel does not exist yet,
   create it in Slack first, then come back here

5. Click **Allow**

6. You are returned to the Incoming Webhooks page. You will now see a webhook URL
   (it starts with `hooks.slack.com/services/` followed by three path segments).
   Click **Copy** next to it and save it alongside the Signing Secret from Step 1.

   > **Test it (optional):** The page shows a `curl` command you can paste into a
   > terminal to send a test message to the channel right now.

---

#### Step 3 — Find your KostOps slash command URL

Before configuring the slash command in Slack, you need the endpoint URL from KostOps.

1. Open the KostOps web UI (the CloudFront URL from your deployment)

2. In the left navigation click **Integrations**, then click **Connect** on the Slack card

3. In the Slack configuration panel, look for the section labelled
   **Slash Command Setup**. You will see a URL that looks like:
   ```
   https://xxxxxxxxxxxx.execute-api.us-east-1.amazonaws.com/prod/slack/command
   ```
   Click the **Copy** button next to it

   > Keep this browser tab open — you will come back to it in Step 5.

---

#### Step 4 — Create the `/kostops` Slash Command

1. Go back to the Slack App settings tab (api.slack.com/apps → your KostOps app)

2. In the left sidebar click **Slash Commands**

3. Click **Create New Command**

4. Fill in the form exactly as follows:

   | Field | What to enter |
   |-------|---------------|
   | **Command** | `/kostops` |
   | **Request URL** | Paste the URL you copied from the KostOps UI in Step 3 |
   | **Short Description** | `Ask KostOps a question about your AWS costs` |
   | **Usage Hint** | `What are my top savings opportunities?` |
   | **Escape channels, users, and links** | Leave unchecked |

5. Click **Save**

   > **What this does:** When any workspace member types `/kostops` followed by a
   > question, Slack sends that question to KostOps, the AI agent processes it,
   > and the answer is posted back in the same Slack conversation — usually within
   > 10–30 seconds.

---

#### Step 5 — Install the App to your Workspace

The app must be installed before it can do anything.

1. In the left sidebar click **OAuth & Permissions**

2. Scroll down to **Scopes → Bot Token Scopes**. Verify the following scopes are listed
   (they are usually added automatically; if any are missing click **Add an OAuth Scope**):

   | Scope | Why it is needed |
   |-------|-----------------|
   | `incoming-webhook` | Lets KostOps post digest and alert messages |
   | `commands` | Lets KostOps receive `/kostops` slash commands |
   | `chat:write` | Lets KostOps post the agent's answer back to the user |

3. Scroll back to the top of the **OAuth & Permissions** page

4. Click the **Install to Workspace** button (or **Reinstall to Workspace** if the app
   was previously installed)

5. A Slack permission screen appears summarising what the app can do. Click **Allow**

6. You are returned to the OAuth page. You will see a **Bot User OAuth Token** that
   starts with `xoxb-`. You do not need to copy this token — KostOps uses the
   webhook URL and Signing Secret instead.

   > ✅ **Checkpoint:** At this point the Slack App is installed. If you open the
   > channel you selected in Step 2, you should see a message: *"[Your App Name]
   > was added to #your-channel"*

   > ⚠️ **Important — Reinstall after every change:** Slack only picks up new or
   > updated slash commands, scopes, and webhook URLs **after a reinstall**.
   > Any time you edit the slash command URL, add a scope, or change settings in
   > the Slack App dashboard, you **must** return to **OAuth & Permissions** and
   > click **Reinstall to Workspace** again, then click **Allow**.
   > Without this step the changes have no effect and `/kostops` will not appear
   > in Slack's command picker.

---

#### Step 6 — Save the credentials in KostOps

1. Go back to the KostOps UI tab you left open in Step 3
   (Integrations → Slack configuration panel)

2. Fill in the fields:

   | Field | Where to get the value |
   |-------|----------------------|
   | **Incoming Webhook URL** | The URL you copied in Step 2 |
   | **Signing Secret** | The secret you copied in Step 1 |
   | **Default Channel** | The channel name you chose, including the `#` (e.g. `#finops-alerts`) |

3. Under **Notification Triggers**, choose which events should send a Slack message:
   - **Daily digest** — recommended ON. Posts top open findings every weekday at 9 AM UTC
   - **Cost anomaly alerts** — recommended ON. Posts an alert when unusual spend is detected
   - **New finding created** — optional. Posts a message each time a new P0 or P1 savings finding is saved

4. Click **Test Connection**. You should see a success message and a test notification
   appear in your Slack channel within a few seconds

5. If the test succeeds, click **Save**

   > **If the test fails:** Double-check that you copied the full webhook URL from
   > Step 2. It should start with `hooks.slack.com/services/` followed by three path
   > segments. A single missing character will cause it to fail silently.

---

#### Step 7 — Verify the slash command works

1. Open Slack and navigate to any channel or DM

2. Type `/` — Slack's command picker should appear. Start typing `kostops` and you
   should see `/kostops` appear in the list with the description you set in Step 4

   > **`/kostops` not showing in the picker?** This almost always means the app
   > was not reinstalled after the slash command was created. Go to
   > **api.slack.com/apps → your app → OAuth & Permissions → Reinstall to Workspace**,
   > click **Allow**, then try again.

3. Select `/kostops` (or type the full command), add your question, and press Enter:
   ```
   /kostops What are my top savings opportunities?
   ```

4. You should immediately see a *"🔍 Looking into that for you…"* response from the
   bot, followed by the actual answer from the KostOps agent within 10–30 seconds

   > If you see "Hmm, that didn't work" from Slack, the Request URL in Step 4
   > is incorrect. Go back to the Slack App → Slash Commands → edit `/kostops`,
   > re-paste the URL from the KostOps UI, click Save, then **reinstall the app**.

---

#### Step 8 — Enable Approve/Deny buttons *(Phase 2 only — skip for now)*

> **Skip this step.** Remediation approvals via Slack buttons are not yet available.
> This step will be needed when the Remediation Agent ships in Phase 2.
> Instructions will be updated at that time.

When Phase 2 is available, this step will require setting a second URL
(`/slack/interactive`) in the Slack App under **Interactivity & Shortcuts**.

---

#### How it works end-to-end

```
Daily digest (automatic)
  Mon–Fri at 9 AM UTC
    └── KostOps reads top 10 OPEN findings from its database
          └── Posts a formatted summary to your Slack channel

Slash command (any team member, any time)
  User types: /kostops What are my top savings opportunities?
    └── Slack sends the question to KostOps
          ├── KostOps immediately replies "Thinking…" (required within 3 seconds)
          ├── KostOps agent analyses your AWS cost data
          └── Posts the full answer back to Slack (10–30 seconds)
```

---

#### Troubleshooting

| Problem | Likely cause | Fix |
|---------|-------------|-----|
| Test Connection fails | Wrong webhook URL | Re-copy the full URL from Slack App → Incoming Webhooks |
| `/kostops` does not appear in the command picker | App not reinstalled after slash command was created or edited | Go to **OAuth & Permissions → Reinstall to Workspace → Allow** |
| Slash command shows "Hmm, that didn't work" | Wrong Request URL, or app not reinstalled after URL change | Re-copy the URL from KostOps UI → Integrations → Slack, then reinstall the app |
| Slash command shows nothing after "🔍 Thinking…" | Agent timeout or error | Check AWS CloudWatch → `/aws/lambda/kostops-slack-command-handler` |
| Daily digest not arriving | App not installed or wrong channel | Confirm Step 5 completed and the channel name in Step 6 is correct |
| "Signature verification failed" in logs | Signing Secret mismatch | Re-copy the Signing Secret from Slack App → Basic Information → App Credentials, then re-save in KostOps UI |
| "Not allowed to post to channel" | Bot not in the channel | In Slack, open the channel → Settings → Integrations → Add apps → select your KostOps app |
| Workspace admin blocked app installation | Enterprise/managed workspace restriction | Ask your Slack admin to approve the app under **Slack Admin → Manage Apps** |
| Changes to the app have no effect | App not reinstalled after changes | Any config change in the Slack App dashboard (URL, scopes, settings) requires **Reinstall to Workspace** to take effect |

---

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

### What's Built (V1 — Current)

| Area | Feature | Status |
|---|---|---|
| **Infrastructure** | Auth (Cognito), Data (DynamoDB, Athena, Glue), Agent (AgentCore Runtime), API (Lambda + API Gateway), Frontend (S3 + CloudFront) | ✅ |
| **Agent** | Pure Python stdlib HTTP server, `boto3.converse()` loop, 24 tools (Cost Explorer, EC2, RDS, EBS, Savings Plans, Budgets, Findings CRUD, Athena CUR) | ✅ |
| **Chat** | Full agent chat UI, session persistence (DynamoDB), history reloads on refresh / device switch, "New chat" button | ✅ |
| **Dashboard** | Monthly spend bar chart (Athena CUR) | ✅ |
| **Findings** | List, filter by status, resolve / ignore actions | ✅ |
| **Slack** | Outbound Block Kit daily digest (Mon–Fri 9am UTC), inbound slash command handler (3s ACK + async), HMAC-SHA256 verification | ✅ |
| **Integrations page** | Card grid with slide-over config panels — Slack (full), Jira / PagerDuty / Email (stubs) | ✅ |
| **Keep-warm** | EventBridge ping every 5 min to avoid AgentCore cold-start | ✅ |

---

### Phase 2 — Proactive Intelligence + Governance

#### Proactive Daily Scan — Always-Populated Findings (CRITICAL)

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

#### KostOps Cost Dashboard — Infrastructure Self-Cost via Tags

Show customers exactly what KostOps itself costs to run, building trust and enabling
direct ROI comparison ("KostOps cost $42 this month, identified $1,400 in savings").

**How it works:**
- CDK tags every KostOps resource at deploy time: `App=KostOps`, `Component=ui|api|agent|storage|data`
- New Athena tool `get_kostops_monthly_cost()` queries CUR filtering on `resource_tags_user_app = 'KostOps'`
- Results grouped by service and component; cached in S3 by Athena (no extra storage cost)

**Where it surfaces:**
- **Dashboard** — new "KostOps Overhead" card: this month $X, breakdown by component
- **Header badge** — "KostOps infra: ~$X/mo" with tooltip
- **ROI callout** — "KostOps cost $42, enabled $1,400/month in identified savings (33x ROI)"

**Implementation:**
- `app.ts`: add `cdk.Tags.of(app).add('App', 'KostOps')` + per-stack component tags
- `lambda/dashboard_handler.py`: new `/dashboard/self-cost` route
- UI: new card in Dashboard with sparkline (last 3 months) + component breakdown bar

---

#### Slack Alerts — Daily and Weekly Reports

Extend the existing Slack integration with richer scheduled reports beyond the current
daily findings digest.

**Daily alert (enhance existing):**
- Current: plain findings count + savings total
- Enhanced: top 3 new findings with resource ID, type, and savings; anomaly callout if cost spike detected overnight; link to findings page

**Weekly report (new — Mondays 08:00 UTC):**
- New findings this week (count + total estimated savings)
- Findings resolved this week + savings realised
- Backlog summary: N open findings, $X total opportunity
- ROI line: "KostOps cost $Z this month, identified $Y in savings"
- Sent to Slack + available on demand via `POST /reports/weekly` from the UI

**Implementation:**
- `lambda/slack_handler.py`: upgrade daily digest to Block Kit with top-3 findings
- New `lambda/weekly_report.py`: queries findings DynamoDB for last 7 days, formats Block Kit report, sends to Slack
- `stacks/api-stack.ts`: new EventBridge rule — Mondays 08:00 UTC → weekly_report Lambda
- New API route: `POST /reports/weekly` for on-demand trigger from Integrations page
- `lambda/findings_handler.py`: add `resolvedAt` timestamp on PATCH to RESOLVED

---

#### Metabase — Self-Hosted BI Dashboarding

Install Metabase alongside KostOps for customers who want flexible, SQL-driven
dashboards and reports beyond the built-in React UI.

**Why Metabase:**
- Connects directly to Athena (CUR data) and DynamoDB (findings) — no data movement
- Non-engineers can build their own cost dashboards without writing code
- Pre-built KostOps question library: spend by service, account, tag, savings trend
- Embeddable charts — findings/cost charts can be embedded in internal wikis or Notion

**Architecture:**
```
Metabase (ECS Fargate, t3.small)
  ├── Athena driver  → kostops_cur Glue database (CUR queries)
  └── RDS PostgreSQL (t3.micro) → Metabase internal metadata store
```

**Pre-built dashboards shipped with KostOps:**
- Monthly spend by service (last 13 months)
- Top cost drivers by account
- Findings backlog — open vs resolved over time
- Savings realised trend
- KostOps self-cost vs savings ROI

**Implementation:**
- New `stacks/metabase-stack.ts`: ECS Fargate service + RDS PostgreSQL + ALB
- Metabase bootstrapped with Athena connection pre-configured via API at deploy time
- CDK context flag `--context installMetabase=true` — opt-in, not deployed by default
- Estimated cost: ~$35/month (Fargate t3.small + RDS t3.micro)

---

#### AI Governance — Guardrails, Topic Control, and Security

Apply AWS Bedrock Guardrails to the KostOps agent to enforce safe, on-topic behaviour
and protect against prompt injection and misuse.

**Reference:** [AWS Cloud Intelligence Dashboards — Generative AI guidance](https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/generative-ai.html)

**What guardrails enforce:**

| Control | What it does |
|---|---|
| **Topic inclusion** | Agent only answers AWS cost and FinOps questions — refuses off-topic requests ("write me a poem", "ignore previous instructions") |
| **Topic exclusion** | Blocks specific topics: no investment advice, no competitor pricing, no personally identifiable data |
| **Cost overrun alerts** | If agent's suggested action would cost more than a configurable threshold, require explicit user confirmation before proceeding |
| **Prompt injection protection** | Detects and blocks attempts to override the system prompt or extract internal instructions via user messages or tool outputs |
| **Content filters** | Block hate speech, violence, or inappropriate content in both inputs and outputs |
| **PII redaction** | Automatically redact PII (account numbers, email addresses) from agent responses before they reach the UI |

**Security — Prompt Injection:**
Prompt injection is the #1 security risk for LLM agents. An attacker could embed
instructions in a resource name, tag value, or Slack message that the agent reads
via a tool call — causing it to exfiltrate data or take unintended actions.

Mitigations:
- **Bedrock Guardrails** — `applyGuardrail` on every `converse()` call; blocks known injection patterns
- **Tool output sanitisation** — `visibility_agent.py` strips `<`, `>`, instruction-like patterns from tool results before feeding back to the model
- **Least-privilege IAM** — agent role has no write access to production resources; remediation requires a separate approved role
- **Audit log** — every tool call and its inputs/outputs logged to CloudWatch with the userId for forensic review

**Implementation:**
- `stacks/agent-stack.ts`: create `CfnGuardrail` with topic policy, content filters, PII config
- Pass `guardrailIdentifier` + `guardrailVersion` to `visibility_agent.py` via env vars
- `visibility_agent.py`: add `guardrailConfig` to every `boto3.converse()` call
- New `lambda/audit_log_handler.py`: streams CloudWatch agent logs → S3 for long-term retention
- UI: **Settings → Governance** page — configure allowed topics, blocked topics, cost threshold, view audit log

---

### Phase 3 — Multi-Agent + Enterprise

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
- **Visibility Agent** (extracted from current): Cost Explorer, CUR/Athena, CloudWatch metrics.
- **Optimization Agent** (new): Compute Optimizer, rightsizing, Savings Plans, idle resource ranking.
- **Remediation Agent** (new): Executes safe remediations (stop instance, delete snapshot, resize)
  behind a human-approval gate. Every action logged to DynamoDB with before/after state for rollback.

Each sub-agent deploys as its own **AgentCore Runtime** (independent scaling, separate least-privilege IAM).

---

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

#### Rightsizing Dashboard — Compute Optimizer → QuickSight

Replace the placeholder rightsizing dashboard with **real AWS Compute Optimizer recommendations**
surfaced as an interactive QuickSight embed — same CID pattern, no extra cost.

**How CID does it (and how we'll match it):**

```
AWS Compute Optimizer
  └── ExportEC2InstanceRecommendations → S3 (daily parquet, native AWS export — free)
        ↓
  Glue crawler → kostops_cur Glue database (new table: compute_optimizer_recommendations)
        ↓
  Athena view: rightsizing_view
        ↓
  QuickSight SPICE dataset: kostops-rightsizing-view
        ↓
  Rightsizing & Waste dashboard (replaces current placeholder)
```

**What the dashboard shows (per CID spec):**

| Visual | Description |
|---|---|
| Potential monthly savings | KPI card — total $ if all recommendations applied |
| Recommendations by finding | Donut — OVER_PROVISIONED / UNDER_PROVISIONED / OPTIMIZED |
| Top 25 over-provisioned instances | Table — instance ID, current type, recommended type, CPU p99, savings/month |
| Savings by instance family | Bar — which families have most waste (m5, c5, r5 etc.) |
| Recommendations trend | Line — number of open recommendations over last 13 weeks |

**What Compute Optimizer export contains (richer than API):**
- `current_instance_type`, `recommended_instance_type`
- `cpu_utilization_p99`, `memory_utilization_p99`
- `estimated_monthly_savings`, `finding` (OVER_PROVISIONED / UNDER_PROVISIONED)
- `account_id`, `region`, `instance_arn`, `last_refresh_timestamp`

**Implementation steps:**
1. `quicksight_setup_handler.py` — call `compute_optimizer.export_ec2_instance_recommendations()` to S3 at setup time; add Glue table + Athena `rightsizing_view`; add SPICE dataset; replace rightsizing dashboard definition
2. CDK / EventBridge — weekly rule triggers a Lambda to re-export fresh recommendations to S3
3. Glue crawler runs after export to update table partitions
4. SPICE dataset refreshes on a daily schedule

**Cost:**
- Compute Optimizer export: free
- S3 storage: ~5 MB/month parquet = $0.0001/month
- Glue crawler: ~4 runs/month = $0.01/month
- Athena scans: KB per query = effectively $0
- **Total: < $0.02/month added**

---

#### Enterprise
- Multi-cloud (Azure Cost Management, GCP Billing)
- Enterprise policy engine (enforce tagging, budget guardrails)
- AWS Marketplace listing
- SSO / SAML federation
