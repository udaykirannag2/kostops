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
CUR export → S3                     S3 kostops-cur-<account-id>  ← replicated
Cost Explorer API            ←─sts:AssumeRole── KostOps agent
Compute Optimizer                   Athena + Glue  (queries local CUR copy)
Budgets                             DynamoDB       (findings)
Cost Optimization Hub               Lambda + API Gateway
                                    CloudFront + React UI
                                    Cognito
```

## Install — two commands, ~30 minutes

### Prerequisites

- AWS CLI configured for both payer and linked accounts
- Node.js 18+, Python 3.12+, uv (`curl -LsSf https://astral.sh/uv/install.sh | sh`)
- AWS CDK v2: `npm install -g aws-cdk`
- CUR already enabled in your payer account (Billing → Cost & Usage Reports)
- Versioning enabled on your existing CUR S3 bucket (required for replication)

#### IAM permissions required

The AWS credentials used to run each CDK deploy must have sufficient permissions.
The simplest approach is `AdministratorAccess` on both accounts. If your organisation
requires least-privilege, the minimum permissions are:

**Payer account** (Step 1 — `KostOpsPayerStack`):
- `s3:CreateBucket`, `s3:PutBucketVersioning`, `s3:PutBucketPolicy`, `s3:PutLifecycleConfiguration`, `s3:PutReplicationConfiguration`
- `iam:CreateRole`, `iam:PutRolePolicy`, `iam:AttachRolePolicy`, `iam:PassRole`
- `ssm:PutParameter`
- `cloudformation:*` (CDK requires full CloudFormation access)
- `sts:GetCallerIdentity` (CDK bootstrap)

**Linked account** (Step 2 — `cdk deploy --all`):
- `cognito-idp:CreateUserPool`, `cognito-idp:CreateUserPoolClient`
- `s3:CreateBucket`, `s3:PutBucketPolicy`
- `athena:CreateWorkGroup`, `glue:CreateDatabase`, `glue:CreateTable`
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
- `kostops-cur-123456789012` — standardised S3 bucket, CUR data replicates here automatically
- `kostops-cross-account-role` — IAM role trusted by the linked account agent
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
  --context curBucketName=kostops-cur-123456789012 \
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

## Bucket naming convention

KostOps always creates the replicated CUR bucket as:

```
kostops-cur-<linkedAccountId>
```

For example: `kostops-cur-123456789012`

This makes it easy to identify in the S3 console, unique per linked account,
and consistent across all your customers or environments.

## Destroying

```bash
# Linked account
cdk destroy --all

# Payer account
export AWS_PROFILE=my-payer-account
cdk --app "npx ts-node cdk/payer-app.ts" destroy KostOpsPayerStack
```

Note: The CUR bucket, DynamoDB findings table, and replicated CUR bucket
use `RemovalPolicy.RETAIN` — delete manually to preserve billing history.

## Contributing

Open source under MIT. PRs welcome.
See CONTRIBUTING.md for how to add a new detection rule.

## Roadmap

- V2: Approval workflows, remediation playbooks, multi-account aggregation
- V3: Multi-cloud (Azure, GCP), enterprise policy engine, AWS Marketplace
