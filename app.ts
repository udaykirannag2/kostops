#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AuthStack }     from './stacks/auth-stack';
import { DataStack }     from './stacks/data-stack';
import { AgentStack }    from './stacks/agent-stack';
import { ApiStack }      from './stacks/api-stack';
import { FrontendStack } from './stacks/frontend-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region:  process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

// Customer-supplied parameters
const payerCurBucketName       = app.node.tryGetContext('payerCurBucketName')       ?? '';
const slackWebhookUrl          = app.node.tryGetContext('slackWebhookUrl')          ?? '';
const adminEmail               = app.node.tryGetContext('adminEmail')               ?? '';
const payerAccountId           = app.node.tryGetContext('payerAccountId')           ?? '';
const payerCrossAccountRoleArn = app.node.tryGetContext('payerCrossAccountRoleArn') ?? '';

// Bedrock model ID — defaults to the cross-region inference profile for the
// deployment region.  Override with:
//   cdk deploy --context bedrockModelId=us.anthropic.claude-sonnet-4-5-20250929-v1:0
// Available prefixes: us.* (us-east-1/2, us-west-2), eu.* (eu-west-1/3, eu-central-1),
//                     ap.* (ap-northeast-1, ap-southeast-1/2)
const deployRegion = process.env.CDK_DEFAULT_REGION ?? 'us-east-1';
const regionPrefix = deployRegion.startsWith('eu-') ? 'eu'
                   : deployRegion.startsWith('ap-') ? 'ap'
                   : 'us';
const defaultModelId = `${regionPrefix}.anthropic.claude-sonnet-4-5-20250929-v1:0`;
const bedrockModelId = app.node.tryGetContext('bedrockModelId') ?? defaultModelId;

// Validate required payer context
if (!payerAccountId || !payerCrossAccountRoleArn || !payerCurBucketName) {
  console.warn(
    '\n[KostOps] WARNING: payerAccountId, payerCrossAccountRoleArn, or payerCurBucketName not set.\n' +
    'Cost Explorer, billing MCP server, and Athena CUR queries will not work.\n' +
    'Run the payer stack first: see cdk/payer-app.ts\n'
  );
}

// 1 — Auth (everything else depends on Cognito)
const authStack = new AuthStack(app, 'KostOpsAuthStack', { env, adminEmail });

// 2 — Data (S3, Athena, DynamoDB — no dependencies)
const dataStack = new DataStack(app, 'KostOpsDataStack', {
  env,
  payerCurBucketName,
  payerAccountId,
});

// 3 — Agent (AgentCore Runtime + IAM with MCP server permissions)
const agentStack = new AgentStack(app, 'KostOpsAgentStack', {
  env,
  findingsTable:             dataStack.findingsTable,
  scopesTable:               dataStack.scopesTable,
  budgetsTable:              dataStack.budgetsTable,
  forecastsTable:            dataStack.forecastsTable,
  scopeActualsTable:         dataStack.scopeActualsTable,
  payerCurBucketName,
  athenaResultsBucketName:   dataStack.athenaResultsBucketName,
  payerAccountId,
  payerCrossAccountRoleArn,
  bedrockModelId,
});
agentStack.addDependency(authStack);
agentStack.addDependency(dataStack);

// 4 — API (Lambda + API Gateway)
//
// IMPORTANT: we intentionally do NOT pass agentStack.agentRuntimeArn as a CDK
// token here. Doing so creates a Fn::ImportValue from AgentStack → ApiStack
// that CFN locks for the lifetime of the consumer stack. Whenever AgentStack
// legitimately replaces the runtime (env-var change, new specialist), CFN
// blocks the export change with "Cannot update export … as it is in use by
// KostOpsApiStack" because the consuming stack still references the old value.
//
// Instead, the custom resource in lambda/agentcore_deploy.py:
//   1. Writes the current runtime ARN to SSM `/kostops/agent-runtime-arn`
//   2. Calls lambda.update_function_configuration on chat-handler,
//      keepwarm-handler, slack-command-handler to patch AGENT_RUNTIME_ARN.
// So ApiStack ships with AGENT_RUNTIME_ARN='' in its template; the real value
// is patched post-deploy and persists through Lambda env var updates (CDK
// Lambda updates preserve the env value when the template has ''). chat
// Lambda handles empty ARN gracefully with a 503 "Agent not deployed yet".
const apiStack = new ApiStack(app, 'KostOpsApiStack', {
  env,
  findingsTable:             dataStack.findingsTable,
  integrationsTable:         dataStack.integrationsTable,
  conversationsTable:        dataStack.conversationsTable,
  auditEventsTable:          dataStack.auditEventsTable,
  scopesTable:               dataStack.scopesTable,
  budgetsTable:              dataStack.budgetsTable,
  forecastsTable:            dataStack.forecastsTable,
  scopeActualsTable:         dataStack.scopeActualsTable,
  importJobsTable:           dataStack.importJobsTable,
  agentEndpointUrl:          agentStack.agentEndpointUrl,
  agentRuntimeArn:           '',  // patched by agentcore_deploy.py post-create
  userPool:                  authStack.userPool,
  slackWebhookUrl,
  athenaWorkgroup:           'kostops-workgroup',
  athenaResultsBucketName:   dataStack.athenaResultsBucketName,
  payerCrossAccountRoleArn,
});
// Keep topological dependency — we still want AuthStack and DataStack deployed
// before ApiStack. No longer depend on AgentStack to avoid the circular export.
apiStack.addDependency(authStack);
apiStack.addDependency(dataStack);

// 5 — Frontend (React on S3 + CloudFront)
const frontendStack = new FrontendStack(app, 'KostOpsFrontendStack', {
  env,
  apiUrl:          apiStack.apiUrl,
  userPoolId:      authStack.userPool.userPoolId,
  userPoolClientId: authStack.userPoolClient.userPoolClientId,
});
frontendStack.addDependency(apiStack);

app.synth();
