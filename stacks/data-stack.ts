import * as cdk     from 'aws-cdk-lib';
import * as s3      from 'aws-cdk-lib/aws-s3';
import * as athena  from 'aws-cdk-lib/aws-athena';
import * as glue    from 'aws-cdk-lib/aws-glue';
import * as ddb     from 'aws-cdk-lib/aws-dynamodb';
import * as iam     from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

interface DataStackProps extends cdk.StackProps {
  curBucketName: string; // Name of the replicated CUR bucket created by PayerStack
}

/**
 * KostOpsDataStack
 *
 * Provisions all storage and query infrastructure:
 *
 *   S3
 *     curBucket          — imported reference to the replicated CUR bucket
 *                          (created by KostOpsPayerStack, not owned here)
 *     athenaResultsBucket — where Athena writes query output files
 *
 *   Athena
 *     kostops-workgroup  — isolated workgroup with enforced result location
 *                          and per-query data-scanned limit (cost guard)
 *
 *   Glue
 *     kostops_cur        — database that Athena uses to find the CUR table
 *                          The actual table/partitions are created by a Glue
 *                          Crawler (or manually) after the first CUR delivery.
 *
 *   DynamoDB
 *     kostops-findings   — stores savings opportunities surfaced by the agent
 *                          Schema: findingId (PK) + createdAt (SK)
 *                          GSI on status so the UI can filter OPEN findings
 */
export class DataStack extends cdk.Stack {
  /** Reference to the CUR bucket — passed to AgentStack for read permissions */
  public readonly curBucket: s3.IBucket;

  /** Findings table — passed to AgentStack (read/write) and ApiStack (read) */
  public readonly findingsTable: ddb.Table;

  /** Athena results bucket name — passed to AgentStack for write permissions */
  public readonly athenaResultsBucketName: string;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    // ── 1. CUR bucket (imported, not created here) ────────────────────────────
    // This bucket was created by KostOpsPayerStack with the name
    // kostops-cur-<linkedAccountId>. We import it so we can grant
    // the agent role read access in AgentStack.
    this.curBucket = props.curBucketName
      ? s3.Bucket.fromBucketName(this, 'CurBucket', props.curBucketName)
      : s3.Bucket.fromBucketName(this, 'CurBucket', 'kostops-cur-placeholder');

    // ── 2. Athena results bucket ──────────────────────────────────────────────
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

    // ── 3. Athena workgroup ───────────────────────────────────────────────────
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

    // ── 4. Glue database for CUR ──────────────────────────────────────────────
    // Athena uses Glue Data Catalog to find tables.
    // The database is created here; the CUR table schema is created by a
    // Glue Crawler (or manually via deploy_agent.py) after the first CUR
    // delivery lands in the CUR bucket.
    new glue.CfnDatabase(this, 'KostOpsCurDatabase', {
      catalogId:           this.account,
      databaseInput: {
        name:        'kostops_cur',
        description: 'KostOps Cost and Usage Report database',
        locationUri: `s3://${this.curBucket.bucketName}/`,
      },
    });

    // ── 5. DynamoDB findings table ────────────────────────────────────────────
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
  }
}
