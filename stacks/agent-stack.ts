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
  /** Bedrock model ID / inference profile (e.g. us.anthropic.claude-sonnet-4-5-20250929-v1:0) */
  bedrockModelId?:            string;
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

    // Bedrock: invoke Claude models via cross-region inference profiles.
    // Inference profiles route requests across multiple regions, so we must
    // allow the foundation model resource in all possible target regions.
    agentRole.addToPolicy(new iam.PolicyStatement({
      sid:     'BedrockInvoke',
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        // Foundation models across all regions a cross-region profile might route to
        'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-*',
        'arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-*',
        'arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-*',
        'arn:aws:bedrock:eu-west-1::foundation-model/anthropic.claude-*',
        'arn:aws:bedrock:eu-west-3::foundation-model/anthropic.claude-*',
        'arn:aws:bedrock:eu-central-1::foundation-model/anthropic.claude-*',
        'arn:aws:bedrock:ap-northeast-1::foundation-model/anthropic.claude-*',
        'arn:aws:bedrock:ap-southeast-1::foundation-model/anthropic.claude-*',
        'arn:aws:bedrock:ap-southeast-2::foundation-model/anthropic.claude-*',
        // Cross-region inference profiles (us.*, eu.*, ap.*, global.*)
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.claude-*`,
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/eu.anthropic.claude-*`,
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/ap.anthropic.claude-*`,
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/global.anthropic.claude-*`,
      ],
    }));

    // STS: assume payer cross-account role (only if configured)
    if (props.payerCrossAccountRoleArn) {
      agentRole.addToPolicy(new iam.PolicyStatement({
        sid:       'AssumePayerRole',
        actions:   ['sts:AssumeRole'],
        resources: [props.payerCrossAccountRoleArn],
      }));
    }

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
          // Remove heavy Rust/.so packages that exceed 30s cold-start init
          '&& for pkg in boto3 botocore s3transfer jmespath urllib3 certifi six',
          '                  cryptography cffi pycparser opentelemetry',
          '                  pydantic pydantic_core pydantic_settings bedrock_agentcore',
          '                  starlette uvicorn httpx httpcore h11 anyio sniffio',
          '                  rpds jsonschema referencing click dotenv; do',
          '  rm -rf /asset-output/$pkg /asset-output/${pkg//-/_}',
          '  rm -rf /asset-output/${pkg}*.dist-info /asset-output/${pkg//-/_}*.dist-info',
          'done',
          // Copy KostOps source files (strands/ overrides pip-installed real package;
          // agents/ is the supervisor + specialist package; agent_entrypoint.py is the new entrypoint).
          '&& cp agent_entrypoint.py visibility_agent.py payer_role.py /asset-output/',
          '&& cp -r agents tools mcp strands /asset-output/',
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

    // AgentCore control plane — create / delete / get / list
    // (no UpdateAgentRuntime — we use delete+create to avoid botocore shape issues)
    deployRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentCoreControl',
      actions: [
        'bedrock-agentcore-control:CreateAgentRuntime',
        'bedrock-agentcore-control:DeleteAgentRuntime',
        'bedrock-agentcore-control:GetAgentRuntime',
        'bedrock-agentcore-control:ListAgentRuntimes',
      ],
      resources: ['*'],
    }));

    // AgentCore data plane — full access for runtime lifecycle management
    // (delete_agent_runtime triggers cascading sub-operations: DeleteWorkloadIdentity,
    // DeleteAgentRuntimeEndpoint, etc. — grant * to avoid permission whack-a-mole)
    deployRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentCoreDataPlane',
      actions: ['bedrock-agentcore:*'],
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
    //
    // Bundle a newer boto3 alongside the Lambda code so the deploy Lambda has
    // botocore >= 1.40 which knows the codeConfiguration shape for
    // bedrock-agentcore-control create_agent_runtime.
    // The Lambda runtime's bundled boto3 is older and serialises codeConfiguration
    // as an unknown field, crashing with KeyError before the request is sent.
    const deployLambda = new lambda.Function(this, 'AgentCoreDeployFn', {
      functionName:  'kostops-agentcore-deploy',
      runtime:       lambda.Runtime.PYTHON_3_12,
      handler:       'agentcore_deploy.handler',
      code:          lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda'), {
        bundling: {
          local: new DeployLambdaBundler(),
          image: cdk.DockerImage.fromRegistry(
            'public.ecr.aws/docker/library/python:3.12-slim'
          ),
          command: ['bash', '-c', [
            'pip install --target /asset-output --quiet boto3',
            '&& cp /asset-input/*.py /asset-output/',
          ].join(' ')],
        },
      }),
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
        EnvBedrockModelId:     props.bedrockModelId ?? 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
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
          BEDROCK_MODEL_ID:          props.bedrockModelId ?? 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
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
        'python3',
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
      // are large Rust/C extensions that blow out the 30s cold-start init timeout.
      //
      // pydantic_core's 4.1 MB ARM64 .so causes dlopen() to exceed 30s by itself.
      // bedrock_agentcore, starlette, uvicorn etc. pull in pydantic_core and are
      // not used by visibility_agent.py (it uses a pure stdlib HTTP server).
      const REMOVE = [
        // Heavy Rust/C extensions — cause >30s cold-start (replaced by local stubs)
        // NOTE: boto3/botocore are NOT removed — AgentCore does NOT pre-install them.
        //       The agent's import boto3 would fail silently, the process would crash,
        //       and AgentCore would time out waiting for GET /ping.
        'pydantic', 'pydantic_core', 'pydantic_settings',
        'bedrock_agentcore',
        // Web frameworks not needed by the stdlib HTTP server
        'starlette', 'uvicorn', 'httpx', 'httpcore', 'h11',
        'anyio', 'sniffio', 'exceptiongroup',
        // strands-agents: replaced by local lightweight stub in strands/
        'strands', 'strands_agents',
        // Other large/unused packages
        'rpds', 'jsonschema', 'referencing', 'jsonschema_specifications',
        'multipart', 'python_multipart', 'sse_starlette', 'httpx_sse',
        'click', 'dotenv', 'python_dotenv',
        'importlib_metadata', 'zipp',
        // MCP SDK — not used by visibility_agent.py (stdlib HTTP server only)
        // Removing it avoids transitively importing pydantic/starlette
        'mcp',
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
      // agent_entrypoint.py is the new AgentCore entry point; it imports
      // agents.supervisor which dispatches to agents.<specialist>. The legacy
      // visibility_agent.py is copied for the single-file fallback during any
      // roll-forward, but the entryPoint in agentcore_deploy.py is agent_entrypoint.py.
      const FILES = ['agent_entrypoint.py', 'visibility_agent.py', 'payer_role.py'];
      for (const f of FILES) {
        const src = pt.join(repoRoot, f);
        if (fse.existsSync(src)) {
          fse.copyFileSync(src, pt.join(outputDir, f));
        }
      }

      // Copy local dirs — 'strands' MUST come after pip install to override the
      // real strands-agents package with the lightweight stub that avoids
      // pydantic_core / telemetry / Bedrock model imports on cold start.
      // 'agents' is the supervisor + specialist package.
      const DIRS = ['agents', 'tools', 'mcp', 'strands'];
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

// ── Deploy Lambda bundler — pip-installs a newer boto3 so codeConfiguration works ──
class DeployLambdaBundler implements cdk.ILocalBundling {
  tryBundle(outputDir: string): boolean {
    const { spawnSync } = require('child_process');
    const fse           = require('fs');
    const pt            = require('path');
    const lambdaDir     = pt.join(__dirname, '..', 'lambda');

    try {
      const pip = spawnSync(
        'python3',
        ['-m', 'pip', 'install', '--target', outputDir, '--quiet', 'boto3'],
        { encoding: 'utf8', stdio: 'pipe' },
      );
      if (pip.status !== 0) {
        console.error('[KostOps] deploy Lambda pip install failed:', pip.stderr);
        return false;
      }

      for (const f of fse.readdirSync(lambdaDir)) {
        if (f.endsWith('.py')) {
          fse.copyFileSync(pt.join(lambdaDir, f), pt.join(outputDir, f));
        }
      }
      return true;
    } catch (err) {
      console.error('[KostOps] deploy Lambda bundling failed:', err);
      return false;
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
