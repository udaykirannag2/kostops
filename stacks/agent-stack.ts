import * as path      from 'path';
import * as cdk       from 'aws-cdk-lib';
import * as iam       from 'aws-cdk-lib/aws-iam';
import * as ddb       from 'aws-cdk-lib/aws-dynamodb';
import * as ssm       from 'aws-cdk-lib/aws-ssm';
import * as lambda    from 'aws-cdk-lib/aws-lambda';
import * as logs      from 'aws-cdk-lib/aws-logs';
import * as s3assets  from 'aws-cdk-lib/aws-s3-assets';
import * as cr        from 'aws-cdk-lib/custom-resources';
import { Construct }  from 'constructs';
import * as fs        from 'fs';

interface AgentStackProps extends cdk.StackProps {
  findingsTable:              ddb.Table;
  payerCurBucketName:         string;
  athenaResultsBucketName:    string;
  payerAccountId:             string;
  payerCrossAccountRoleArn:   string;
}

/**
 * KostOpsAgentStack
 *
 * Provisions the IAM role, agent code asset, and AgentCore Runtime for the
 * KostOps Strands agent.
 *
 * How it works:
 *
 *   1. CDK asset bundling  — runs `pip install` locally during `cdk deploy`
 *      to build a self-contained zip (strands-agents + bedrock-agentcore +
 *      KostOps source files).  The zip is uploaded to the CDK assets S3 bucket.
 *
 *   2. Custom Resource Lambda (agentcore_deploy.py)  — called by CloudFormation
 *      during stack Create / Update / Delete.  It calls the AgentCore control-
 *      plane APIs to create or update the Runtime, waits for ACTIVE status,
 *      and writes the runtime ARN to SSM + the chat-handler Lambda env var.
 *
 * Net result: `cdk deploy --all` is the only command customers need to run.
 * There is no separate `python scripts/deploy_agent.py` step.
 */
