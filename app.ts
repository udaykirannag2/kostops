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
const curBucketName            = app.node.tryGetContext('curBucketName')            ?? '';
const slackWebhookUrl          = app.node.tryGetContext('slackWebhookUrl')          ?? '';
const adminEmail               = app.node.tryGetContext('adminEmail')               ?? '';
const payerAccountId           = app.node.tryGetContext('payerAccountId')           ?? '';
const payerCrossAccountRoleArn = app.node.tryGetContext('payerCrossAccountRoleArn') ?? '';

// Validate required payer context
if (!payerAccountId || !payerCrossAccountRoleArn) {
  console.warn(
    '\n[KostOps] WARNING: payerAccountId or payerCrossAccountRoleArn not set.\n' +
    'Cost Explorer and billing MCP server will not work without payer account access.\n' +
    'Run the payer stack first: see cdk/payer-app.ts\n'
  );
}

// 1 — Auth (everything else depends on Cognito)
const authStack = new AuthStack(app, 'KostOpsAuthStack', { env, adminEmail });

// 2 — Data (S3, Athena, DynamoDB — no dependencies)
const dataStack = new DataStack(app, 'KostOpsDataStack', { env, curBucketName });

// 3 — Agent (AgentCore Runtime + IAM with MCP server permissions)
const agentStack = new AgentStack(app, 'KostOpsAgentStack', {
  env,
  findingsTable:             dataStack.findingsTable,
  curBucket:                 dataStack.curBucket,
  athenaResultsBucketName:   dataStack.athenaResultsBucketName,
  payerAccountId:            payerAccountId,
  payerCrossAccountRoleArn:  payerCrossAccountRoleArn,
});
agentStack.addDependency(authStack);
agentStack.addDependency(dataStack);

// 4 — API (Lambda + API Gateway)
const apiStack = new ApiStack(app, 'KostOpsApiStack', {
  env,
  findingsTable:    dataStack.findingsTable,
  agentEndpointUrl: agentStack.agentEndpointUrl,
  userPool:         authStack.userPool,
  slackWebhookUrl,
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
