import * as cdk  from 'aws-cdk-lib';
import * as s3   from 'aws-cdk-lib/aws-s3';
import * as iam  from 'aws-cdk-lib/aws-iam';
import * as ssm  from 'aws-cdk-lib/aws-ssm';
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
 *   1. S3 bucket  kostops-cur-<linkedAccountId>  in the payer account
 *      with S3 Same-Region Replication from the existing CUR bucket
 *   2. Cross-account IAM role  kostops-cross-account-role
 *      trusted by the KostOps agent role in the linked account
 *      with read-only permissions for Cost Explorer, Compute Optimizer,
 *      Budgets, Cost Anomaly Detection, Cost Optimization Hub
 *
 * What the customer does AFTER this stack deploys:
 *   - Nothing. KostOps in the linked account reads the outputs automatically.
 */
export class PayerStack extends cdk.Stack {
  public readonly replicatedBucketName: string;
  public readonly crossAccountRoleArn:  string;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const linkedAccountId   = this.node.tryGetContext('linkedAccountId');
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

    // ── 1. Standardised destination bucket ─────────────────────────────────
    // Naming convention: kostops-cur-<linkedAccountId>
    // Easy to identify, unique per linked account, consistent across all customers
    this.replicatedBucketName = `kostops-cur-${linkedAccountId}`;

    const destinationBucket = new s3.Bucket(this, 'KostOpsCurDestination', {
      bucketName:         this.replicatedBucketName,
      versioned:          true,   // Required for S3 replication
      blockPublicAccess:  s3.BlockPublicAccess.BLOCK_ALL,
      encryption:         s3.BucketEncryption.S3_MANAGED,
      enforceSSL:         true,
      lifecycleRules: [{
        // Keep 13 months — enough for year-over-year comparisons
        expiration: cdk.Duration.days(395),
        // Clean up old versions after 30 days to save costs
        noncurrentVersionExpiration: cdk.Duration.days(30),
      }],
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Never delete billing history
    });

    // Grant the linked account read access to this bucket
    // The KostOps agent in the linked account needs s3:GetObject on this bucket
    destinationBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid:        'AllowLinkedAccountKostOpsRead',
      effect:     iam.Effect.ALLOW,
      principals: [new iam.AccountPrincipal(linkedAccountId)],
      actions:    ['s3:GetObject', 's3:ListBucket', 's3:GetBucketLocation'],
      resources:  [
        destinationBucket.bucketArn,
        `${destinationBucket.bucketArn}/*`,
      ],
    }));

    // ── 2. Replication IAM role ─────────────────────────────────────────────
    // S3 needs a role to perform the replication on its behalf
    const replicationRole = new iam.Role(this, 'CurReplicationRole', {
      roleName:   'kostops-cur-replication-role',
      assumedBy:  new iam.ServicePrincipal('s3.amazonaws.com'),
      description: 'Role used by S3 to replicate CUR data to KostOps destination bucket',
    });

    // Source bucket read permissions
    replicationRole.addToPolicy(new iam.PolicyStatement({
      sid:     'SourceBucketRead',
      actions: [
        's3:GetReplicationConfiguration',
        's3:ListBucket',
      ],
      resources: [`arn:aws:s3:::${payerCurBucketName}`],
    }));
    replicationRole.addToPolicy(new iam.PolicyStatement({
      sid:     'SourceObjectRead',
      actions: [
        's3:GetObjectVersionForReplication',
        's3:GetObjectVersionAcl',
        's3:GetObjectVersionTagging',
      ],
      resources: [`arn:aws:s3:::${payerCurBucketName}/*`],
    }));

    // Destination bucket write permissions
    replicationRole.addToPolicy(new iam.PolicyStatement({
      sid:     'DestinationBucketWrite',
      actions: [
        's3:ReplicateObject',
        's3:ReplicateDelete',
        's3:ReplicateTags',
        's3:GetObjectVersionTagging',
        's3:ObjectOwnerOverrideToBucketOwner',
      ],
      resources: [`${destinationBucket.bucketArn}/*`],
    }));

    // ── 3. S3 Replication configuration on the source bucket ───────────────
    // We use CfnBucketPolicy + CfnBucket to add replication config because
    // the CDK L2 Bucket construct does not support adding replication rules
    // to an existing (imported) bucket.
    new cdk.CfnResource(this, 'CurSourceReplicationConfig', {
      type: 'AWS::S3::BucketReplicationConfiguration',
      properties: {
        Bucket: payerCurBucketName,
        ReplicationConfiguration: {
          Role: replicationRole.roleArn,
          Rules: [{
            Id:     `KostOpsReplicationTo-${linkedAccountId}`,
            Status: 'Enabled',
            Filter: {
              // Replicate the entire bucket — CUR files only
              Prefix: '',
            },
            Destination: {
              Bucket:               destinationBucket.bucketArn,
              StorageClass:         'STANDARD',
              // Transfer ownership so the linked account can read the objects
              AccessControlTranslation: { Owner: 'Destination' },
              Account:              linkedAccountId,
            },
            DeleteMarkerReplication: { Status: 'Disabled' },
          }],
        },
      },
    });

    // ── 4. Cross-account IAM role for Cost Explorer & MCP server ───────────
    // The KostOps agent in the linked account assumes this role to call
    // Cost Explorer, Compute Optimizer, Budgets, and Cost Optimization Hub
    // — all of which only return meaningful data from the payer account.
    this.crossAccountRoleArn = `arn:aws:iam::${this.account}:role/kostops-cross-account-role`;

    const crossAccountRole = new iam.Role(this, 'KostOpsCrossAccountRole', {
      roleName:    'kostops-cross-account-role',
      description: 'Assumed by KostOps agent in linked account to query payer billing APIs',
      assumedBy:   new iam.CompositePrincipal(
        // The linked account's KostOps agent role assumes this
        new iam.AccountPrincipal(linkedAccountId),
        // Also allow the billing MCP server process (runs under agent role)
        new iam.ArnPrincipal(
          `arn:aws:iam::${linkedAccountId}:role/kostops-agent-role`
        ),
      ),
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

    // ── 5. SSM outputs — linked account reads these ────────────────────────
    // The linked account's CDK deploy reads these parameters via cross-account
    // SSM access, avoiding the need to copy/paste ARNs manually.
    new ssm.StringParameter(this, 'ReplicatedBucketNameParam', {
      parameterName: '/kostops/payer/replicated-cur-bucket-name',
      stringValue:   this.replicatedBucketName,
      description:   'KostOps replicated CUR bucket in payer account',
    });

    new ssm.StringParameter(this, 'CrossAccountRoleArnParam', {
      parameterName: '/kostops/payer/cross-account-role-arn',
      stringValue:   crossAccountRole.roleArn,
      description:   'KostOps cross-account IAM role ARN for Cost Explorer',
    });

    // ── Outputs ────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ReplicatedCurBucketName', {
      value:       this.replicatedBucketName,
      description: 'CUR data replicated to this bucket — use as curBucketName in linked account deploy',
      exportName:  `KostOps-ReplicatedCurBucket-${linkedAccountId}`,
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
        `  --context curBucketName=${this.replicatedBucketName} \\`,
        `  --context adminEmail=you@yourcompany.com`,
      ].join('\n'),
      description: 'Run this command next in the linked account',
    });
  }
}