export class AgentStack extends cdk.Stack {
  public readonly agentRoleArn:    string;
  public readonly agentEndpointUrl: string;
  public readonly agentRuntimeArn: string;

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);

    // ── IAM Role for KostOps Agent (assumed by AgentCore Runtime) ─────────────
    const agentRole = new iam.Role(this, 'KostOpsAgentRole', {
      roleName:   'kostops-agent-role',
      assumedBy:  new iam.CompositePrincipal(
        new iam.ServicePrincipal('bedrock.amazonaws.com'),
        new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      ),
      description: 'Least-privilege role for KostOps Strands agent on AgentCore Runtime',
    });

    // Bedrock: invoke Claude models
    agentRole.addToPolicy(new iam.PolicyStatement({
      sid:     'BedrockInvoke',
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [`arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-*`],
    }));

    // STS: assume payer cross-account role
    agentRole.addToPolicy(new iam.PolicyStatement({
      sid:       'AssumePayerRole',
      actions:   ['sts:AssumeRole'],
      resources: [props.payerCrossAccountRoleArn],
    }));

    // Billing / Cost Management APIs (via payer cross-account role, but listed here for clarity)
    agentRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BillingAPIs',
      actions: [
        'ce:GetCostAndUsage', 'ce:GetCostForecast', 'ce:GetCostComparison',
        'ce:GetReservationUtilization', 'ce:GetSavingsPlansPurchaseRecommendation',
        'ce:GetAnomalies', 'ce:GetAnomalyMonitors', 'ce:GetDimensionValues', 'ce:GetTags',
        'compute-optimizer:GetEC2InstanceRecommendations',
        'compute-optimizer:GetEBSVolumeRecommendations',
        'compute-optimizer:GetRecommendationSummaries',
        'budgets:ViewBudget', 'budgets:DescribeBudgets', 'budgets:DescribeBudgetPerformanceHistory',
        'cost-optimization-hub:ListRecommendations',
        'cost-optimization-hub:GetRecommendation',
        'cost-optimization-hub:GetPreferences',
      ],
      resources: ['*'],
    }));

    // CloudWatch: idle EC2 detection
    agentRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchRead',
      actions: [
        'cloudwatch:GetMetricData', 'cloudwatch:GetMetricStatistics',
        'cloudwatch:ListMetrics',   'cloudwatch:DescribeAlarms',
      ],
      resources: ['*'],
    }));

    // Athena + Glue: CUR queries
    agentRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AthenaQuery',
      actions: [
        'athena:StartQueryExecution', 'athena:GetQueryExecution',
        'athena:GetQueryResults',     'athena:StopQueryExecution',
        'glue:GetTable', 'glue:GetDatabase', 'glue:GetPartitions',
      ],
      resources: ['*'],
    }));

    // S3: payer CUR bucket (cross-account read) + Athena results
    agentRole.addToPolicy(new iam.PolicyStatement({
      sid:     'ReadPayerCurBucket',
      actions: ['s3:GetObject', 's3:ListBucket', 's3:GetBucketLocation'],
      resources: [
        `arn:aws:s3:::${props.payerCurBucketName}`,
        `arn:aws:s3:::${props.payerCurBucketName}/*`,
      ],
    }));
    agentRole.addToPolicy(new iam.PolicyStatement({
      sid:     'AthenaResultsBucket',
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
      resources: [
        `arn:aws:s3:::${props.athenaResultsBucketName}`,
        `arn:aws:s3:::${props.athenaResultsBucketName}/*`,
      ],
    }));

    // EC2: read-only resource discovery
    agentRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EC2ReadOnly',
      actions: [
        'ec2:DescribeInstances', 'ec2:DescribeVolumes',
        'ec2:DescribeSnapshots', 'ec2:DescribeTags', 'ec2:DescribeRegions',
      ],
      resources: ['*'],
    }));

    // DynamoDB: read + write findings
    props.findingsTable.grantReadWriteData(agentRole);

    this.agentRoleArn = agentRole.roleArn;

    // ── Agent code asset — built locally during cdk deploy ────────────────────
    //
    // CDK runs AgentCodeBundler.tryBundle() which:
    //   1. pip installs strands-agents + bedrock-agentcore into outputDir
    //   2. Removes packages pre-installed in AgentCore runtime (boto3, cryptography …)
    //   3. Copies KostOps source files (visibility_agent.py, tools/, mcp/, etc.)
    //
    // CDK then zips outputDir and uploads it to the CDK assets S3 bucket.
    // The Custom Resource Lambda receives the bucket + key via CFN properties.
    const agentAsset = new s3assets.Asset(this, 'AgentCodeAsset', {
      path: path.join(__dirname, '..'),   // repo root
      bundling: {
        // ── Local bundling (runs on the customer's machine, no Docker needed) ──
        local: new AgentCodeBundler(),

        // ── Docker fallback (used if local bundling returns false) ─────────────
        // Requires Docker Desktop running on the customer's machine.
        image:   cdk.DockerImage.fromRegistry(
          'public.ecr.aws/docker/library/python:3.12-slim'
        ),
        command: ['bash', '-c', [
          // Install deps targeting AgentCore's ARM64 Python 3.12 runtime
          'pip install --target /asset-output',
          '--platform manylinux2014_aarch64',
          '--python-version 3.12',
          '--only-binary :all:',
          '--quiet',
          'strands-agents bedrock-agentcore',
          // Remove runtime-provided / unnecessary packages
          '&& for pkg in boto3 botocore s3transfer jmespath urllib3 certifi six',
          '                  cryptography cffi pycparser opentelemetry; do',
          '  rm -rf /asset-output/$pkg /asset-output/${pkg//-/_}',
          '  rm -rf /asset-output/${pkg}*.dist-info /asset-output/${pkg//-/_}*.dist-info',
          'done',
          // Copy KostOps source files
          '&& cp visibility_agent.py payer_role.py /asset-output/',
          '&& cp -r tools mcp /asset-output/',
        ].join(' ')],
        // Mount the repo root so source files are accessible inside Docker
        volumes: [{
          hostPath:      path.join(__dirname, '..'),
          containerPath: '/asset-input',
        }],
        workingDirectory: '/asset-input',
      },
      // Exclude large directories that should never be in the agent zip
      exclude: [
        'node_modules', 'frontend', 'cdk.out', '.git',
        'install-logs', 'scripts', 'stacks', '*.ts', '*.js',
        '__pycache__', '*.pyc', '.env',
      ],
    });

    // The agent runtime role needs to read the zip from the CDK assets bucket
    agentAsset.grantRead(agentRole);

    // ── IAM Role for the Custom Resource deploy Lambda ─────────────────────────
    const deployRole = new iam.Role(this, 'AgentCoreDeployRole', {
      assumedBy:   new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for the AgentCore deployment custom resource Lambda',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // AgentCore control plane — create / update / delete / get / list
    deployRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentCoreControl',
      actions: [
        'bedrock-agentcore-control:CreateAgentRuntime',
        'bedrock-agentcore-control:UpdateAgentRuntime',
        'bedrock-agentcore-control:DeleteAgentRuntime',
        'bedrock-agentcore-control:GetAgentRuntime',
        'bedrock-agentcore-control:ListAgentRuntimes',
      ],
      resources: ['*'],
    }));

    // Pass the agent role to AgentCore
    deployRole.addToPolicy(new iam.PolicyStatement({
      sid:       'PassAgentRole',
      actions:   ['iam:PassRole'],
      resources: [agentRole.roleArn],
    }));

    // Read the agent zip from CDK assets bucket
    agentAsset.grantRead(deployRole);

    // SSM: write the runtime ARN so keepwarm + chat-handler can read it
    deployRole.addToPolicy(new iam.PolicyStatement({
      sid:       'WriteRuntimeArn',
      actions:   ['ssm:PutParameter', 'ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/kostops/*`,
      ],
    }));

    // Lambda: update chat-handler env var with the new runtime ARN
    deployRole.addToPolicy(new iam.PolicyStatement({
      sid:     'UpdateChatHandler',
      actions: ['lambda:GetFunctionConfiguration', 'lambda:UpdateFunctionConfiguration'],
      resources: [
        `arn:aws:lambda:${this.region}:${this.account}:function:kostops-chat-handler`,
      ],
    }));

    // ── Custom Resource Lambda ─────────────────────────────────────────────────
    const deployLambda = new lambda.Function(this, 'AgentCoreDeployFn', {
      functionName:  'kostops-agentcore-deploy',
      runtime:       lambda.Runtime.PYTHON_3_12,
      handler:       'agentcore_deploy.handler',
      code:          lambda.Code.fromAsset('lambda'),
      role:          deployRole,
      timeout:       cdk.Duration.minutes(15),  // wait_for_active polls up to 12 min
      memorySize:    256,
      logRetention:  logs.RetentionDays.ONE_WEEK,
      description:   'CDK custom resource: creates/updates KostOps AgentCore Runtime',
    });

    // ── CDK Custom Resource Provider ───────────────────────────────────────────
    const deployProvider = new cr.Provider(this, 'AgentCoreDeployProvider', {
      onEventHandler: deployLambda,
      // No isCompleteHandler — we poll synchronously inside onEventHandler
      // because AgentCore Runtime creation typically completes within 5 min,
      // well within the 15-min Lambda timeout.
    });

    // ── CloudFormation Custom Resource ─────────────────────────────────────────
    //
    // All props are plain strings so CloudFormation resolves CDK tokens correctly.
    // Changing ANY property (including AssetHash) triggers an Update.
    const agentCoreResource = new cdk.CustomResource(this, 'AgentCoreRuntime', {
      serviceToken: deployProvider.serviceToken,
      properties: {
        AgentName:             'kostopsVisibilityAgent',
        RoleArn:               agentRole.roleArn,
        S3Bucket:              agentAsset.s3BucketName,
        S3Key:                 agentAsset.s3ObjectKey,
        // AssetHash changes whenever the agent code changes → forces a re-deploy
        AssetHash:             agentAsset.assetHash,

        // Environment variables (flat — avoids JSON-serialising CDK tokens)
        EnvFindingsTable:      props.findingsTable.tableName,
        EnvCurBucket:          props.payerCurBucketName,
        EnvAthenaWorkgroup:    'kostops-workgroup',
        EnvAthenaResultsBucket: props.athenaResultsBucketName,
        EnvGlueDatabase:       'kostops_cur',
        EnvCurTable:           'data',
        EnvBedrockModelId:     'anthropic.claude-sonnet-4-5-20250929-v1:0',
        EnvPayerAccountId:     props.payerAccountId,
        EnvPayerRole:          props.payerCrossAccountRoleArn,
      },
    });

    // The custom resource depends on the agent role being fully created first
    agentCoreResource.node.addDependency(agentRole);

    // ── Store config in SSM (still useful for manual debugging) ───────────────
    new ssm.StringParameter(this, 'AgentConfig', {
      parameterName: '/kostops/agentcore-config',
      stringValue:   JSON.stringify({
        agentName:   'kostopsVisibilityAgent',
        roleArn:     agentRole.roleArn,       // token — resolved at deploy time
        environmentVariables: {
          FINDINGS_TABLE:            props.findingsTable.tableName,
          CUR_BUCKET:                props.payerCurBucketName,
          ATHENA_WORKGROUP:          'kostops-workgroup',
          ATHENA_RESULTS_BUCKET:     props.athenaResultsBucketName,
          GLUE_DATABASE:             'kostops_cur',
          CUR_TABLE:                 'data',
          BEDROCK_MODEL_ID:          'anthropic.claude-sonnet-4-5-20250929-v1:0',
          PAYER_ACCOUNT_ID:          props.payerAccountId,
          PAYER_CROSS_ACCOUNT_ROLE:  props.payerCrossAccountRoleArn,
        },
      }),
      description: 'KostOps AgentCore Runtime config — written by CDK',
    });

    // Expose the runtime ARN as a stack output and attribute
    this.agentRuntimeArn = agentCoreResource.getAttString('RuntimeArn');

    this.agentEndpointUrl =
      `https://bedrock-agentcore.${this.region}.amazonaws.com/agents/kostops-visibility-agent`;

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AgentRoleArn',     { value: agentRole.roleArn });
    new cdk.CfnOutput(this, 'AgentRuntimeArn',  { value: this.agentRuntimeArn });
    new cdk.CfnOutput(this, 'AgentEndpointUrl', { value: this.agentEndpointUrl });
  }
}


