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
  payerCurBucketName,
  athenaResultsBucketName:   dataStack.athenaResultsBucketName,
  payerAccountId,
  payerCrossAccountRoleArn,
  bedrockModelId,
});
agentStack.addDependency(authStack);
agentStack.addDependency(dataStack);

// 4 — API (Lambda + API Gateway)
// agentStack.agentRuntimeArn is set by the Custom Resource after AgentCore
// Runtime creation; CDK passes it to ApiStack as an environment variable on
// the keepwarm Lambda (chat-handler gets it via update_references in Lambda).
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
  agentRuntimeArn:           agentStack.agentRuntimeArn,
  userPool:                  authStack.userPool,
  slackWebhookUrl,
  athenaWorkgroup:           'kostops-workgroup',
  athenaResultsBucketName:   dataStack.athenaResultsBucketName,
  payerCrossAccountRoleArn,
});
apiStack.addDependency(agentStack);

// 5 — Frontend (React on S3 + CloudFront)
const frontendStack = new FrontendStack(app, 'KostOpsFrontendStack', {
  env,
  apiUrl:          apiStack.apiUrl,
  userPoolId:      authStack.userPool.userPoolId,
  userPoolClientId: authStack.userPoolClient.userPoolClientId,
});
frontendStack.addDependency(apiStack);

app.synth();
