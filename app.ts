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
});
agentStack.addDependency(authStack);
agentStack.addDependency(dataStack);

// 4 — API (Lambda + API Gateway)
const apiStack = new ApiStack(app, 'KostOpsApiStack', {
  env,
  findingsTable:           dataStack.findingsTable,
  agentEndpointUrl:        agentStack.agentEndpointUrl,
  userPool:                authStack.userPool,
  slackWebhookUrl,
  athenaWorkgroup:         'kostops-workgroup',
  athenaResultsBucketName: dataStack.athenaResultsBucketName,
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
