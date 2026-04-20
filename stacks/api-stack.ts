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
  auditEventsTable:        ddb.Table;
  scopesTable:             ddb.Table;
  budgetsTable:            ddb.Table;
  forecastsTable:          ddb.Table;
  scopeActualsTable:       ddb.Table;
  importJobsTable:         ddb.Table;
  allocationRulesTable:    ddb.Table;
  agentEndpointUrl:        string;
  userPool:                cognito.UserPool;
  slackWebhookUrl:         string;
  athenaWorkgroup:         string;
  athenaResultsBucketName: string;
  agentRuntimeArn:         string;
  /** Payer cross-account role — visibility handler assumes this to call Organizations */
  payerCrossAccountRoleArn?: string;
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
    // Every mutation handler appends to the audit log — shared role needs write access
    props.auditEventsTable.grantReadWriteData(lambdaRole);
    // Budget Agent tables (Phase 1)
    props.scopesTable.grantReadWriteData(lambdaRole);
    props.budgetsTable.grantReadWriteData(lambdaRole);
    props.forecastsTable.grantReadWriteData(lambdaRole);
    props.scopeActualsTable.grantReadWriteData(lambdaRole);
    props.importJobsTable.grantReadWriteData(lambdaRole);
    // Allocation rules (Phase 3)
    props.allocationRulesTable.grantReadWriteData(lambdaRole);

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

    // Assume the payer cross-account role so the visibility handler can call
    // Organizations (list accounts, OUs, parents) to build the filter dropdowns.
    if (props.payerCrossAccountRoleArn) {
      lambdaRole.addToPolicy(new iam.PolicyStatement({
        sid:       'AssumePayerRoleForOrgLookups',
        actions:   ['sts:AssumeRole'],
        resources: [props.payerCrossAccountRoleArn],
      }));
    }

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
      FINDINGS_TABLE:            props.findingsTable.tableName,
      INTEGRATIONS_TABLE:        props.integrationsTable.tableName,
      CONVERSATIONS_TABLE:       props.conversationsTable.tableName,
      AUDIT_TABLE:               props.auditEventsTable.tableName,
      SCOPES_TABLE:              props.scopesTable.tableName,
      BUDGETS_TABLE:             props.budgetsTable.tableName,
      FORECASTS_TABLE:           props.forecastsTable.tableName,
      SCOPE_ACTUALS_TABLE:       props.scopeActualsTable.tableName,
      IMPORT_JOBS_TABLE:         props.importJobsTable.tableName,
      ALLOCATIONS_TABLE:         props.allocationRulesTable.tableName,
      USER_POOL_ID:              props.userPool.userPoolId,
      AGENT_ENDPOINT_URL:        props.agentEndpointUrl,
      AGENT_RUNTIME_ARN:         props.agentRuntimeArn,
      SLACK_WEBHOOK_URL:         props.slackWebhookUrl,   // fallback; prefer SSM
      ATHENA_WORKGROUP:          props.athenaWorkgroup,
      ATHENA_RESULTS_BUCKET:     props.athenaResultsBucketName,
      GLUE_DATABASE:             'kostops_cur',
      CUR_TABLE:                 'data',
      PAYER_CROSS_ACCOUNT_ROLE:  props.payerCrossAccountRoleArn ?? '',
      POWERTOOLS_SERVICE_NAME:   'kostops-api',
      LOG_LEVEL:                 'INFO',
    };

    // Members handler gets a dedicated role so its Cognito admin permissions
    // don't get mingled with the shared lambdaRole's default policy. Sharing
    // lambdaRole would combine with the pre-existing slack-command-handler
    // SelfInvoke statement (lambdaRole → slackCommandHandler.functionArn) and
    // cause CFN to flag a circular dependency when any additional handler is
    // introduced that also targets lambdaRole.
    const membersRole = new iam.Role(this, 'MembersLambdaRole', {
      assumedBy:   new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for members_handler - Cognito group mgmt + audit writes',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    props.auditEventsTable.grantReadWriteData(membersRole);
    membersRole.addToPolicy(new iam.PolicyStatement({
      sid:     'CognitoMembersAdmin',
      actions: [
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminDeleteUser',
        'cognito-idp:AdminDisableUser',
        'cognito-idp:AdminEnableUser',
        'cognito-idp:AdminAddUserToGroup',
        'cognito-idp:AdminRemoveUserFromGroup',
        'cognito-idp:AdminListGroupsForUser',
        'cognito-idp:ListUsers',
      ],
      resources: [props.userPool.userPoolArn],
    }));

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

    // Allow slack-command-handler to invoke itself asynchronously.
    // We use a LITERAL ARN (not slackCommandHandler.functionArn) on purpose:
    // referencing the function as a token would insert a CDK edge from the
    // shared lambdaRole's default policy back to slackCommandHandler, creating
    // a CFN cycle (lambdaRole → DefaultPolicy → slackCommandHandler → lambdaRole).
    // The function name is stable (set via `functionName: 'kostops-slack-command-handler'`),
    // so a literal ARN is safe and sidesteps the cycle entirely.
    slackCommandHandler.addToRolePolicy(new iam.PolicyStatement({
      sid:       'SelfInvoke',
      actions:   ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:kostops-slack-command-handler`],
    }));

    // ── Lambda: members-handler ───────────────────────────────────────────────
    // Admin-only Cognito group management for the Members page. Uses its own
    // role (see membersRole above) to avoid participating in the shared
    // lambdaRole cycle triggered by the slack-command-handler SelfInvoke.
    const membersHandler = new lambda.Function(this, 'MembersHandler', {
      functionName:  'kostops-members-handler',
      runtime:       lambda.Runtime.PYTHON_3_12,
      handler:       'members_handler.handler',
      code:          lambda.Code.fromAsset('lambda'),
      role:          membersRole,
      timeout:       cdk.Duration.seconds(30),
      memorySize:    128,
      environment:   commonEnv,
      logRetention:  logs.RetentionDays.TWO_WEEKS,
    });

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

    // ── Lambda: scopes-handler (Budget Agent, Phase 1) ────────────────────────
    const scopesHandler = new lambda.Function(this, 'ScopesHandler', {
      functionName:  'kostops-scopes-handler',
      runtime:       lambda.Runtime.PYTHON_3_12,
      handler:       'scopes_handler.handler',
      code:          lambda.Code.fromAsset('lambda'),
      role:          lambdaRole,
      timeout:       cdk.Duration.seconds(30),
      memorySize:    256,  // OU walk caches live in-memory
      environment:   commonEnv,
      logRetention:  logs.RetentionDays.TWO_WEEKS,
    });

    // ── Lambda: budgets-handler ──────────────────────────────────────────────
    const budgetsHandler = new lambda.Function(this, 'BudgetsHandler', {
      functionName:  'kostops-budgets-handler',
      runtime:       lambda.Runtime.PYTHON_3_12,
      handler:       'budgets_handler.handler',
      code:          lambda.Code.fromAsset('lambda'),
      role:          lambdaRole,
      timeout:       cdk.Duration.seconds(30),
      memorySize:    128,
      environment:   commonEnv,
      logRetention:  logs.RetentionDays.TWO_WEEKS,
    });

    // ── Lambda: budget-import-handler (Phase 2 CSV workflow) ────────────────
    // Serves GET /budgets/template, POST /budgets/import, GET
    // /budgets/import/{jobId}, and POST /budgets/import/{jobId}/commit.
    // Gets a little more memory than the other handlers because CSV parsing +
    // per-row budget transactions can touch DynamoDB many times.
    const budgetImportHandler = new lambda.Function(this, 'BudgetImportHandler', {
      functionName:  'kostops-budget-import-handler',
      runtime:       lambda.Runtime.PYTHON_3_12,
      handler:       'budget_import_handler.handler',
      code:          lambda.Code.fromAsset('lambda'),
      role:          lambdaRole,
      timeout:       cdk.Duration.seconds(120),   // big CSVs may need it
      memorySize:    256,
      environment:   commonEnv,
      logRetention:  logs.RetentionDays.TWO_WEEKS,
    });

    // ── Lambda: forecasts-handler ────────────────────────────────────────────
    const forecastsHandler = new lambda.Function(this, 'ForecastsHandler', {
      functionName:  'kostops-forecasts-handler',
      runtime:       lambda.Runtime.PYTHON_3_12,
      handler:       'forecasts_handler.handler',
      code:          lambda.Code.fromAsset('lambda'),
      role:          lambdaRole,
      timeout:       cdk.Duration.seconds(30),
      memorySize:    128,
      environment:   commonEnv,
      logRetention:  logs.RetentionDays.TWO_WEEKS,
    });

    // ── Lambda: allocations-handler (Phase 3) ───────────────────────────────
    // CRUD + preview for AllocationRules. Preview runs a focused Athena query
    // for the source account's period cost and applies the rule's split pcts.
    const allocationsHandler = new lambda.Function(this, 'AllocationsHandler', {
      functionName:  'kostops-allocations-handler',
      runtime:       lambda.Runtime.PYTHON_3_12,
      handler:       'allocations_handler.handler',
      code:          lambda.Code.fromAsset('lambda'),
      role:          lambdaRole,
      timeout:       cdk.Duration.seconds(90),   // Athena preview can be slow
      memorySize:    256,
      environment:   commonEnv,
      logRetention:  logs.RetentionDays.TWO_WEEKS,
    });

    // ── Lambda: visibility-handler ────────────────────────────────────────────
    // Serves the native Cost Visibility dashboards (Recharts). Replaces the
    // QuickSight embed flow. Handles both /visibility/filters (dropdown options)
    // and /visibility/dashboard (panels filtered by linked account / OU / period).
    const visibilityHandler = new lambda.Function(this, 'VisibilityHandler', {
      functionName:  'kostops-visibility-handler',
      runtime:       lambda.Runtime.PYTHON_3_12,
      handler:       'visibility_handler.handler',
      code:          lambda.Code.fromAsset('lambda'),
      role:          lambdaRole,
      timeout:       cdk.Duration.seconds(120),
      memorySize:    256,  // OU walk + multiple Athena queries
      environment:   commonEnv,
      logRetention:  logs.RetentionDays.TWO_WEEKS,
    });

    // ── Lambda: quicksight-embed-handler ──────────────────────────────────────
    // Serves the /dashboard/quicksight-url route the React EmbedPage hits on
    // every Cost Visibility / Optimization page load. Returns {configured:false}
    // gracefully if the optional QuickSight stack isn't installed, so the UI
    // renders a "Set up QuickSight" card instead of failing to fetch.
    const quicksightEmbedHandler = new lambda.Function(this, 'QuickSightEmbedHandler', {
      functionName:  'kostops-quicksight-embed-handler',
      runtime:       lambda.Runtime.PYTHON_3_12,
      handler:       'quicksight_embed_handler.handler',
      code:          lambda.Code.fromAsset('lambda'),
      role:          lambdaRole,
      timeout:       cdk.Duration.seconds(30),
      memorySize:    128,
      environment:   {
        ...commonEnv,
        AWS_ACCOUNT_ID: this.account,
      },
      logRetention:  logs.RetentionDays.TWO_WEEKS,
    });
    // QuickSight anonymous-embed permissions — broad actions, no resource ARNs
    // because the dashboard ARN is computed per-request and may not exist yet.
    quicksightEmbedHandler.addToRolePolicy(new iam.PolicyStatement({
      sid:     'QuickSightEmbed',
      actions: [
        'quicksight:GenerateEmbedUrlForAnonymousUser',
        'quicksight:GenerateEmbedUrlForRegisteredUser',
        'quicksight:RegisterUser',
        'quicksight:DescribeDashboard',
      ],
      resources: ['*'],
    }));

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

    // /scopes — Budget Agent scope CRUD (Phase 1)
    const scopesResource     = api.root.addResource('scopes');
    scopesResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(scopesHandler, { proxy: true }),
      authOptions,
    );
    scopesResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(scopesHandler, { proxy: true }),
      authOptions,
    );
    const scopeResource      = scopesResource.addResource('{scopeId}');
    scopeResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(scopesHandler, { proxy: true }),
      authOptions,
    );
    scopeResource.addMethod(
      'PUT',
      new apigateway.LambdaIntegration(scopesHandler, { proxy: true }),
      authOptions,
    );
    scopeResource.addMethod(
      'DELETE',
      new apigateway.LambdaIntegration(scopesHandler, { proxy: true }),
      authOptions,
    );
    const effAccountsResource = scopeResource.addResource('effective-accounts');
    effAccountsResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(scopesHandler, { proxy: true }),
      authOptions,
    );

    // /budgets — versioned budget CRUD (Phase 1) + CSV import (Phase 2)
    //   GET  /budgets?scopeId=&period=             current version
    //   GET  /budgets/template                     CSV template (admin)
    //   POST /budgets/import                       preview CSV (admin)
    //   GET  /budgets/import/{jobId}               fetch preview (admin)
    //   POST /budgets/import/{jobId}/commit        apply CSV (admin)
    //   GET  /budgets/{scopeId}/history            all versions
    //   PUT  /budgets/{scopeId}/{period}           new version (admin)
    const budgetsResource       = api.root.addResource('budgets');
    budgetsResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(budgetsHandler, { proxy: true }),
      authOptions,
    );
    const budgetTemplateResource = budgetsResource.addResource('template');
    budgetTemplateResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(budgetImportHandler, { proxy: true }),
      authOptions,
    );
    const budgetImportResource  = budgetsResource.addResource('import');
    budgetImportResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(budgetImportHandler, { proxy: true }),
      authOptions,
    );
    const budgetImportJobResource = budgetImportResource.addResource('{jobId}');
    budgetImportJobResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(budgetImportHandler, { proxy: true }),
      authOptions,
    );
    const budgetImportCommitResource = budgetImportJobResource.addResource('commit');
    budgetImportCommitResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(budgetImportHandler, { proxy: true }),
      authOptions,
    );
    const budgetScopeResource   = budgetsResource.addResource('{scopeId}');
    const budgetHistoryResource = budgetScopeResource.addResource('history');
    budgetHistoryResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(budgetsHandler, { proxy: true }),
      authOptions,
    );
    const budgetPeriodResource  = budgetScopeResource.addResource('{period}');
    budgetPeriodResource.addMethod(
      'PUT',
      new apigateway.LambdaIntegration(budgetsHandler, { proxy: true }),
      authOptions,
    );

    // /allocations — shared-account cost allocation rules (Phase 3)
    //   GET    /allocations                        list active rules
    //   POST   /allocations                        create (admin)
    //   GET    /allocations/{ruleId}               fetch one
    //   PUT    /allocations/{ruleId}               update (admin)
    //   DELETE /allocations/{ruleId}               soft-delete (admin)
    //   POST   /allocations/{ruleId}/preview       project impact for a period (admin)
    const allocationsResource       = api.root.addResource('allocations');
    allocationsResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(allocationsHandler, { proxy: true }),
      authOptions,
    );
    allocationsResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(allocationsHandler, { proxy: true }),
      authOptions,
    );
    const allocationRuleResource    = allocationsResource.addResource('{ruleId}');
    allocationRuleResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(allocationsHandler, { proxy: true }),
      authOptions,
    );
    allocationRuleResource.addMethod(
      'PUT',
      new apigateway.LambdaIntegration(allocationsHandler, { proxy: true }),
      authOptions,
    );
    allocationRuleResource.addMethod(
      'DELETE',
      new apigateway.LambdaIntegration(allocationsHandler, { proxy: true }),
      authOptions,
    );
    const allocationPreviewResource = allocationRuleResource.addResource('preview');
    allocationPreviewResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(allocationsHandler, { proxy: true }),
      authOptions,
    );

    // /forecasts — CE-backed forecasts per scope/period (Phase 1)
    //   GET  /forecasts?scopeId=&period=          list cached
    //   POST /forecasts/{scopeId}/{period}        refresh (admin)
    const forecastsResource     = api.root.addResource('forecasts');
    forecastsResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(forecastsHandler, { proxy: true }),
      authOptions,
    );
    const forecastScope         = forecastsResource.addResource('{scopeId}');
    const forecastPeriod        = forecastScope.addResource('{period}');
    forecastPeriod.addMethod(
      'POST',
      new apigateway.LambdaIntegration(forecastsHandler, { proxy: true }),
      authOptions,
    );

    // /visibility — native Cost Visibility dashboards (replaces QuickSight embed)
    //   GET /visibility/filters       → dropdown options
    //   GET /visibility/dashboard     → filtered panels (type=billing-summary|…)
    const visibilityResource        = api.root.addResource('visibility');
    const filtersResource           = visibilityResource.addResource('filters');
    filtersResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(visibilityHandler, { proxy: true }),
      authOptions,
    );
    const visibilityDashResource    = visibilityResource.addResource('dashboard');
    visibilityDashResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(visibilityHandler, { proxy: true }),
      authOptions,
    );

    // GET /dashboard/quicksight-url — called by every EmbedPage on load
    const quicksightUrlResource = dashboardResource.addResource('quicksight-url');
    quicksightUrlResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(quicksightEmbedHandler, { proxy: true }),
      authOptions,
    );

    // /members — admin-only (enforced inside members_handler via require_admin)
    //   GET    /members         → list members with role
    //   POST   /members         → invite new member
    //   PUT    /members/{sub}   → change role
    //   DELETE /members/{sub}   → disable user
    const membersResource = api.root.addResource('members');
    membersResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(membersHandler, { proxy: true }),
      authOptions,
    );
    membersResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(membersHandler, { proxy: true }),
      authOptions,
    );
    const memberResource = membersResource.addResource('{sub}');
    memberResource.addMethod(
      'PUT',
      new apigateway.LambdaIntegration(membersHandler, { proxy: true }),
      authOptions,
    );
    memberResource.addMethod(
      'DELETE',
      new apigateway.LambdaIntegration(membersHandler, { proxy: true }),
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
