import * as cdk     from 'aws-cdk-lib';
import * as athena  from 'aws-cdk-lib/aws-athena';
import * as glue    from 'aws-cdk-lib/aws-glue';
import * as ddb     from 'aws-cdk-lib/aws-dynamodb';
import * as iam     from 'aws-cdk-lib/aws-iam';
import * as lambda  from 'aws-cdk-lib/aws-lambda';
import * as logs    from 'aws-cdk-lib/aws-logs';
import * as s3      from 'aws-cdk-lib/aws-s3';
import * as cr      from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

interface DataStackProps extends cdk.StackProps {
  payerCurBucketName: string; // Name of the existing CUR bucket in the payer account
  payerAccountId:     string; // Payer account ID (12-digit)
}

/**
 * KostOpsDataStack
 *
 * Provisions all storage and query infrastructure:
 *
 *   S3
 *     athenaResultsBucket — where Athena writes query output files
 *
 *   Athena
 *     kostops-workgroup  — isolated workgroup with enforced result location
 *                          and per-query data-scanned limit (cost guard)
 *
 *   Glue
 *     kostops_cur        — database that Athena uses to find the CUR table
 *                          The Glue Crawler reads the payer CUR bucket directly
 *                          via cross-account S3 bucket policy (no replication).
 *
 *   DynamoDB
 *     kostops-findings   — stores savings opportunities surfaced by the agent
 *                          Schema: findingId (PK) + createdAt (SK)
 *                          GSI on status so the UI can filter OPEN findings
 */
export class DataStack extends cdk.Stack {
  /** Findings table — passed to AgentStack (read/write) and ApiStack (read) */
  public readonly findingsTable: ddb.Table;

  /** Integrations table — stores third-party integration metadata (Slack, Jira, etc.) */
  public readonly integrationsTable: ddb.Table;

  /** Conversations table — stores chat session history per user */
  public readonly conversationsTable: ddb.Table;

