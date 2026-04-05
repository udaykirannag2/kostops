#!/usr/bin/env node
/**
 * KostOps Payer Account Setup
 * ---------------------------
 * Run this ONCE in the AWS payer (management) account.
 * The output tells you exactly what to run next in the linked account.
 *
 * Usage:
 *   cdk deploy KostOpsPayerStack \
 *     --context linkedAccountId=123456789012 \
 *     --context payerCurBucketName=my-existing-cur-bucket
 *
 * Requirements before running:
 *   - AWS CLI configured with payer account credentials
 *   - CUR already enabled in the payer account with S3 delivery
 *   - Versioning enabled on the source CUR bucket (required for S3 replication)
 *
 * What this creates:
 *   - S3 bucket: kostops-cur-<linkedAccountId>  (standardised, easy to identify)
 *   - S3 replication: payer CUR bucket → kostops-cur-<linkedAccountId>
 *   - IAM role: kostops-cross-account-role (trusted by linked account KostOps agent)
 *   - SSM parameters: /kostops/payer/* (read by linked account deploy)
 */

import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { PayerStack } from './stacks/payer-stack';

const app = new cdk.App();

new PayerStack(app, 'KostOpsPayerStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region:  process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'KostOps payer account setup — CUR replication and cross-account billing role',
  tags: {
    Application: 'KostOps',
    ManagedBy:   'CDK',
    Purpose:     'FinOps',
  },
});

app.synth();
