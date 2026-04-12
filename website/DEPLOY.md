# KostOps Website — Deployment Guide

Static site. No build step. Deploy directly to S3.

---

## Step 1 — Set up EmailJS (contact form)

1. Create a free account at **emailjs.com** (200 emails/month free)
2. Add a service: **Email Services → Add New Service → Gmail** (connect your Gmail)
3. Create a template: **Email Templates → Create New Template**
   - Set **To Email**: `udaykirannag@gmail.com`
   - Use these variables in the template body:
     ```
     From: {{name}} ({{company}})
     Reply-to: {{email}}
     AWS accounts: {{aws_accounts}}

     {{message}}
     ```
4. Note your three IDs: **Public Key** (Account > API Keys), **Service ID**, **Template ID**
5. Edit `index.html` — find the three placeholder lines near the bottom and replace:
   ```js
   const EMAILJS_PUBLIC_KEY  = 'YOUR_PUBLIC_KEY';   // ← replace
   const EMAILJS_SERVICE_ID  = 'YOUR_SERVICE_ID';   // ← replace
   const EMAILJS_TEMPLATE_ID = 'YOUR_TEMPLATE_ID';  // ← replace
   ```

> **Without EmailJS configured:** the form falls back to `mailto:` which opens the user's email client. Still works, just less seamless.

---

## Step 2 — Update the GitHub link

In `index.html`, find:
```html
href="https://github.com/udaykirannag2/kostops"
```
Update to your actual repo URL if different.

---

## Step 3 — Create the S3 bucket (payer account)

```bash
# Set your bucket name and region
BUCKET=kostops-website
REGION=us-east-1

# Create bucket
aws s3 mb s3://$BUCKET --region $REGION

# Disable Block Public Access (required for static website hosting)
aws s3api put-public-access-block \
  --bucket $BUCKET \
  --public-access-block-configuration \
    "BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false"

# Set public read bucket policy
aws s3api put-bucket-policy --bucket $BUCKET --policy '{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::'"$BUCKET"'/*"
  }]
}'

# Enable static website hosting
aws s3 website s3://$BUCKET \
  --index-document index.html \
  --error-document index.html
```

---

## Step 4 — Deploy

```bash
# From the repo root
aws s3 sync website/ s3://$BUCKET/ --delete

# Your site is live at:
echo "http://$BUCKET.s3-website-$REGION.amazonaws.com"
```

---

## Step 5 — (Optional) Add CloudFront for HTTPS

S3 static website hosting only serves HTTP. For HTTPS + custom domain:

```bash
# Create CloudFront distribution pointing to the S3 website endpoint
# (use S3 website endpoint, NOT S3 REST endpoint, for SPA routing to work)
aws cloudfront create-distribution --distribution-config '{
  "CallerReference": "kostops-website-'$(date +%s)'",
  "Origins": {
    "Quantity": 1,
    "Items": [{
      "Id": "S3-Website",
      "DomainName": "'"$BUCKET"'.s3-website-'"$REGION"'.amazonaws.com",
      "CustomOriginConfig": {
        "HTTPPort": 80,
        "HTTPSPort": 443,
        "OriginProtocolPolicy": "http-only"
      }
    }]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "S3-Website",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] },
    "CachedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] },
    "ForwardedValues": {
      "QueryString": false,
      "Cookies": { "Forward": "none" }
    },
    "MinTTL": 0,
    "DefaultTTL": 86400,
    "MaxTTL": 31536000
  },
  "CustomErrorResponses": {
    "Quantity": 1,
    "Items": [{
      "ErrorCode": 404,
      "ResponsePagePath": "/index.html",
      "ResponseCode": "200",
      "ErrorCachingMinTTL": 300
    }]
  },
  "Comment": "KostOps website",
  "Enabled": true
}'
```

For a custom domain (e.g. `kostops.yourdomain.com`), add an ACM certificate and `Aliases` to the distribution config.

---

## Updating the site

```bash
# Edit index.html, then redeploy
aws s3 sync website/ s3://$BUCKET/ --delete

# If using CloudFront, invalidate the cache
aws cloudfront create-invalidation \
  --distribution-id YOUR_CF_DIST_ID \
  --paths "/*"
```

---

## Cost estimate

| Resource | Monthly cost |
|---|---|
| S3 (< 1 MB site, low traffic) | < $0.01 |
| S3 requests (10k GET/month) | ~$0.004 |
| CloudFront (optional, 1 GB transfer) | ~$0.085 |
| **Total** | **< $0.10/month** |
