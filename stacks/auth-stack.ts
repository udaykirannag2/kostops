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
 *   User Pool        — stores user accounts, handles sign-in, MFA optional
 *   User Pool Client — used by the React app (Amplify) to call Cognito
 *   User Pool Groups — `admin` (read + write) and `viewer` (read-only) drive
 *                      RBAC across the product. API Gateway's Cognito
 *                      authorizer surfaces group membership to Lambdas as
 *                      `event.requestContext.authorizer.claims['cognito:groups']`,
 *                      which `lambda/common/roles.py::require_admin` checks
 *                      before allowing any mutation.
 *   Admin user       — created automatically on deploy; temporary password
 *                      sent to adminEmail. Bootstrapped into `admin` group
 *                      via a CfnUserPoolUserToGroupAttachment so the first
 *                      invited user can manage subsequent members.
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

    // ── User Pool Groups ─────────────────────────────────────────────────────
    // Two roles drive RBAC across the product:
    //   admin   — full read + write; manages members, budgets, scopes, allocations,
    //             integrations, scans, report definitions, runbook execution.
    //   viewer  — read-only; every mutation is refused at the Lambda layer by
    //             lambda/common/roles.py::require_admin.
    // Groups are stable named resources so membership survives stack updates.
    const adminGroup = new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId:  this.userPool.userPoolId,
      groupName:   'admin',
      description: 'Full read + write across KostOps. Can manage members.',
      precedence:  1,  // Lower precedence = higher priority when a user is in multiple groups
    });
    adminGroup.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    const viewerGroup = new cognito.CfnUserPoolGroup(this, 'ViewerGroup', {
      userPoolId:  this.userPool.userPoolId,
      groupName:   'viewer',
      description: 'Read-only access to KostOps. Cannot mutate any resource.',
      precedence:  10,
    });
    viewerGroup.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    // ── Admin user ────────────────────────────────────────────────────────────
    // Created on first deploy. Cognito sends the temporary password to adminEmail
    // using the userInvitation template above.
    //
    // IMPORTANT: We only create this resource when adminEmail is provided AND
    // use a stable logical ID so CDK never deletes then re-creates the user on
    // subsequent deploys (which would invalidate the user's set password).
    // If adminEmail is omitted, the user must be created manually via:
    //   aws cognito-idp admin-create-user --user-pool-id <id> --username <email> ...
    if (props.adminEmail) {
      const adminUser = new cognito.CfnUserPoolUser(this, 'AdminUser', {
        userPoolId:      this.userPool.userPoolId,
        username:        props.adminEmail,
        desiredDeliveryMediums: ['EMAIL'],
        forceAliasCreation: true,
        userAttributes: [
          { name: 'email',          value: props.adminEmail },
          { name: 'email_verified', value: 'true' },
        ],
      });
      // RETAIN so CDK never deletes the user on stack updates
      adminUser.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

      // Bootstrap the first invited user into the `admin` group so they can
      // subsequently promote/demote other members via the Members page.
      // All later invitees default to `viewer` until an admin promotes them.
      const adminAttachment = new cognito.CfnUserPoolUserToGroupAttachment(this, 'AdminUserGroupAttachment', {
        userPoolId: this.userPool.userPoolId,
        username:   props.adminEmail,
        groupName:  'admin',
      });
      adminAttachment.node.addDependency(adminUser);
      adminAttachment.node.addDependency(adminGroup);
      adminAttachment.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
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
