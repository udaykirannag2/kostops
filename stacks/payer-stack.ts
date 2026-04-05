import * as cdk  from 'aws-cdk-lib';
import * as iam  from 'aws-cdk-lib/aws-iam';
import * as ssm  from 'aws-cdk-lib/aws-ssm';
import * as cr   from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

/**
 * KostOpsPayerStack
 * -----------------
 * Deployed ONCE into the AWS payer (management) account.
 * Customer runs one command and this handles everything:
 *
 *   cdk deploy KostOpsPayerStack \
 *     --context linkedAccountId=123456789012 \
 *     --context payerCurBucketName=my-existing-cur-bucket
 *
 * What it creates:
 *   1. S3 bucket policy on the existing CUR bucket granting the linked account
 *      direct read access (no replication — no duplicate storage cost)
 *   2. Cross-account IAM role  kostops-cross-account-role
 *      trusted by the KostOps agent role in the linked account
 *      with read-only permissions for Cost Explorer, Compute Optimizer,
 *      Budgets, Cost Anomaly Detection, Cost Optimization Hub
 *   3. SSM parameters /kostops/payer/* for the linked account deploy to read
 *
 * What the customer does AFTER this stack deploys:
 *   - Nothing. KostOps in the linked account reads the outputs automatically.
 */
export class PayerStack extends cdk.Stack {
  public readonly crossAccountRoleArn: string;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const linkedAccountId    = this.node.tryGetContext('linkedAccountId');
    const payerCurBucketName = this.node.tryGetContext('payerCurBucketName');

    if (!linkedAccountId) {
      throw new Error(
        'Missing required context: linkedAccountId\n' +
        'Usage: cdk deploy KostOpsPayerStack --context linkedAccountId=<12-digit-account-id> --context payerCurBucketName=<bucket-name>'
      );
    }
    if (!payerCurBucketName) {
      throw new Error(
        'Missing required context: payerCurBucketName\n' +
        'Usage: cdk deploy KostOpsPayerStack --context linkedAccountId=<12-digit-account-id> --context payerCurBucketName=<bucket-name>'
      );
    }

    // ── 1. Cross-account S3 bucket policy on the existing CUR bucket ───────
    // Grants the linked account read access directly to the payer CUR bucket.
    // No S3 replication — the Glue crawler in the linked account reads objects
    // from this bucket in-place, eliminating duplicate storage costs.
    //
    // IMPORTANT: This bucket already has an existing billing service policy
    // (set by AWS when CUR was enabled). CloudFormation's AWS::S3::BucketPolicy
    // resource refuses to CREATE over an existing policy on an unmanaged bucket.
    // We use AwsCustomResource to call s3:PutBucketPolicy directly, which merges
    // our new statement with the existing billing service statements.
    //
    // The merged policy includes:
    //   1. Existing billing service statements (required for CUR delivery)
    //   2. New statement allowing the linked account to read CUR data
    const mergedBucketPolicy = {
      Version: '2008-10-17',
      Id:      'KostOpsCurBucketPolicy',
      Statement: [
        // ── Existing billing service statements (required for CUR delivery) ──
        {
          Sid:    'AllowBillingAclCheck',
          Effect: 'Allow',
          Principal: { Service: 'billingreports.amazonaws.com' },
          Action:    ['s3:GetBucketAcl', 's3:GetBucketPolicy'],
          Resource:  `arn:aws:s3:::${payerCurBucketName}`,
          Condition: {
            StringEquals: {
              'aws:SourceArn':     `arn:aws:cur:us-east-1:${this.account}:definition/*`,
              'aws:SourceAccount': this.account,
            },
          },
        },
        {
          Sid:    'AllowBillingDelivery',
          Effect: 'Allow',
          Principal: { Service: 'billingreports.amazonaws.com' },
          Action:   's3:PutObject',
          Resource: `arn:aws:s3:::${payerCurBucketName}/*`,
          Condition: {
            StringEquals: {
              'aws:SourceArn':     `arn:aws:cur:us-east-1:${this.account}:definition/*`,
              'aws:SourceAccount': this.account,
            },
          },
        },
        // ── KostOps: allow linked account Glue/Athena to read CUR data ──────
        {
          Sid:    'AllowLinkedAccountKostOpsRead',
          Effect: 'Allow',
          Principal: { AWS: `arn:aws:iam::${linkedAccountId}:root` },
          Action:   ['s3:GetObject', 's3:ListBucket', 's3:GetBucketLocation'],
          Resource: [
            `arn:aws:s3:::${payerCurBucketName}`,
            `arn:aws:s3:::${payerCurBucketName}/*`,
          ],
        },
      ],
    };

