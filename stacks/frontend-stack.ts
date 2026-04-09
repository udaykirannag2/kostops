import * as cdk        from 'aws-cdk-lib';
import * as iam        from 'aws-cdk-lib/aws-iam';
import * as s3         from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins    from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy   from 'aws-cdk-lib/aws-s3-deployment';
import * as cr         from 'aws-cdk-lib/custom-resources';
import { Construct }   from 'constructs';
import * as fs         from 'fs';
import * as path       from 'path';

interface FrontendStackProps extends cdk.StackProps {
  apiUrl:           string;
  userPoolId:       string;
  userPoolClientId: string;
}

/**
 * KostOpsFrontendStack
 *
 * Hosts the React UI as a static site:
 *
 *   S3 bucket (private)        — stores the built React app
 *   CloudFront distribution    — serves the app over HTTPS globally
 *   Origin Access Control      — CloudFront reads S3; bucket is never public
 *   BucketDeployment           — copies frontend/dist/ to S3 on every cdk deploy
 *   RuntimeConfig custom res.  — writes /runtime-config.json with real Cognito
 *                                + API values; fetched by the React app at startup
 *
 * Why runtime-config.json instead of Vite env vars?
 *   CDK props (userPoolId etc.) are token strings at synthesis time.  Vite bakes
 *   env vars at BUILD time, so it would embed the literal "${Token[TOKEN.10]}"
 *   — breaking Cognito.  runtime-config.json is written by an AwsCustomResource
 *   AFTER CloudFormation resolves real values, so it always contains real IDs.
 *   For local dev, copy frontend/.env.example → frontend/.env with real values.
 *
 * Cross-stack reference note:
 *   We deliberately resolve Cognito/API values via `aws cloudformation describe-stacks`
 *   at synthesis time (real strings) rather than via CDK tokens.  Using CDK tokens
 *   in an AwsCustomResource body creates a CFN Fn::ImportValue dependency on
 *   ApiStack/AuthStack — which breaks if those stacks are redeployed.  Real strings
 *   have no cross-stack CFN dependency at all.
 */
export class FrontendStack extends cdk.Stack {
  public readonly siteUrl: string;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    // ── Resolve real Cognito + API values ─────────────────────────────────────
    // Reads from already-deployed CloudFormation stack outputs (real strings).
    // Falls back gracefully when stacks don't exist yet (first deploy).
    const resolved = _resolveFromCfn(props);

    // ── Auto-build the React app ──────────────────────────────────────────────
    // The JS bundle does NOT embed any Cognito/API values; they come from
    // /runtime-config.json at runtime.  So the build works with a blank .env.
    const frontendDir = path.join(__dirname, '..', 'frontend');
    const distDir     = path.join(frontendDir, 'dist');
    const nmDir       = path.join(frontendDir, 'node_modules');
    const { spawnSync } = require('child_process');

    // Ensure .env exists so Vite doesn't warn about missing vars.
    const envPath = path.join(frontendDir, '.env');
    if (!fs.existsSync(envPath)) {
      fs.writeFileSync(envPath, [
        '# Runtime config is served from /runtime-config.json (written by CDK deploy).',
        '# For local dev only: copy .env.example to .env and fill in real values.',
        'VITE_USER_POOL_ID=',
        'VITE_USER_POOL_CLIENT_ID=',
        'VITE_API_URL=',
        '',
      ].join('\n'));
    }

    if (!fs.existsSync(nmDir)) {
      console.log('[KostOps] npm install in frontend/…');
      const r = spawnSync('npm', ['install', '--prefer-offline'], {
        cwd: frontendDir, encoding: 'utf8', stdio: 'inherit', shell: true,
      });
      if (r.status !== 0) throw new Error(`frontend npm install failed (exit ${r.status})`);
    }

    if (!fs.existsSync(path.join(distDir, 'index.html'))) {
      console.log('[KostOps] Building React app (npm run build)…');
      const r = spawnSync('npm', ['run', 'build'], {
        cwd: frontendDir, encoding: 'utf8', stdio: 'inherit', shell: true,
      });
      if (r.status !== 0) throw new Error(`frontend npm run build failed (exit ${r.status})`);
      console.log('[KostOps] React build complete');
    }

