import * as cdk    from 'aws-cdk-lib';
import * as iam    from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs   from 'aws-cdk-lib/aws-logs';
import * as cr     from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

/**
 * KostOpsQuickSightStack — opt-in, activated with:
 *   cdk deploy --context installQuickSight=true
 *
 * What it does automatically:
 *   1. Creates Athena views (summary_view, account_map) on top of the existing
 *      kostops_cur.data Glue table
 *   2. Creates a QuickSight Athena data source pointing at kostops-workgroup
 *   3. Creates two SPICE datasets from those views
 *   4. Builds the KostOps Cost Overview dashboard (monthly trend, top services,
 *      cost by account, cost by region) using the QuickSight Definition API
 *   5. Triggers the initial SPICE data refresh
 *   6. Returns the dashboard ARN → passed to the embed Lambda env var
 *
 * Prerequisites (two one-time manual steps — cannot be automated):
 *   1. Subscribe to QuickSight Enterprise (ADMIN role required)
 *      https://us-east-1.quicksight.aws.amazon.com/sn/start   (~2 min)
 *   2. Enable Session Capacity Pricing for anonymous embedding
 *      QuickSight → user icon → Manage QuickSight → Manage subscriptions
 *      → Readers → Switch plan → Monthly Capacity → Session Capacity Pricing   (~2 min)
 *
 * After those two steps, cdk deploy does everything else automatically.
 */

interface QuickSightStackProps extends cdk.StackProps {
  /** Athena workgroup that has access to the CUR data (e.g. "kostops-workgroup") */
  athenaWorkgroup:         string;
  /** S3 bucket where Athena writes query results (e.g. "kostops-athena-results-ACCOUNT") */
  athenaResultsBucketName: string;
  /** Glue database name (e.g. "kostops_cur") */
  glueDatabase:            string;
  /** Glue table name (e.g. "data") */
  curTable:                string;
}

export class QuickSightStack extends cdk.Stack {
  /** Full ARN of the deployed KostOps Cost Overview dashboard — passed to ApiStack → embed Lambda */
  public readonly dashboardArn: string;

  constructor(scope: Construct, id: string, props: QuickSightStackProps) {
    super(scope, id, props);

    // ── IAM Role for the Custom Resource Lambda ───────────────────────────────
    const setupRole = new iam.Role(this, 'QuickSightSetupRole', {
      roleName:    'kostops-quicksight-setup-role',
      assumedBy:   new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Allows the KostOps QuickSight setup Lambda to create analytics resources',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole',
        ),
      ],
    });

    // QuickSight — create/manage data sources, datasets, dashboards
    setupRole.addToPolicy(new iam.PolicyStatement({
      sid:     'QuickSightManage',
      actions: [
        'quicksight:CreateDataSource',         'quicksight:DescribeDataSource',
        'quicksight:UpdateDataSource',         'quicksight:DeleteDataSource',
        'quicksight:PassDataSource',           'quicksight:UpdateDataSourcePermissions',
        'quicksight:CreateDataSet',            'quicksight:DescribeDataSet',
        'quicksight:UpdateDataSet',            'quicksight:DeleteDataSet',
        'quicksight:PassDataSet',              'quicksight:UpdateDataSetPermissions',
        'quicksight:CreateIngestion',          'quicksight:DescribeIngestion',
        'quicksight:ListIngestions',           'quicksight:CancelIngestion',
        'quicksight:CreateDashboard',          'quicksight:DescribeDashboard',
        'quicksight:UpdateDashboard',          'quicksight:DeleteDashboard',
        'quicksight:UpdateDashboardPermissions', 'quicksight:UpdateDashboardPublishedVersion',
        'quicksight:DescribeDashboardPermissions', 'quicksight:ListDashboardVersions',
        'quicksight:ListUsers',                'quicksight:DescribeAccountSettings',
        'quicksight:GenerateEmbedUrlForAnonymousUser',
      ],
      resources: ['*'],
    }));

    // Athena — run CREATE VIEW DDL
    setupRole.addToPolicy(new iam.PolicyStatement({
      sid:     'AthenaViews',
      actions: [
        'athena:StartQueryExecution', 'athena:GetQueryExecution',
        'athena:GetQueryResults',
        'glue:GetDatabase',           'glue:GetTable',
        'glue:CreateTable',           'glue:UpdateTable',
        'glue:GetPartitions',
        's3:GetObject',               's3:PutObject',
        's3:ListBucket',              's3:GetBucketLocation',
      ],
      resources: ['*'],
    }));

    // ── Custom Resource Lambda ────────────────────────────────────────────────
    const setupLambda = new lambda.Function(this, 'QuickSightSetupHandler', {
      functionName:  'kostops-quicksight-setup-handler',
      runtime:       lambda.Runtime.PYTHON_3_12,
      handler:       'quicksight_setup_handler.handler',
      code:          lambda.Code.fromAsset('lambda'),
      role:          setupRole,
      timeout:       cdk.Duration.minutes(14),   // dashboard creation + SPICE can be slow
      memorySize:    256,
      environment:   {
        ATHENA_WORKGROUP:      props.athenaWorkgroup,
        ATHENA_RESULTS_BUCKET: props.athenaResultsBucketName,
        GLUE_DATABASE:         props.glueDatabase,
        CUR_TABLE:             props.curTable,
        AWS_ACCOUNT_ID:        this.account,
        AWS_REGION_NAME:       this.region,
        LOG_LEVEL:             'INFO',
      },
      logRetention:  logs.RetentionDays.TWO_WEEKS,
    });

    // ── CDK Custom Resource Provider ──────────────────────────────────────────
    const provider = new cr.Provider(this, 'QuickSightSetupProvider', {
      onEventHandler: setupLambda,
      // No isCompleteHandler — setup Lambda polls synchronously (< 14 min)
    });

    // ── Custom Resource — triggered on every cdk deploy ───────────────────────
    // Changing SchemaVersion forces re-run (useful after CUR schema changes)
    const resource = new cdk.CustomResource(this, 'QuickSightSetup', {
      serviceToken: provider.serviceToken,
      properties:   {
        AthenaWorkgroup:     props.athenaWorkgroup,
        AthenaResultsBucket: props.athenaResultsBucketName,
        GlueDatabase:        props.glueDatabase,
        CurTable:            props.curTable,
        SchemaVersion:       '1',  // bump this to force a re-deploy
      },
    });

    resource.node.addDependency(setupRole);

    // ── Outputs ───────────────────────────────────────────────────────────────
    this.dashboardArn = resource.getAttString('DashboardArn');

    new cdk.CfnOutput(this, 'QuickSightDashboardArn', {
      value:       this.dashboardArn,
      description: 'KostOps Cost Overview dashboard ARN — automatically wired to the embed Lambda',
    });

    new cdk.CfnOutput(this, 'QuickSightConsoleUrl', {
      value:       `https://${this.region}.quicksight.aws.amazon.com/sn/dashboards/kostops-cost-intelligence`,
      description: 'Direct link to the KostOps Cost Intelligence Dashboard in QuickSight',
    });
  }
}