// ── Local bundler — builds the agent zip on the customer's machine ─────────────
//
// Implements cdk.ILocalBundling so CDK runs this during `cdk deploy` without
// needing Docker.  Returns false if anything fails → CDK falls back to Docker.

class AgentCodeBundler implements cdk.ILocalBundling {
  tryBundle(outputDir: string): boolean {
    const { spawnSync } = require('child_process');
    const fse           = require('fs');
    const pt            = require('path');

    const repoRoot = pt.join(__dirname, '..');

    try {
      console.log('[KostOps] Installing agent dependencies (this takes ~60s)…');

      // ── pip install ──────────────────────────────────────────────────────────
      const pip = spawnSync(
        process.execPath,
        [
          '-m', 'pip', 'install',
          '--target',          outputDir,
          '--platform',        'manylinux2014_aarch64',
          '--python-version',  '3.12',
          '--only-binary',     ':all:',
          '--quiet',
          'strands-agents',
          'bedrock-agentcore',
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      );

      if (pip.status !== 0) {
        console.error('[KostOps] pip install failed:', pip.stderr);
        return false;
      }

      // ── Remove runtime-provided / unnecessary packages ─────────────────────
      // These are either pre-installed in the AgentCore Python 3.12 runtime or
      // are large Rust extensions that blow out cold-start time.
      const REMOVE = [
        'boto3', 'botocore', 's3transfer', 'jmespath',
        'urllib3', 'certifi', 'six',
        'cryptography', 'cffi', 'pycparser',
        'opentelemetry',
      ];

      for (const pkg of REMOVE) {
        for (const candidate of [pkg, pkg.replace(/-/g, '_')]) {
          const pkgDir = pt.join(outputDir, candidate);
          if (fse.existsSync(pkgDir)) {
            fse.rmSync(pkgDir, { recursive: true, force: true });
          }
        }
      }

      // Remove matching .dist-info directories
      for (const entry of fse.readdirSync(outputDir)) {
        const isDistInfo = entry.endsWith('.dist-info') || entry.endsWith('.data');
        if (isDistInfo) {
          const baseName = entry.split('-')[0].toLowerCase();
          if (REMOVE.some(p => p.replace(/-/g, '_').toLowerCase() === baseName)) {
            fse.rmSync(pt.join(outputDir, entry), { recursive: true, force: true });
          }
        }
      }

      // ── Copy KostOps agent source files ────────────────────────────────────
      const FILES = ['visibility_agent.py', 'payer_role.py'];
      for (const f of FILES) {
        const src = pt.join(repoRoot, f);
        if (fse.existsSync(src)) {
          fse.copyFileSync(src, pt.join(outputDir, f));
        }
      }

      const DIRS = ['tools', 'mcp'];
      for (const d of DIRS) {
        const src = pt.join(repoRoot, d);
        if (fse.existsSync(src)) {
          fse.cpSync(src, pt.join(outputDir, d), { recursive: true });
        }
      }

      const zipSizeMb = _dirSizeMb(outputDir);
      console.log(`[KostOps] Agent bundle ready: ${zipSizeMb.toFixed(1)} MB`);
      return true;

    } catch (err) {
      console.error('[KostOps] Local bundling failed:', err);
      return false;   // CDK will fall back to Docker
    }
  }
}

function _dirSizeMb(dir: string): number {
  const fse = require('fs');
  const pt  = require('path');
  let total = 0;
  for (const entry of fse.readdirSync(dir, { withFileTypes: true })) {
    const full = pt.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += _dirSizeMb(full);
    } else {
      total += fse.statSync(full).size;
    }
  }
  return total / (1024 * 1024);
}