  /** Athena results bucket name — passed to AgentStack for write permissions */
  public readonly athenaResultsBucketName: string;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    // ── 1. Athena results bucket ──────────────────────────────────────────────
    // Athena writes query output here. Separate from the CUR bucket so we
    // can apply a short lifecycle (7 days) without touching billing data.
    const athenaResultsBucket = new s3.Bucket(this, 'AthenaResultsBucket', {
      bucketName:        `kostops-athena-results-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption:        s3.BucketEncryption.S3_MANAGED,
      enforceSSL:        true,
      lifecycleRules: [{
        // Query results are ephemeral — 7 days is plenty
        expiration: cdk.Duration.days(7),
      }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.athenaResultsBucketName = athenaResultsBucket.bucketName;

    // ── 2. Athena workgroup ───────────────────────────────────────────────────
    // Isolated workgroup for KostOps queries.
    // enforceWorkGroupConfiguration = true means queries cannot override
    // the result location or the data-scanned limit.
    new athena.CfnWorkGroup(this, 'KostOpsWorkgroup', {
      name:        'kostops-workgroup',
      description: 'KostOps CUR query workgroup',
      state:       'ENABLED',
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        // Hard limit: kill any query that scans more than 10 GB
        // Protects against accidental full-table scans on large CUR files
        bytesScannedCutoffPerQuery: 10 * 1024 * 1024 * 1024,
        resultConfiguration: {
          outputLocation: `s3://${athenaResultsBucket.bucketName}/results/`,
          encryptionConfiguration: {
            encryptionOption: 'SSE_S3',
          },
        },
      },
    });

    // ── 2b. Auto-detect CUR parquet prefix ───────────────────────────────────
    // Every customer's CUR bucket has a different prefix structure depending on
    // what they named their report and when they set it up. Rather than asking
    // the customer to find and pass the prefix manually, we scan the bucket for
    // the distinctive 'BILLING_PERIOD=YYYY-MM/' Hive partition pattern that AWS
    // always uses for CUR Athena-compatible exports — and extract the prefix
    // automatically. This Lambda runs once at deploy time (CREATE) and on
    // subsequent deploys (UPDATE) to pick up any prefix changes.
    const detectorFn = new lambda.Function(this, 'CurPrefixDetector', {
      functionName:  'kostops-cur-prefix-detector',
      runtime:       lambda.Runtime.PYTHON_3_12,
      handler:       'cur_prefix_detector.handler',
      code:          lambda.Code.fromAsset('lambda'),
      timeout:       cdk.Duration.seconds(60),
      memorySize:    128,
      logRetention:  logs.RetentionDays.ONE_WEEK,
    });

    // Allow the Lambda to list objects in the payer CUR bucket cross-account.
    // The payer stack already added an S3 bucket policy allowing this linked
    // account (root) to call s3:ListBucket — this IAM policy is the other half.
    detectorFn.addToRolePolicy(new iam.PolicyStatement({
      sid:     'ListPayerCurBucket',
      actions: ['s3:ListBucket'],
      resources: [`arn:aws:s3:::${props.payerCurBucketName}`],
    }));

    // CDK Provider wires the Lambda into CloudFormation custom resource protocol
    const detectorProvider = new cr.Provider(this, 'CurPrefixProvider', {
      onEventHandler: detectorFn,
    });

    const prefixDetection = new cdk.CustomResource(this, 'CurPrefixDetection', {
      serviceToken: detectorProvider.serviceToken,
      properties: { CurBucketName: props.payerCurBucketName },
    });

    // The detected prefix, e.g. "costreports/CUR/data/"
    // Used below for both the Glue database locationUri and the crawler path.
    const curDataPrefix = prefixDetection.getAttString('CurDataPrefix');

    // ── 3. Glue database for CUR ──────────────────────────────────────────────
    // Athena uses Glue Data Catalog to find tables.
    // The database points at the payer CUR bucket in the payer account.
    // The CUR table schema and partitions are populated by the Glue Crawler
    // below after the first CUR delivery lands in the payer bucket.
    new glue.CfnDatabase(this, 'KostOpsCurDatabase', {
      catalogId:           this.account,
      databaseInput: {
        name:        'kostops_cur',
        description: 'KostOps Cost and Usage Report database',
        locationUri: `s3://${props.payerCurBucketName}/${curDataPrefix}`,
      },
    });

    // ── 3a. Glue crawler IAM role ─────────────────────────────────────────────
    // The crawler runs in the LINKED account and reads the payer CUR bucket
    // directly via cross-account S3 bucket policy (set by KostOpsPayerStack).
    // It needs:
    //   - S3 read on the payer CUR bucket (cross-account)
    //   - Glue permissions to create/update tables in kostops_cur database
    const crawlerRole = new iam.Role(this, 'GlueCrawlerRole', {
      roleName:    'kostops-glue-crawler-role',
      assumedBy:   new iam.ServicePrincipal('glue.amazonaws.com'),
      description: 'Role for KostOps Glue crawler to read payer CUR data cross-account',
      managedPolicies: [
        // Gives Glue the baseline CloudWatch logs + Glue Data Catalog permissions
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole'),
      ],
    });

    // Cross-account read access to the payer CUR bucket.
    // The payer account's S3 bucket policy (set by KostOpsPayerStack) allows
    // this linked account to read from the bucket. This policy grants the
    // Glue service role the IAM side of the cross-account permission.
    crawlerRole.addToPolicy(new iam.PolicyStatement({
      sid:     'ReadPayerCurBucket',
      actions: ['s3:GetObject', 's3:ListBucket', 's3:GetBucketLocation'],
      resources: [
        `arn:aws:s3:::${props.payerCurBucketName}`,
        `arn:aws:s3:::${props.payerCurBucketName}/*`,
      ],
    }));

    // ── 3b. Glue crawler ──────────────────────────────────────────────────────
    // Points at the root of the payer CUR bucket and crawls all prefixes.
    // AWS CUR with Athena integration stores data in parquet with the structure:
    //   s3://<payer-cur-bucket>/<report-prefix>/<report-name>/
    //     data/BILLING_PERIOD=YYYY-MM/<uuid>.parquet
    //
    // Schedule: runs daily at 06:00 UTC so schema/partitions stay in sync
    // with new CUR deliveries without any manual steps.
    // Also triggered once immediately at deploy time (see CrawlerBootstrap below).
    const crawler = new glue.CfnCrawler(this, 'KostOpsCurCrawler', {
      name:         'kostops-cur-crawler',
      role:         crawlerRole.roleArn,
      databaseName: 'kostops_cur',
      description:  'Crawls payer CUR parquet data cross-account and updates kostops_cur Glue table',
      // Run every day at 06:00 UTC — keeps partitions fresh after CUR delivery
      schedule: { scheduleExpression: 'cron(0 6 * * ? *)' },
      targets: {
        s3Targets: [{
          // Prefix auto-detected by CurPrefixDetector Lambda at deploy time.
          // Targets only the BILLING_PERIOD= Hive partition directory so the
          // crawler never picks up CSV exports, manifests, or Athena result files.
          path: `s3://${props.payerCurBucketName}/${curDataPrefix}`,
          exclusions: [],
        }],
      },
      schemaChangePolicy: {
        updateBehavior: 'UPDATE_IN_DATABASE',
        deleteBehavior: 'LOG',
      },
      configuration: JSON.stringify({
        Version: 1.0,
        CrawlerOutput: {
          Partitions: { AddOrUpdateBehavior: 'InheritFromTable' },
          Tables:     { AddOrUpdateBehavior: 'MergeNewColumns' },
        },
        Grouping: { TableGroupingPolicy: 'CombineCompatibleSchemas' },
      }),
    });

    // ── 3c. Kick off the crawler immediately at deploy time ───────────────────
    // Customers should not need to run any manual CLI commands after deploy.
    // This custom resource starts the crawler once so that Athena queries work
    // as soon as CUR data already exists in the bucket (which it almost always
    // does for existing payer accounts). If the bucket is empty the crawler
    // completes in seconds with no tables created — harmless.
    const crawlerBootstrap = new cr.AwsCustomResource(this, 'CrawlerBootstrap', {
      resourceType: 'Custom::GlueCrawlerStart',
      onCreate: {
        service:    'Glue',
        action:     'startCrawler',
        parameters: { Name: 'kostops-cur-crawler' },
        physicalResourceId: cr.PhysicalResourceId.of('kostops-cur-crawler-bootstrap'),
        // Ignore AlreadyRunningException — crawler may already be running
        ignoreErrorCodesMatching: 'CrawlerRunningException',
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions:   ['glue:StartCrawler'],
          resources: [`arn:aws:glue:${this.region}:${this.account}:crawler/kostops-cur-crawler`],
        }),
      ]),
    });
    // Must wait for the crawler resource to exist before starting it
    crawlerBootstrap.node.addDependency(crawler);

    // ── 4. DynamoDB findings table ────────────────────────────────────────────
    // Stores savings opportunities (findings) surfaced by the agent.
    //
    // Access patterns:
    //   - Get a single finding by ID        → PK lookup (findingId)
    //   - List all OPEN findings            → GSI on status
    //   - List findings sorted by savings   → GSI on status, scan + sort client-side
    //     (findings are small, < 1 KB each, so client-side sort is fine)
    //
    // Schema:
    //   findingId   (PK, String) — UUID assigned by the agent
    //   createdAt   (SK, String) — ISO 8601 timestamp
    //   status      (GSI PK)    — "OPEN" | "RESOLVED" | "IGNORED"
    //   type        (String)    — "IDLE_EC2" | "UNATTACHED_EBS" | "OLD_SNAPSHOT" |
    //                             "RIGHTSIZING" | "SAVINGS_PLAN" | "OTHER"
    //   title       (String)    — short human-readable title
    //   description (String)    — detail from the agent
    //   resourceId  (String)    — AWS resource ID (optional)
    //   resourceType(String)    — "ec2:instance" | "ec2:volume" | etc. (optional)
    //   estimatedMonthlySavings (Number) — USD
    //   ttl         (Number)    — Unix timestamp; DynamoDB auto-deletes after 30 days
    this.findingsTable = new ddb.Table(this, 'FindingsTable', {
      tableName:   'kostops-findings',
      partitionKey: { name: 'findingId', type: ddb.AttributeType.STRING },
      sortKey:      { name: 'createdAt', type: ddb.AttributeType.STRING },
      billingMode:  ddb.BillingMode.PAY_PER_REQUEST,
      encryption:   ddb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Never lose findings history
    });

    // GSI: status-index — lets the agent and UI query by status efficiently
    this.findingsTable.addGlobalSecondaryIndex({
      indexName:     'status-index',
      partitionKey:  { name: 'status',    type: ddb.AttributeType.STRING },
      sortKey:       { name: 'createdAt', type: ddb.AttributeType.STRING },
      projectionType: ddb.ProjectionType.ALL,
    });

    // GSI: type-index — lets the agent query by finding type
    this.findingsTable.addGlobalSecondaryIndex({
      indexName:     'type-index',
      partitionKey:  { name: 'type',      type: ddb.AttributeType.STRING },
      sortKey:       { name: 'createdAt', type: ddb.AttributeType.STRING },
      projectionType: ddb.ProjectionType.ALL,
    });

    // ── 5. DynamoDB integrations table ───────────────────────────────────────
    // Stores integration metadata (Slack channel, notification prefs, etc.).
    // Secrets (webhook URLs, tokens) are stored separately in SSM SecureString.
    //
    // Schema:
    //   pk   (PK, String) — "INTEGRATION#slack" | "INTEGRATION#jira" | ...
    //   sk   (SK, String) — "CONFIG"
    //   name, enabled, config, configuredAt, updatedAt
    this.integrationsTable = new ddb.Table(this, 'IntegrationsTable', {
      tableName:    'kostops-integrations',
      partitionKey: { name: 'pk', type: ddb.AttributeType.STRING },
      sortKey:      { name: 'sk', type: ddb.AttributeType.STRING },
      billingMode:  ddb.BillingMode.PAY_PER_REQUEST,
      encryption:   ddb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── 6. DynamoDB conversations table ─────────────────────────────────────
    // Stores chat session history so users can resume conversations across
    // browser refreshes and devices. Each item = one chat session.
    //
    // Schema:
    //   userId      (PK, String) — Cognito sub (UUID) from JWT claims
    //   sessionId   (SK, String) — AgentCore runtimeSessionId (UUID)
    //   title       (String)    — first user message, truncated to 80 chars
    //   messages    (String)    — JSON-encoded [{role, content, timestamp}]
    //   messageCount(Number)    — cached count for list view
    //   updatedAt   (String)    — ISO 8601 timestamp of last turn
    //   ttl         (Number)    — Unix epoch; DynamoDB auto-deletes after 30 days
    this.conversationsTable = new ddb.Table(this, 'ConversationsTable', {
      tableName:    'kostops-conversations',
      partitionKey: { name: 'userId',    type: ddb.AttributeType.STRING },
      sortKey:      { name: 'sessionId', type: ddb.AttributeType.STRING },
      billingMode:  ddb.BillingMode.PAY_PER_REQUEST,
      encryption:   ddb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,  // conversations are ephemeral
    });

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AthenaResultsBucketName', {
      value:       athenaResultsBucket.bucketName,
      description: 'Athena query results bucket',
    });
    new cdk.CfnOutput(this, 'FindingsTableName', {
      value:       this.findingsTable.tableName,
      description: 'DynamoDB findings table',
    });
    new cdk.CfnOutput(this, 'AthenaWorkgroup', {
      value:       'kostops-workgroup',
      description: 'Athena workgroup for CUR queries',
    });
    new cdk.CfnOutput(this, 'GlueDatabaseName', {
      value:       'kostops_cur',
      description: 'Glue database name for Athena CUR queries',
    });
    new cdk.CfnOutput(this, 'GlueCrawlerName', {
      value:       'kostops-cur-crawler',
      description: 'Runs automatically daily at 06:00 UTC. Started once at deploy time.',
    });
  }
}
