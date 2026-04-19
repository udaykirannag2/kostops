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
      // Don't prune the bucket on each deploy — runtime-config.json is written
      // by a separate AwsCustomResource (RuntimeConfigDeployment) and would be
      // wiped by the pruning step. Vite emits hash-named assets so stale files
      // accumulating is not a correctness issue; CloudFront caches on hash.
      prune: false,
    });

    // ── Write runtime-config.json ─────────────────────────────────────────────
    // Uses REAL string values (not CDK tokens) to avoid CFN cross-stack
    // Fn::ImportValue dependencies that break when upstream stacks redeploy.
    //
    // First deploy (hasRealValues=false): backend stacks don't exist yet at
    // synthesis time so we can't write the config.  A second `cdk deploy --all`
    // will find the real values and write it.  A CfnOutput tells the customer.
    //
    // All subsequent deploys (hasRealValues=true): config is always refreshed.
    if (resolved.hasRealValues) {
      new cr.AwsCustomResource(this, 'RuntimeConfigDeployment', {
        resourceType: 'Custom::RuntimeConfig',
        onUpdate: {
          service:   'S3',
          action:    'putObject',
          parameters: {
            Bucket:       siteBucket.bucketName,
            Key:          'runtime-config.json',
            ContentType:  'application/json',
            CacheControl: 'no-store, no-cache, must-revalidate',
            Body: JSON.stringify({
              userPoolId:       resolved.userPoolId,
              userPoolClientId: resolved.userPoolClientId,
              apiUrl:           resolved.apiUrl,
            }),
          },
          // physicalResourceId includes the poolId so it updates whenever config changes
          physicalResourceId: cr.PhysicalResourceId.of(`runtime-config-${resolved.userPoolId}`),
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
    }

    this.siteUrl = `https://${distribution.distributionDomainName}`;

    new cdk.CfnOutput(this, 'SiteUrl', {
      value:       resolved.hasRealValues ? this.siteUrl : '(not ready yet — see NextStep below)',
      description: 'KostOps UI — open this in your browser',
    });
    new cdk.CfnOutput(this, 'DistributionId', {
      value:       distribution.distributionId,
      description: 'CloudFront distribution ID',
    });

    // On first deploy, backend stacks don't exist yet at synthesis time so
    // runtime-config.json can't be written.  Show a clear next-step output.
    if (!resolved.hasRealValues) {
      new cdk.CfnOutput(this, 'NextStep', {
        value:       'Run `npx cdk deploy --all` one more time to finalize frontend config',
        description: 'Step 1 of 2 complete — run cdk deploy --all again to finish setup',
      });
    }
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
    // Step 2 of 2 (or any incremental deploy)
    console.log('\n[KostOps] ✅  Step 2 of 2 — writing frontend runtime config');
    console.log(`[KostOps]    UserPoolId : ${userPoolId}`);
    console.log(`[KostOps]    ApiUrl     : ${apiUrl}\n`);
  } else {
    // Step 1 of 2 — backend stacks not yet deployed
    console.log('\n[KostOps] ──────────────────────────────────────────────────────');
    console.log('[KostOps]  INITIAL SETUP — Step 1 of 2');
    console.log('[KostOps]  All infrastructure will be created now.');
    console.log('[KostOps]  When this deploy finishes, run:');
    console.log('[KostOps]');
    console.log('[KostOps]    npx cdk deploy --all');
    console.log('[KostOps]');
    console.log('[KostOps]  That second run writes the frontend config and');
    console.log('[KostOps]  the site URL will be ready to open.');
    console.log('[KostOps] ──────────────────────────────────────────────────────\n');
  }

  return { userPoolId, userPoolClientId, apiUrl, hasRealValues };
}
