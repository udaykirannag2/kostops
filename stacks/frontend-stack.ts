import * as cdk        from 'aws-cdk-lib';
import * as s3         from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins    from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy   from 'aws-cdk-lib/aws-s3-deployment';
import { Construct }   from 'constructs';

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
 *   S3 bucket (private)       — stores the built React app (npm run build)
 *   CloudFront distribution   — serves the app over HTTPS globally
 *   Origin Access Control     — CloudFront reads S3; bucket is never public
 *   BucketDeployment          — copies frontend/dist/ to S3 on every cdk deploy
 *
 * The CDK output `SiteUrl` is the URL engineers open in their browser.
 */
export class FrontendStack extends cdk.Stack {
  public readonly siteUrl: string;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    // ── S3 bucket — private, no static website hosting ────────────────────────
    // CloudFront serves the content directly from S3 via OAC.
    // Static website hosting is not needed (and would make the bucket public).
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName:        `kostops-frontend-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption:        s3.BucketEncryption.S3_MANAGED,
      enforceSSL:        true,
      removalPolicy:     cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ── Origin Access Control ─────────────────────────────────────────────────
    // OAC is the modern replacement for OAI — more secure, supports SSE-KMS
    const oac = new cloudfront.S3OriginAccessControl(this, 'SiteOAC', {
      description: 'KostOps frontend OAC',
    });

    // ── CloudFront distribution ───────────────────────────────────────────────
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
      // SPA routing: all paths → index.html (React Router handles the rest)
      errorResponses: [
        {
          httpStatus:         403,
          responseHttpStatus: 200,
          responsePagePath:   '/index.html',
          ttl:                cdk.Duration.seconds(0),
        },
        {
          httpStatus:         404,
          responseHttpStatus: 200,
          responsePagePath:   '/index.html',
          ttl:                cdk.Duration.seconds(0),
        },
      ],
      defaultRootObject: 'index.html',
      httpVersion:       cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
    });

    // ── Deploy React build to S3 ──────────────────────────────────────────────
    // Copies frontend/dist/ to the S3 bucket and invalidates CloudFront cache.
    // Run `cd frontend && npm run build` before `cdk deploy`.
    new s3deploy.BucketDeployment(this, 'SiteDeployment', {
      sources: [s3deploy.Source.asset('./frontend/dist')],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],  // Invalidate all cached files on deploy
      memoryLimit: 256,
    });

    this.siteUrl = `https://${distribution.distributionDomainName}`;

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'SiteUrl', {
      value:       this.siteUrl,
      description: 'KostOps UI — open this in your browser',
    });
    new cdk.CfnOutput(this, 'DistributionId', {
      value:       distribution.distributionId,
      description: 'CloudFront distribution ID (for manual cache invalidation)',
    });
  }
}
