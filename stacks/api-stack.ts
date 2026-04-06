import * as cdk        from 'aws-cdk-lib';
import * as lambda      from 'aws-cdk-lib/aws-lambda';
import * as apigateway  from 'aws-cdk-lib/aws-apigateway';
import * as cognito     from 'aws-cdk-lib/aws-cognito';
import * as ddb         from 'aws-cdk-lib/aws-dynamodb';
import * as iam         from 'aws-cdk-lib/aws-iam';
import * as logs        from 'aws-cdk-lib/aws-logs';
import * as events      from 'aws-cdk-lib/aws-events';
import * as targets     from 'aws-cdk-lib/aws-events-targets';
import { Construct }    from 'constructs';

interface ApiStackProps extends cdk.StackProps {
  findingsTable:           ddb.Table;
  integrationsTable:       ddb.Table;
  conversationsTable:      ddb.Table;
  agentEndpointUrl:        string;
  userPool:                cognito.UserPool;
  slackWebhookUrl:         string;
  athenaWorkgroup:         string;
  athenaResultsBucketName: string;
  agentRuntimeArn:         string;
}

/**
 * KostOpsApiStack
 *
 * Provisions the backend API that the React UI calls:
 *
 *   Lambda functions
 *     chat-handler      — proxies user messages to the AgentCore Runtime endpoint
 *     findings-handler  — CRUD for the DynamoDB findings table
 *     slack-handler     — sends daily digest + anomaly alerts to Slack
 *
 *   API Gateway (REST)
 *     POST /chat                 → chat-handler
 *     GET  /findings             → findings-handler (list)
 *     GET  /findings/{id}        → findings-handler (get)
 *     PATCH /findings/{id}       → findings-handler (update status)
 *     POST /slack/digest         → slack-handler (trigger daily digest)
 *
 *   Cognito authorizer on all routes — every call requires a valid JWT
 */
