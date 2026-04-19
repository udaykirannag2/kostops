import * as cdk     from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam     from 'aws-cdk-lib/aws-iam';
import * as cr      from 'aws-cdk-lib/custom-resources';
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

    // ── Admin user + group bootstrap ──────────────────────────────────────────
    // Implemented as AwsCustomResource so we can make BOTH steps idempotent:
    //
    //   1. admin_create_user  — ignore UsernameExistsException (upgrade case:
    //                           the original deploy may have created the user
    //                           manually or via an earlier stack version).
    //   2. admin_add_user_to_group — natively idempotent in Cognito.
    //
    // This means the same CDK code works for a clean first-deploy (creates
    // the user + enrolls in admin) and for upgrade-in-place (user already
    // exists → just enrol in admin, no collision). Cognito sends the welcome
    // email on fresh creates via the `userInvitation` template above.
    //
    // RETAIN on Delete: we never destroy the Cognito user on stack destroy —
    // losing the admin identity on accidental `cdk destroy` is a bigger risk
    // than a leftover user.
    if (props.adminEmail) {
      const adminBootstrap = new cr.AwsCustomResource(this, 'AdminUserBootstrap', {
        resourceType: 'Custom::CognitoAdminBootstrap',
        onCreate: {
          service:    'CognitoIdentityServiceProvider',
          action:     'adminCreateUser',
          parameters: {
            UserPoolId:             this.userPool.userPoolId,
            Username:                props.adminEmail,
            DesiredDeliveryMediums: ['EMAIL'],
            ForceAliasCreation:      true,
            UserAttributes: [
              { Name: 'email',          Value: props.adminEmail },
              { Name: 'email_verified', Value: 'true' },
            ],
          },
          physicalResourceId: cr.PhysicalResourceId.of(`admin-bootstrap-${props.adminEmail}`),
          ignoreErrorCodesMatching: 'UsernameExistsException',
        },
        onUpdate: {
          // Re-enrol in admin group on every stack update; native idempotent.
          service:    'CognitoIdentityServiceProvider',
          action:     'adminAddUserToGroup',
          parameters: {
            UserPoolId: this.userPool.userPoolId,
            Username:   props.adminEmail,
            GroupName:  'admin',
          },
          physicalResourceId: cr.PhysicalResourceId.of(`admin-bootstrap-${props.adminEmail}`),
        },
        onDelete: {
          // Never destroy the admin user on stack delete — safety rail.
          // Use a no-op that always succeeds.
          service:    'CognitoIdentityServiceProvider',
          action:     'listUserPoolClients',
          parameters: { UserPoolId: this.userPool.userPoolId, MaxResults: 1 },
          physicalResourceId: cr.PhysicalResourceId.of(`admin-bootstrap-${props.adminEmail}`),
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: [
              'cognito-idp:AdminCreateUser',
              'cognito-idp:AdminAddUserToGroup',
              'cognito-idp:ListUserPoolClients',
            ],
            resources: [this.userPool.userPoolArn],
          }),
        ]),
        installLatestAwsSdk: false,
      });
      adminBootstrap.node.addDependency(adminGroup);

      // Separately enrol the user in `admin` on FIRST deploy too (onCreate only
      // calls adminCreateUser; a second custom resource handles the group add
      // deterministically on first provision).
      const adminGroupAttach = new cr.AwsCustomResource(this, 'AdminUserGroupJoin', {
        resourceType: 'Custom::CognitoAdminGroupJoin',
        onCreate: {
          service:    'CognitoIdentityServiceProvider',
          action:     'adminAddUserToGroup',
          parameters: {
            UserPoolId: this.userPool.userPoolId,
            Username:   props.adminEmail,
            GroupName:  'admin',
          },
          physicalResourceId: cr.PhysicalResourceId.of(`admin-group-join-${props.adminEmail}`),
        },
        onUpdate: {
          service:    'CognitoIdentityServiceProvider',
          action:     'adminAddUserToGroup',
          parameters: {
            UserPoolId: this.userPool.userPoolId,
            Username:   props.adminEmail,
            GroupName:  'admin',
          },
          physicalResourceId: cr.PhysicalResourceId.of(`admin-group-join-${props.adminEmail}`),
        },
        // No onDelete — leaving the user enrolled in admin is harmless; removing
        // it on stack destroy risks locking out the admin if the destroy aborts.
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions:   ['cognito-idp:AdminAddUserToGroup'],
            resources: [this.userPool.userPoolArn],
          }),
        ]),
        installLatestAwsSdk: false,
      });
      adminGroupAttach.node.addDependency(adminBootstrap);
      adminGroupAttach.node.addDependency(adminGroup);
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