    // ── S3 bucket ─────────────────────────────────────────────────────────────
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName:        `kostops-frontend-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption:        s3.BucketEncryption.S3_MANAGED,
      enforceSSL:        true,
      removalPolicy:     cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ── CloudFront distribution ───────────────────────────────────────────────
    const oac = new cloudfront.S3OriginAccessControl(this, 'SiteOAC', {
      description: 'KostOps frontend OAC',
    });

    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      comment: 'KostOps React UI',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket, {
          originAccessControl: oac,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy:          cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods:       cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        compress:             true,
      },
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.seconds(0) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.seconds(0) },
      ],
      defaultRootObject: 'index.html',
      httpVersion:       cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
    });

    // ── Deploy React build to S3 ──────────────────────────────────────────────
    new s3deploy.BucketDeployment(this, 'SiteDeployment', {
      sources:           [s3deploy.Source.asset(distDir)],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
      memoryLimit:       256,
    });

    // ── Write runtime-config.json ─────────────────────────────────────────────
    // Uses REAL string values (not CDK tokens) to avoid any CFN cross-stack
    // Fn::ImportValue dependency.  The AwsCustomResource Lambda puts the JSON
    // file directly into S3 — no CFN export/import involved.
    //
    // If resolved values are placeholders (first deploy, stacks not yet up),
    // the file is still written with those placeholders.  A second `cdk deploy
    // KostOpsFrontendStack` after AuthStack + ApiStack are deployed will fix it.
    if (resolved.hasRealValues) {
      new cr.AwsCustomResource(this, 'RuntimeConfigDeployment', {
        resourceType: 'Custom::RuntimeConfig',
        // Update on every deploy so config stays current
        onUpdate: {
          service:   'S3',
          action:    'putObject',
          parameters: {
            Bucket:       siteBucket.bucketName,
            Key:          'runtime-config.json',
            ContentType:  'application/json',
            CacheControl: 'no-store, no-cache, must-revalidate',
            // Plain JSON string — no CDK tokens, no CFN Fn::ImportValue
            Body: JSON.stringify({
              userPoolId:       resolved.userPoolId,
              userPoolClientId: resolved.userPoolClientId,
              apiUrl:           resolved.apiUrl,
            }),
          },
          physicalResourceId: cr.PhysicalResourceId.of(
            // Change every deploy so the file is always refreshed
            `runtime-config-${resolved.userPoolId}`
          ),
        },
        onDelete: {
          service:    'S3',
          action:     'deleteObject',
          parameters: { Bucket: siteBucket.bucketName, Key: 'runtime-config.json' },
          physicalResourceId: cr.PhysicalResourceId.of('runtime-config-delete'),
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions:   ['s3:PutObject', 's3:DeleteObject'],
            resources: [siteBucket.arnForObjects('runtime-config.json')],
          }),
        ]),
      }).node.addDependency(siteBucket);
    } else {
      console.warn('[KostOps] Skipping runtime-config.json: AuthStack/ApiStack not yet deployed.');
      console.warn('[KostOps] After deploying those stacks, re-run: cdk deploy KostOpsFrontendStack');
    }

    this.siteUrl = `https://${distribution.distributionDomainName}`;

    new cdk.CfnOutput(this, 'SiteUrl', {
      value: this.siteUrl,
      description: 'KostOps UI — open this in your browser',
    });
    new cdk.CfnOutput(this, 'DistributionId', {
      value:       distribution.distributionId,
      description: 'CloudFront distribution ID (for manual cache invalidation)',
    });
  }
}


// ── Helpers ───────────────────────────────────────────────────────────────────

interface ResolvedConfig {
  userPoolId:       string;
  userPoolClientId: string;
  apiUrl:           string;
  hasRealValues:    boolean;
}

/**
 * Read real post-deploy values from CloudFormation outputs at synthesis time.
 *
 * CDK props at synthesis time are unresolved tokens. This function shells out
 * to `aws cloudformation describe-stacks` to get actual values from already-
 * deployed stacks. Using real strings (not CDK tokens) in the AwsCustomResource
 * body prevents CFN cross-stack Fn::ImportValue dependencies that break when
 * those stacks are later redeployed without the same exports.
 *
 * If stacks aren't deployed yet (first deploy), returns placeholder strings and
 * sets hasRealValues=false so the caller can skip writing runtime-config.json.
 */
function _resolveFromCfn(props: FrontendStackProps): ResolvedConfig {
  const { spawnSync } = require('child_process');

  function getCfnOutputs(stackName: string): Record<string, string> {
    const r = spawnSync(
      'aws',
      ['cloudformation', 'describe-stacks', '--stack-name', stackName,
       '--query', 'Stacks[0].Outputs', '--output', 'json'],
      { encoding: 'utf8', stdio: 'pipe' },
    );
    if (r.status !== 0 || !r.stdout?.trim()) return {};
    try {
      const out: Array<{ OutputKey: string; OutputValue: string }> = JSON.parse(r.stdout);
      return Object.fromEntries((out ?? []).map(o => [o.OutputKey, o.OutputValue]));
    } catch { return {}; }
  }

  const auth = getCfnOutputs('KostOpsAuthStack');
  const api  = getCfnOutputs('KostOpsApiStack');

  const userPoolId       = auth['UserPoolId']       ?? '';
  const userPoolClientId = auth['UserPoolClientId'] ?? '';
  const apiUrl           = api['ApiUrl']             ?? '';

  const hasRealValues = !!(
    userPoolId && userPoolId.includes('_') &&
    userPoolClientId &&
    apiUrl && apiUrl.startsWith('https://')
  );

  if (hasRealValues) {
    console.log(`[KostOps] Resolved config — UserPoolId: ${userPoolId} | ApiUrl: ${apiUrl}`);
  } else {
    console.warn(
      '\n[KostOps] WARNING: Could not resolve Cognito/API values from CloudFormation.\n' +
      '  Deploy in order:\n' +
      '    cdk deploy KostOpsAuthStack KostOpsDataStack KostOpsAgentStack KostOpsApiStack\n' +
      '    cdk deploy KostOpsFrontendStack\n' +
      '  Ensure AWS_PROFILE / AWS_DEFAULT_REGION match your deployment account.\n',
    );
  }

  return { userPoolId, userPoolClientId, apiUrl, hasRealValues };
}