export class ApiStack extends cdk.Stack {
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    // ── Shared Lambda execution role ──────────────────────────────────────────
    const lambdaRole = new iam.Role(this, 'ApiLambdaRole', {
      assumedBy:   new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for KostOps API Lambda functions',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // DynamoDB access for findings-handler, slack-handler, integrations-handler, chat-sessions-handler
    props.findingsTable.grantReadWriteData(lambdaRole);
    props.integrationsTable.grantReadWriteData(lambdaRole);
    props.conversationsTable.grantReadWriteData(lambdaRole);

    // SSM access for integrations-handler and slack-handler (read/write secrets)
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      sid:     'IntegrationSecrets',
      actions: [
        'ssm:GetParameter',
        'ssm:PutParameter',
        'ssm:DeleteParameter',
        'ssm:DescribeParameters',
      ],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/kostops/integrations/*`],
    }));

    // Invoke AgentCore Runtime for chat-handler
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      sid:       'InvokeAgentCoreRuntime',
      actions:   ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: ['*'],
    }));

    // ── Common Lambda environment variables ───────────────────────────────────
    // Athena permissions for dashboard-handler
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      sid:     'AthenaDashboard',
      actions: [
        'athena:StartQueryExecution',
        'athena:GetQueryExecution',
        'athena:GetQueryResults',
        'glue:GetTable',
        'glue:GetDatabase',
        'glue:GetPartitions',
        's3:GetObject', 's3:PutObject', 's3:DeleteObject',
        's3:ListBucket',
      ],
      resources: ['*'],
    }));

    const commonEnv: Record<string, string> = {
      FINDINGS_TABLE:          props.findingsTable.tableName,
      INTEGRATIONS_TABLE:      props.integrationsTable.tableName,
      CONVERSATIONS_TABLE:     props.conversationsTable.tableName,
      AGENT_ENDPOINT_URL:      props.agentEndpointUrl,
      AGENT_RUNTIME_ARN:       props.agentRuntimeArn,
      SLACK_WEBHOOK_URL:       props.slackWebhookUrl,   // fallback; prefer SSM
      ATHENA_WORKGROUP:        props.athenaWorkgroup,
      ATHENA_RESULTS_BUCKET:   props.athenaResultsBucketName,
      GLUE_DATABASE:           'kostops_cur',
      CUR_TABLE:               'data',
      POWERTOOLS_SERVICE_NAME: 'kostops-api',
      LOG_LEVEL:               'INFO',
    };

    // ── Lambda: chat-handler ──────────────────────────────────────────────────
    const chatHandler = new lambda.Function(this, 'ChatHandler', {
      functionName:  'kostops-chat-handler',
      runtime:       lambda.Runtime.PYTHON_3_12,
      handler:       'chat_handler.handler',
      code:          lambda.Code.fromAsset('lambda'),
      role:          lambdaRole,
      timeout:       cdk.Duration.seconds(300), // Agent can take time to reason
      memorySize:    256,
      environment:   commonEnv,
      logRetention:  logs.RetentionDays.TWO_WEEKS,
    });

    // ── Lambda: chat-sessions-handler ────────────────────────────────────────
    const chatSessionsHandler = new lambda.Function(this, 'ChatSessionsHandler', {
      functionName:  'kostops-chat-sessions-handler',
      runtime:       lambda.Runtime.PYTHON_3_12,
      handler:       'chat_sessions_handler.handler',
      code:          lambda.Code.fromAsset('lambda'),
      role:          lambdaRole,
      timeout:       cdk.Duration.seconds(30),
      memorySize:    128,
      environment:   commonEnv,
      logRetention:  logs.RetentionDays.TWO_WEEKS,
    });

    // ── Lambda: findings-handler ──────────────────────────────────────────────
    const findingsHandler = new lambda.Function(this, 'FindingsHandler', {
      functionName:  'kostops-findings-handler',
      runtime:       lambda.Runtime.PYTHON_3_12,
      handler:       'findings_handler.handler',
      code:          lambda.Code.fromAsset('lambda'),
      role:          lambdaRole,
      timeout:       cdk.Duration.seconds(30),
      memorySize:    128,
      environment:   commonEnv,
      logRetention:  logs.RetentionDays.TWO_WEEKS,
    });

    // ── Lambda: slack-handler ─────────────────────────────────────────────────
    const slackHandler = new lambda.Function(this, 'SlackHandler', {
      functionName:  'kostops-slack-handler',
      runtime:       lambda.Runtime.PYTHON_3_12,
      handler:       'slack_handler.handler',
      code:          lambda.Code.fromAsset('lambda'),
      role:          lambdaRole,
      timeout:       cdk.Duration.seconds(60),
      memorySize:    128,
      environment:   commonEnv,
      logRetention:  logs.RetentionDays.TWO_WEEKS,
    });

    // ── Lambda: integrations-handler ─────────────────────────────────────────
    const integrationsHandler = new lambda.Function(this, 'IntegrationsHandler', {
      functionName:  'kostops-integrations-handler',
      runtime:       lambda.Runtime.PYTHON_3_12,
      handler:       'integrations_handler.handler',
      code:          lambda.Code.fromAsset('lambda'),
      role:          lambdaRole,
      timeout:       cdk.Duration.seconds(30),
      memorySize:    128,
      environment:   commonEnv,
      logRetention:  logs.RetentionDays.TWO_WEEKS,
    });

    // ── Lambda: slack-command-handler ─────────────────────────────────────────
    // Receives Slack slash commands. Needs self-invoke permission for async mode.
    const slackCommandHandler = new lambda.Function(this, 'SlackCommandHandler', {
      functionName:  'kostops-slack-command-handler',
      runtime:       lambda.Runtime.PYTHON_3_12,
      handler:       'slack_command_handler.handler',
      code:          lambda.Code.fromAsset('lambda'),
      role:          lambdaRole,
      timeout:       cdk.Duration.seconds(300),  // async leg calls the agent (up to 5 min)
      memorySize:    256,
      environment:   commonEnv,
      logRetention:  logs.RetentionDays.TWO_WEEKS,
    });

    // Allow slack-command-handler to invoke itself asynchronously
    slackCommandHandler.addToRolePolicy(new iam.PolicyStatement({
      sid:       'SelfInvoke',
      actions:   ['lambda:InvokeFunction'],
      resources: [slackCommandHandler.functionArn],
    }));

    // ── Lambda: dashboard-handler ─────────────────────────────────────────────
    const dashboardHandler = new lambda.Function(this, 'DashboardHandler', {
      functionName:  'kostops-dashboard-handler',
      runtime:       lambda.Runtime.PYTHON_3_12,
      handler:       'dashboard_handler.handler',
      code:          lambda.Code.fromAsset('lambda'),
      role:          lambdaRole,
      timeout:       cdk.Duration.seconds(120), // Athena queries can take up to 2 min
      memorySize:    128,
      environment:   commonEnv,
      logRetention:  logs.RetentionDays.TWO_WEEKS,
    });

    // ── API Gateway account-level CloudWatch Logs role ────────────────────────
    // Required once per account for API Gateway to write access logs to CW.
    const apiGwLogsRole = new iam.Role(this, 'ApiGatewayCloudWatchRole', {
      roleName:    'kostops-apigateway-cloudwatch-role',
      assumedBy:   new iam.ServicePrincipal('apigateway.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonAPIGatewayPushToCloudWatchLogs',
        ),
      ],
    });
    const cfnAccount = new apigateway.CfnAccount(this, 'ApiGatewayAccount', {
      cloudWatchRoleArn: apiGwLogsRole.roleArn,
    });

    // ── API Gateway ───────────────────────────────────────────────────────────
    const api = new apigateway.RestApi(this, 'KostOpsApi', {
      restApiName:   'kostops-api',
      description:   'KostOps FinOps agent API',
      deployOptions: {
        stageName:          'prod',
        throttlingRateLimit:  100,
        throttlingBurstLimit: 200,
        loggingLevel:       apigateway.MethodLoggingLevel.ERROR,
        dataTraceEnabled:   false,
        metricsEnabled:     true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,  // Tightened in frontend-stack via CloudFront
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: [
          'Content-Type',
          'Authorization',
          'X-Amz-Date',
          'X-Api-Key',
          'X-Amz-Security-Token',
        ],
      },
    });

    // ── Cognito authorizer ────────────────────────────────────────────────────
    // Every API call must include Authorization: Bearer <Cognito JWT>
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this, 'KostOpsCognitoAuthorizer',
      {
        cognitoUserPools: [props.userPool],
        authorizerName:   'KostOpsCognitoAuthorizer',
        identitySource:   'method.request.header.Authorization',
        resultsCacheTtl:  cdk.Duration.minutes(5),
      },
    );

    const authOptions: apigateway.MethodOptions = {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    // ── Routes ────────────────────────────────────────────────────────────────

    // POST /chat
    const chatResource = api.root.addResource('chat');
    chatResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(chatHandler, { proxy: true }),
      authOptions,
    );

    // GET  /chat/sessions              — list recent sessions for the caller
    // GET  /chat/sessions/{sessionId}  — get full message history for a session
    const chatSessionsResource  = chatResource.addResource('sessions');
    chatSessionsResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(chatSessionsHandler, { proxy: true }),
      authOptions,
    );
    const chatSessionResource = chatSessionsResource.addResource('{sessionId}');
    chatSessionResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(chatSessionsHandler, { proxy: true }),
      authOptions,
    );

    // GET /findings, PATCH /findings
    const findingsResource = api.root.addResource('findings');
    findingsResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(findingsHandler, { proxy: true }),
      authOptions,
    );

    // GET /findings/{id}, PATCH /findings/{id}
    const findingResource = findingsResource.addResource('{id}');
    findingResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(findingsHandler, { proxy: true }),
      authOptions,
    );
    findingResource.addMethod(
      'PATCH',
      new apigateway.LambdaIntegration(findingsHandler, { proxy: true }),
      authOptions,
    );

    // POST /slack/digest  (authenticated — from UI)
    const slackResource   = api.root.addResource('slack');
    const digestResource  = slackResource.addResource('digest');
    digestResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(slackHandler, { proxy: true }),
      authOptions,
    );

    // POST /slack/command  (NO auth — called directly by Slack API)
    // Slack verifies the request using SLACK_SIGNING_SECRET instead of JWT.
    const commandResource = slackResource.addResource('command');
    commandResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(slackCommandHandler, { proxy: true }),
      { authorizationType: apigateway.AuthorizationType.NONE },
    );

    // GET  /integrations
    // GET  /integrations/{name}
    // PUT  /integrations/{name}
    // DELETE /integrations/{name}
    // POST /integrations/{name}/test
    const integrationsResource = api.root.addResource('integrations');
    integrationsResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(integrationsHandler, { proxy: true }),
      authOptions,
    );
    const integrationResource = integrationsResource.addResource('{name}');
    integrationResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(integrationsHandler, { proxy: true }),
      authOptions,
    );
    integrationResource.addMethod(
      'PUT',
      new apigateway.LambdaIntegration(integrationsHandler, { proxy: true }),
      authOptions,
    );
    integrationResource.addMethod(
      'DELETE',
      new apigateway.LambdaIntegration(integrationsHandler, { proxy: true }),
      authOptions,
    );
    const integrationActionResource = integrationResource.addResource('{action}');
    integrationActionResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(integrationsHandler, { proxy: true }),
      authOptions,
    );

    // GET /dashboard/monthly-spend
    const dashboardResource     = api.root.addResource('dashboard');
    const monthlySpendResource  = dashboardResource.addResource('monthly-spend');
    monthlySpendResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(dashboardHandler, { proxy: true }),
      authOptions,
    );

    // ── Lambda: keepwarm-handler ──────────────────────────────────────────────
    // Pings the AgentCore Runtime every 5 minutes to prevent cold-start timeouts.
    // AgentCore containers spin down after ~5 min of inactivity. Without this,
    // the first user message after idle always hits the 30s init timeout.
    const keepwarmHandler = new lambda.Function(this, 'KeeepwarmHandler', {
      functionName:  'kostops-keepwarm-handler',
      runtime:       lambda.Runtime.PYTHON_3_12,
      handler:       'keepwarm_handler.handler',
      code:          lambda.Code.fromAsset('lambda'),
      role:          lambdaRole,
      timeout:       cdk.Duration.seconds(35),  // slightly over AgentCore 30s init limit
      memorySize:    128,
      environment:   commonEnv,
      logRetention:  logs.RetentionDays.THREE_DAYS,
    });

    // EventBridge rule: ping every 5 minutes (keep AgentCore warm)
    new events.Rule(this, 'AgentKeepWarmRule', {
      ruleName:    'kostops-agent-keepwarm',
      description: 'Keeps AgentCore Runtime container warm to avoid 30s cold-start',
      schedule:    events.Schedule.rate(cdk.Duration.minutes(5)),
      targets:     [new targets.LambdaFunction(keepwarmHandler)],
    });

    // EventBridge rule: daily Slack digest at 09:00 UTC on weekdays
    new events.Rule(this, 'SlackDailyDigestRule', {
      ruleName:    'kostops-slack-daily-digest',
      description: 'Sends KostOps daily findings digest to Slack on weekdays at 9am UTC',
      schedule:    events.Schedule.cron({ minute: '0', hour: '9', weekDay: 'MON-FRI' }),
      targets:     [new targets.LambdaFunction(slackHandler)],
    });

    // Ensure API stage is created after the account-level CW Logs role is set
    api.node.addDependency(cfnAccount);

    this.apiUrl = api.url;

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ApiUrl', {
      value:       api.url,
      description: 'API Gateway URL — set in frontend .env as VITE_API_URL',
    });
  }
}
