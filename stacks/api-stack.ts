import * as cdk        from 'aws-cdk-lib';
import * as lambda      from 'aws-cdk-lib/aws-lambda';
import * as apigateway  from 'aws-cdk-lib/aws-apigateway';
import * as cognito     from 'aws-cdk-lib/aws-cognito';
import * as ddb         from 'aws-cdk-lib/aws-dynamodb';
import * as iam         from 'aws-cdk-lib/aws-iam';
import * as logs        from 'aws-cdk-lib/aws-logs';
import { Construct }    from 'constructs';

interface ApiStackProps extends cdk.StackProps {
  findingsTable:    ddb.Table;
  agentEndpointUrl: string;
  userPool:         cognito.UserPool;
  slackWebhookUrl:  string;
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

    // DynamoDB access for findings-handler and slack-handler
    props.findingsTable.grantReadWriteData(lambdaRole);

    // Invoke AgentCore endpoint for chat-handler
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      sid:       'InvokeAgentCore',
      actions:   ['bedrock:InvokeAgent', 'bedrock:InvokeAgentAlias'],
      resources: ['*'],
    }));

    // ── Common Lambda environment variables ───────────────────────────────────
    const commonEnv: Record<string, string> = {
      FINDINGS_TABLE:     props.findingsTable.tableName,
      AGENT_ENDPOINT_URL: props.agentEndpointUrl,
      SLACK_WEBHOOK_URL:  props.slackWebhookUrl,
      POWERTOOLS_SERVICE_NAME: 'kostops-api',
      LOG_LEVEL:          'INFO',
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

    // POST /slack/digest
    const slackResource  = api.root.addResource('slack');
    const digestResource = slackResource.addResource('digest');
    digestResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(slackHandler, { proxy: true }),
      authOptions,
    );

    this.apiUrl = api.url;

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ApiUrl', {
      value:       api.url,
      description: 'API Gateway URL — set in frontend .env as VITE_API_URL',
    });
  }
}
