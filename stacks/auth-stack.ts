import * as cdk     from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

interface AuthStackProps extends cdk.StackProps {
  adminEmail: string; // First admin user — receives temporary password on deploy
}

/**
 * KostOpsAuthStack
 *
 * Provisions Cognito authentication for the KostOps React UI.
 *
 *   User Pool     — stores user accounts, handles sign-in, MFA optional
 *   User Pool Client — used by the React app (Amplify) to call Cognito
 *   Admin user    — created automatically on deploy; temporary password
 *                   sent to adminEmail
 *
 * The API Gateway in ApiStack uses this User Pool as a Cognito authorizer,
 * so every API call must include a valid Cognito JWT.
 */
export class AuthStack extends cdk.Stack {
  public readonly userPool:       cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    // ── User Pool ─────────────────────────────────────────────────────────────
    this.userPool = new cognito.UserPool(this, 'KostOpsUserPool', {
      userPoolName:      'kostops-user-pool',
      selfSignUpEnabled: false,          // Admin-only invitations, no public sign-up
      signInAliases:     { email: true },
      autoVerify:        { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength:        12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits:    true,
        requireSymbols:   false,
        tempPasswordValidity: cdk.Duration.days(7),
      },
      accountRecovery:  cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy:    cdk.RemovalPolicy.RETAIN,
      // Send welcome + password reset emails via Cognito's built-in SES integration
      userInvitation: {
        emailSubject: 'Your KostOps access',
        emailBody:
          'Hello,<br><br>' +
          'Your KostOps account is ready.<br><br>' +
          'Email: <b>{username}</b><br>' +
          'Temporary password: <b>{####}</b><br><br>' +
          'You will be asked to set a new password on first login.',
      },
    });

    // ── User Pool Client ──────────────────────────────────────────────────────
    // Used by the React app (Amplify Auth). No client secret — browser apps
    // cannot keep secrets, so we use the public client flow.
    this.userPoolClient = new cognito.UserPoolClient(this, 'KostOpsUserPoolClient', {
      userPool:               this.userPool,
      userPoolClientName:     'kostops-web-client',
      generateSecret:         false,
      authFlows: {
        userSrp:              true,   // Secure Remote Password — standard browser login
        userPassword:         false,  // Disabled — less secure, not needed
        adminUserPassword:    false,
        custom:               false,
      },
      oAuth: {
        flows:  { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
      },
      // Tokens: short-lived access, long-lived refresh for good UX
      accessTokenValidity:  cdk.Duration.hours(1),
      idTokenValidity:      cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      preventUserExistenceErrors: true,
    });

    // ── Admin user ────────────────────────────────────────────────────────────
    // Created via a CDK custom resource. Cognito sends the temporary password
    // to adminEmail automatically (using the userInvitation template above).
    if (props.adminEmail) {
      new cognito.CfnUserPoolUser(this, 'AdminUser', {
        userPoolId:      this.userPool.userPoolId,
        username:        props.adminEmail,
        desiredDeliveryMediums: ['EMAIL'],
        forceAliasCreation: true,
        userAttributes: [
          { name: 'email',          value: props.adminEmail },
          { name: 'email_verified', value: 'true' },
        ],
      });
    }

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'UserPoolId', {
      value:       this.userPool.userPoolId,
      description: 'Cognito User Pool ID — set in frontend .env as VITE_USER_POOL_ID',
    });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value:       this.userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID — set in frontend .env as VITE_USER_POOL_CLIENT_ID',
    });
  }
}