    // Original policy to restore on stack deletion (removes KostOps statement)
    const originalBucketPolicy = {
      Version: '2008-10-17',
      Id:      'Policy1335892530063',
      Statement: [
        {
          Sid:    'Stmt1335892150622',
          Effect: 'Allow',
          Principal: { Service: 'billingreports.amazonaws.com' },
          Action:    ['s3:GetBucketAcl', 's3:GetBucketPolicy'],
          Resource:  `arn:aws:s3:::${payerCurBucketName}`,
          Condition: {
            StringEquals: {
              'aws:SourceArn':     `arn:aws:cur:us-east-1:${this.account}:definition/*`,
              'aws:SourceAccount': this.account,
            },
          },
        },
        {
          Sid:    'Stmt1335892526596',
          Effect: 'Allow',
          Principal: { Service: 'billingreports.amazonaws.com' },
          Action:   's3:PutObject',
          Resource: `arn:aws:s3:::${payerCurBucketName}/*`,
          Condition: {
            StringEquals: {
              'aws:SourceArn':     `arn:aws:cur:us-east-1:${this.account}:definition/*`,
              'aws:SourceAccount': this.account,
            },
          },
        },
      ],
    };

    new cr.AwsCustomResource(this, 'PayerCurBucketPolicy', {
      resourceType: 'Custom::S3BucketPolicy',
      onCreate: {
        service:    'S3',
        action:     'putBucketPolicy',
        parameters: {
          Bucket: payerCurBucketName,
          Policy: JSON.stringify(mergedBucketPolicy),
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${payerCurBucketName}-kostops-policy`),
      },
      onUpdate: {
        service:    'S3',
        action:     'putBucketPolicy',
        parameters: {
          Bucket: payerCurBucketName,
          Policy: JSON.stringify(mergedBucketPolicy),
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${payerCurBucketName}-kostops-policy`),
      },
      onDelete: {
        service:    'S3',
        action:     'putBucketPolicy',
        parameters: {
          Bucket: payerCurBucketName,
          Policy: JSON.stringify(originalBucketPolicy),
        },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions:   ['s3:PutBucketPolicy', 's3:GetBucketPolicy'],
          resources: [`arn:aws:s3:::${payerCurBucketName}`],
        }),
      ]),
    });

    // ── 2. Cross-account IAM role for Cost Explorer & MCP server ───────────
    // The KostOps agent in the linked account assumes this role to call
    // Cost Explorer, Compute Optimizer, Budgets, and Cost Optimization Hub
    // — all of which only return meaningful data from the payer account.
    this.crossAccountRoleArn = `arn:aws:iam::${this.account}:role/kostops-cross-account-role`;

    const crossAccountRole = new iam.Role(this, 'KostOpsCrossAccountRole', {
      roleName:    'kostops-cross-account-role',
      description: 'Assumed by KostOps agent in linked account to query payer billing APIs',
      // Trust the entire linked account — the restriction is enforced by the
      // sts:AssumeRole permission on kostops-agent-role in the linked account.
      // We cannot reference the agent role ARN here because it doesn't exist
      // yet when this payer stack is deployed (chicken-and-egg problem).
      assumedBy: new iam.AccountPrincipal(linkedAccountId),
      maxSessionDuration: cdk.Duration.hours(1),
    });

    // ── Cost Explorer — consolidated billing data ─────────────────────────
    crossAccountRole.addToPolicy(new iam.PolicyStatement({
      sid:     'CostExplorer',
      effect:  iam.Effect.ALLOW,
      actions: [
        'ce:GetCostAndUsage',
        'ce:GetCostForecast',
        'ce:GetCostComparison',
        'ce:GetReservationUtilization',
        'ce:GetReservationPurchaseRecommendation',
        'ce:GetSavingsPlansPurchaseRecommendation',
        'ce:GetSavingsPlansUtilization',
        'ce:GetAnomalies',
        'ce:GetAnomalyMonitors',
        'ce:GetAnomalySubscriptions',
        'ce:GetDimensionValues',
        'ce:GetTags',
        'ce:GetUsageForecast',
        'ce:ListCostAllocationTags',
      ],
      resources: ['*'], // Cost Explorer has no resource-level permissions
    }));

    // ── Compute Optimizer — rightsizing recommendations ───────────────────
    crossAccountRole.addToPolicy(new iam.PolicyStatement({
      sid:     'ComputeOptimizer',
      effect:  iam.Effect.ALLOW,
      actions: [
        'compute-optimizer:GetEC2InstanceRecommendations',
        'compute-optimizer:GetEC2RecommendationProjectedMetrics',
        'compute-optimizer:GetEBSVolumeRecommendations',
        'compute-optimizer:GetLambdaFunctionRecommendations',
        'compute-optimizer:GetRDSInstanceRecommendations',
        'compute-optimizer:GetRecommendationSummaries',
        'compute-optimizer:GetEnrollmentStatus',
      ],
      resources: ['*'],
    }));

    // ── Budgets — budget status and alerts ────────────────────────────────
    crossAccountRole.addToPolicy(new iam.PolicyStatement({
      sid:     'Budgets',
      effect:  iam.Effect.ALLOW,
      actions: [
        'budgets:ViewBudget',
        'budgets:DescribeBudgets',
        'budgets:DescribeBudgetPerformanceHistory',
        'budgets:DescribeBudgetActionsForBudget',
        'budgets:DescribeBudgetActionsForAccount',
      ],
      resources: ['*'],
    }));

    // ── Cost Optimization Hub ─────────────────────────────────────────────
    crossAccountRole.addToPolicy(new iam.PolicyStatement({
      sid:     'CostOptimizationHub',
      effect:  iam.Effect.ALLOW,
      actions: [
        'cost-optimization-hub:ListRecommendations',
        'cost-optimization-hub:GetRecommendation',
        'cost-optimization-hub:GetPreferences',
        'cost-optimization-hub:ListEnrollmentStatuses',
      ],
      resources: ['*'],
    }));

    // ── Organizations — read account metadata (names, OUs) ───────────────
    crossAccountRole.addToPolicy(new iam.PolicyStatement({
      sid:     'OrganizationsRead',
      effect:  iam.Effect.ALLOW,
      actions: [
        'organizations:ListAccounts',
        'organizations:DescribeAccount',
        'organizations:ListAccountsForParent',
        'organizations:DescribeOrganization',
      ],
      resources: ['*'],
    }));

    // ── 3. SSM outputs — linked account reads these ────────────────────────
    // The linked account's CDK deploy reads these parameters via cross-account
    // SSM access, avoiding the need to copy/paste ARNs manually.
    new ssm.StringParameter(this, 'PayerCurBucketNameParam', {
      parameterName: '/kostops/payer/cur-bucket-name',
      stringValue:   payerCurBucketName,
      description:   'KostOps payer CUR bucket name — linked account Glue crawler reads directly',
    });

    new ssm.StringParameter(this, 'CrossAccountRoleArnParam', {
      parameterName: '/kostops/payer/cross-account-role-arn',
      stringValue:   crossAccountRole.roleArn,
      description:   'KostOps cross-account IAM role ARN for Cost Explorer',
    });

    // ── Outputs ────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'PayerCurBucketName', {
      value:       payerCurBucketName,
      description: 'Payer CUR bucket — linked account Glue/Athena reads this directly (no replication)',
      exportName:  `KostOps-PayerCurBucket-${linkedAccountId}`,
    });

    new cdk.CfnOutput(this, 'CrossAccountRoleArn', {
      value:       crossAccountRole.roleArn,
      description: 'Cross-account role ARN — automatically used by KostOps agent',
      exportName:  `KostOps-CrossAccountRole-${linkedAccountId}`,
    });

    new cdk.CfnOutput(this, 'NextStep', {
      value: [
        `Payer setup complete. Now deploy KostOps in the linked account (${linkedAccountId}):`,
        `cdk deploy --all \\`,
        `  --context payerAccountId=${this.account} \\`,
        `  --context payerCrossAccountRoleArn=${crossAccountRole.roleArn} \\`,
        `  --context payerCurBucketName=${payerCurBucketName} \\`,
        `  --context adminEmail=you@yourcompany.com`,
      ].join('\n'),
      description: 'Run this command next in the linked account',
    });
  }
}
