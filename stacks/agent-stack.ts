import * as cdk from 'aws-cdk-lib';
import * as iam  from 'aws-cdk-lib/aws-iam';
import * as s3   from 'aws-cdk-lib/aws-s3';
import * as ddb  from 'aws-cdk-lib/aws-dynamodb';
import * as ssm  from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

interface AgentStackProps extends cdk.StackProps {
  findingsTable:              ddb.Table;
  curBucket:                  s3.IBucket;
  athenaResultsBucketName:    string;
  payerAccountId:             string;   // Payer account ID for cross-account trust
  payerCrossAccountRoleArn:   string;   // ARN of kostops-cross-account-role in payer
}

/**
 * KostOpsAgentStack
 *
 * Provisions the IAM role and configuration for the KostOps Strands agent
 * running on Amazon Bedrock AgentCore Runtime.
 *
 * Architecture:
 *   AgentCore Runtime
 *     └── Strands agent (visibility_agent.py)
 *           ├── Custom @tools  → Athena, EC2, DynamoDB  (boto3, IAM role below)
 *           └── AgentCore Gateway MCP sidecars
 *                 ├── awslabs.billing-cost-management-mcp-server
 *                 │     → Cost Explorer, Compute Optimizer, Budgets, Anomalies
 *                 └── awslabs.cloudwatch-mcp-server
 *                       → EC2 CPU metrics, idle detection
 *
 * Cost note: Cost Explorer API = $0.01/call. The agent is instructed to
 * batch queries and cache results in DynamoDB with TTL.
 */
export class AgentStack extends cdk.Stack {
  public readonly agentRoleArn:    string;
  public readonly agentEndpointUrl: string;

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);

    // ── IAM Role for KostOps Agent ────────────────────────────────────────────
    const agentRole = new iam.Role(this, 'KostOpsAgentRole', {
      roleName: 'kostops-agent-role',
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      description: 'Least-privilege role for KostOps Strands agent on AgentCore Runtime',
    });

    // Bedrock: invoke Claude models only
    agentRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockInvoke',
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-*`,
      ],
    }));

    // STS: assume payer cross-account role for Cost Explorer + billing MCP server
    // The agent assumes kostops-cross-account-role in the payer account before
    // calling Cost Explorer, Compute Optimizer, Budgets, and Cost Optimization Hub
    agentRole.addToPolicy(new iam.PolicyStatement({
      sid:     'AssumePayerRole',
      actions: ['sts:AssumeRole'],
      resources: [props.payerCrossAccountRoleArn],
    }));

    // ── Billing / Cost Management MCP server permissions ──────────────────────
    // These cover the awslabs.billing-cost-management-mcp-server tools:
    // Cost Explorer, Compute Optimizer, Budgets, Cost Anomaly Detection, Cost Optimization Hub
    agentRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BillingMCPServer',
      actions: [
        // Cost Explorer
        'ce:GetCostAndUsage',
        'ce:GetCostForecast',
        'ce:GetCostComparison',
        'ce:GetReservationUtilization',
        'ce:GetSavingsPlansPurchaseRecommendation',
        'ce:GetAnomalies',
        'ce:GetAnomalyMonitors',
        'ce:GetDimensionValues',
        'ce:GetTags',
        // Compute Optimizer
        'compute-optimizer:GetEC2InstanceRecommendations',
        'compute-optimizer:GetEBSVolumeRecommendations',
        'compute-optimizer:GetRecommendationSummaries',
        // Budgets
        'budgets:ViewBudget',
        'budgets:DescribeBudgets',
        'budgets:DescribeBudgetPerformanceHistory',
        // Cost Optimization Hub
        'cost-optimization-hub:ListRecommendations',
        'cost-optimization-hub:GetRecommendation',
        'cost-optimization-hub:GetPreferences',
      ],
      resources: ['*'], // Cost Explorer / Budgets have no resource-level permissions
    }));

    // ── CloudWatch MCP server permissions ────────────────────────────────────
    // Covers awslabs.cloudwatch-mcp-server tools for idle EC2 detection
    agentRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchMCPServer',
      actions: [
        'cloudwatch:GetMetricData',
        'cloudwatch:GetMetricStatistics',
        'cloudwatch:ListMetrics',
        'cloudwatch:DescribeAlarms',
      ],
      resources: ['*'],
    }));

    // ── Custom tool permissions (Athena + EC2 + DynamoDB) ────────────────────

    // Athena: run CUR queries
    agentRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AthenaQuery',
      actions: [
        'athena:StartQueryExecution',
        'athena:GetQueryExecution',
        'athena:GetQueryResults',
        'athena:StopQueryExecution',
        'glue:GetTable',
        'glue:GetDatabase',
        'glue:GetPartitions',
      ],
      resources: ['*'],
    }));

    // S3: read CUR data + write Athena query results
    props.curBucket.grantRead(agentRole);
    agentRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AthenaResultsBucket',
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      resources: [`arn:aws:s3:::${props.athenaResultsBucketName}/*`],
    }));
    agentRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AthenaResultsBucketList',
      actions: ['s3:ListBucket'],
      resources: [`arn:aws:s3:::${props.athenaResultsBucketName}`],
    }));

    // EC2: read-only for resource discovery (custom ec2_tools.py)
    agentRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EC2ReadOnly',
      actions: [
        'ec2:DescribeInstances',
        'ec2:DescribeVolumes',
        'ec2:DescribeSnapshots',
        'ec2:DescribeTags',
        'ec2:DescribeRegions',
      ],
      resources: ['*'],
    }));

    // DynamoDB: read + write findings (custom findings_tools.py)
    props.findingsTable.grantReadWriteData(agentRole);

    this.agentRoleArn = agentRole.roleArn;

    // ── AgentCore Runtime configuration ──────────────────────────────────────
    // AgentCore does not yet have a native CDK L2 construct.
    // We store the config in SSM and the deploy_agent.py script reads it
    // to create/update the AgentCore Runtime deployment.
    const agentConfig = {
      agentName: 'kostops-visibility-agent',
      roleArn: agentRole.roleArn,
      codeZipPath: '../agents/',
      entrypoint: 'visibility_agent.app',
      memoryMb: 512,
      timeoutSeconds: 300,
      mcpConfigPath: 'mcp/agent_mcp_config.json',
      environmentVariables: {
        FINDINGS_TABLE:            props.findingsTable.tableName,
        CUR_BUCKET:                props.curBucket.bucketName,
        ATHENA_WORKGROUP:          'kostops-workgroup',
        BEDROCK_MODEL_ID:          'anthropic.claude-3-5-sonnet-20241022-v2:0',
        PAYER_ACCOUNT_ID:          props.payerAccountId,
        PAYER_CROSS_ACCOUNT_ROLE:  props.payerCrossAccountRoleArn,
      },
    };

    new ssm.StringParameter(this, 'AgentConfig', {
      parameterName: '/kostops/agentcore-config',
      stringValue:   JSON.stringify(agentConfig),
      description:   'KostOps AgentCore Runtime deployment config',
    });

    // Placeholder — actual URL set by deploy_agent.py after AgentCore provisioning
    this.agentEndpointUrl =
      `https://bedrock-agentcore.${this.region}.amazonaws.com/agents/kostops-visibility-agent`;

    new cdk.CfnOutput(this, 'AgentRoleArn',     { value: agentRole.roleArn });
    new cdk.CfnOutput(this, 'AgentEndpointUrl', { value: this.agentEndpointUrl });
  }
}
